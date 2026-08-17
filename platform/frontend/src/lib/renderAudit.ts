/**
 * DEV render audit — catch keystrokes that re-render chrome which does not
 * depend on the field. Filter boxes may re-render their owner page; composer
 * must not re-render the Case stream.
 *
 * Production (`vite build`): `import.meta.env.DEV` is false and Vite DCE
 * drops the hook body. React entry points (`commitTypedInput`,
 * `handleTypedInput`, `useRenderAudit`, `resetRenderAudit`) become plain
 * setState — no flushSync, no window hook, no console, no badge.
 * Unit tests call `recordRender` / `beginTypedInput` / `finishTypedInput` directly.
 */
import { flushSync } from "react-dom";

const AUDIT = typeof import.meta.env !== "undefined" && import.meta.env.DEV === true;

export type RenderName = string;
export type RenderSnapshot = Record<string, number>;

export type RenderAuditFlag = {
  at: number;
  reason: "typed-input";
  owner: string;
  delta: RenderSnapshot;
};

const counts: Record<string, number> = {};
const flags: RenderAuditFlag[] = [];
const EMPTY_FLAGS: readonly RenderAuditFlag[] = [];
let publishedFlags: readonly RenderAuditFlag[] = EMPTY_FLAGS;
const listeners = new Set<() => void>();
let inputPending = false;
let inputOwner = "";
let allowed = new Set<string>();
let baseline: RenderSnapshot = {};

function emit(): void {
  publishedFlags = flags.length ? flags.slice() : EMPTY_FLAGS;
  for (const listener of listeners) listener();
}

function bindWindow(): void {
  if (typeof window === "undefined") return;
  const w = window as Window & { __RENDER_AUDIT__?: RenderAuditHost };
  w.__RENDER_AUDIT__ = {
    report,
    reset: resetRenderAudit,
    snapshot,
  };
}

export type RenderAuditHost = {
  report: () => { counts: RenderSnapshot; flags: RenderAuditFlag[] };
  reset: () => void;
  snapshot: () => RenderSnapshot;
};

export function subscribeRenderAudit(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function recordRender(name: RenderName): void {
  counts[name] = (counts[name] || 0) + 1;
  bindWindow();
}

export function snapshot(): RenderSnapshot {
  return { ...counts };
}

export function beginTypedInput(owner: string, opts?: { allow?: string[] }): void {
  inputPending = true;
  inputOwner = owner;
  allowed = new Set([owner, ...(opts?.allow || [])]);
  baseline = snapshot();
}

export function finishTypedInput(): RenderAuditFlag | null {
  if (!inputPending) return null;
  inputPending = false;
  const owner = inputOwner;
  const ignore = allowed;
  inputOwner = "";
  allowed = new Set();
  const next = snapshot();
  const delta: RenderSnapshot = {};
  const names = new Set([...Object.keys(baseline), ...Object.keys(next)]);
  for (const name of names) {
    if (ignore.has(name)) continue;
    const d = (next[name] || 0) - (baseline[name] || 0);
    if (d > 0) delta[name] = d;
  }
  if (!Object.keys(delta).length) return null;
  const flag: RenderAuditFlag = { at: Date.now(), reason: "typed-input", owner, delta };
  flags.push(flag);
  emit();
  if (typeof console !== "undefined") {
    console.warn("[render-audit] typed input leaked renders", { owner, delta });
  }
  return flag;
}

/** Apply the keystroke and measure in the same React turn (no WS / timer bleed). */
export function commitTypedInput(
  owner: string,
  apply: () => void,
  opts?: { allow?: string[] },
): RenderAuditFlag | null {
  if (!AUDIT) {
    apply();
    return null;
  }
  beginTypedInput(owner, opts);
  flushSync(apply);
  return finishTypedInput();
}

export function getRenderAuditFlags(): readonly RenderAuditFlag[] {
  return publishedFlags;
}

export function report(): { counts: RenderSnapshot; flags: RenderAuditFlag[] } {
  return { counts: snapshot(), flags: flags.slice() };
}

export function resetRenderAudit(): void {
  for (const key of Object.keys(counts)) delete counts[key];
  flags.length = 0;
  inputPending = false;
  inputOwner = "";
  allowed = new Set();
  baseline = {};
  emit();
}

export function handleTypedInput(
  owner: string,
  setValue: (next: string) => void,
  opts?: { allow?: string[] },
): (event: { target: { value: string } }) => void {
  if (!AUDIT) {
    return (event) => setValue(event.target.value);
  }
  return (event) => {
    const next = event.target.value;
    commitTypedInput(owner, () => setValue(next), opts);
  };
}

/** Call on every render of a watched component. No-op in production builds. */
export function useRenderAudit(name: RenderName): void {
  if (AUDIT) {
    recordRender(name);
  }
}
