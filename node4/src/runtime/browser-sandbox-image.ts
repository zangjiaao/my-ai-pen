/**
 * Browser sandbox image resolution + Participant Session seat identity (Spec #426 / #427).
 * Key is (conversationId, expertId) — not parent platform task id.
 */
import { createHash } from "node:crypto";

/**
 * Sticky + ephemeral pen-sandbox process env: HOME must stay on the container
 * rootfs (not /workspace bind). WSL/9p and some remote mounts cannot host
 * AF_UNIX sockets under $HOME/.agent-browser/*.sock.
 */
export const PEN_SANDBOX_HOME_ENV = [
  "HOME=/root",
  "PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright",
] as const;

/** Shared explicit env pins for pen-sandbox family (browser + shell). */
export function readExplicitSandboxImageEnv(opts?: {
  /** Browser path: NODE4_BROWSER override wins. Shell path: unified pin first. */
  preferBrowserOverride?: boolean;
}): string {
  const browser =
    process.env.NODE4_BROWSER_SANDBOX_IMAGE?.trim() ||
    process.env.NODE2_BROWSER_SANDBOX_IMAGE?.trim() ||
    "";
  const unified =
    process.env.PEN_SANDBOX_IMAGE?.trim() || process.env.PEN_TOOLS_IMAGE?.trim() || "";
  if (opts?.preferBrowserOverride) {
    return browser || unified || "";
  }
  return unified || browser || "";
}

/** Thrown when browser sandbox image env is missing (fail closed; no Strix). */
export class BrowserSandboxImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserSandboxImageError";
  }
}

/** Thrown when seat identity is incomplete (fail closed; no Case-level fallback). */
export class BrowserSandboxSeatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserSandboxSeatError";
  }
}

/**
 * Explicit-env-only browser sandbox image (Spec #330).
 * Order: browser override → unified pen-sandbox → shell-family pin (still explicit).
 */
export function resolveBrowserSandboxImage(): string {
  const image = readExplicitSandboxImageEnv({ preferBrowserOverride: true });
  if (!image) {
    throw new BrowserSandboxImageError(
      "Browser sandbox image not configured. Set PEN_SANDBOX_IMAGE (or NODE4_BROWSER_SANDBOX_IMAGE) " +
        "to a first-party pen-sandbox pin and docker pull it. " +
        "Silent third-party Strix fallback is not used. " +
        "Build: bash sandbox/pen-sandbox/scripts/build.sh",
    );
  }
  return image;
}

export function isBrowserSandboxPreferred(): boolean {
  const raw = (process.env.NODE4_BROWSER_SANDBOX ?? "1").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "host");
}

/** Participant Session seat for sticky pen-sandbox (Spec #419 / #427). */
export type BrowserSandboxSeat = {
  conversationId: string;
  expertId: string;
  /** Canonical registry / lock key: `conversationId::expertId`. */
  seatKey: string;
};

export function formatBrowserSandboxSeatKey(conversationId: string, expertId: string): string {
  return `${String(conversationId || "").trim()}::${String(expertId || "").trim()}`;
}

/**
 * Resolve sticky-sandbox seat from task envelope.
 * Fail-closed without conversationId or expertId (no Case-only fallback).
 */
export function resolveBrowserSandboxSeat(
  task:
    | {
        conversationId?: string;
        expertId?: string;
        taskId?: string;
        parentTaskId?: string;
      }
    | null
    | undefined,
): BrowserSandboxSeat {
  const conversationId = String(task?.conversationId || "").trim();
  const expertId = String(task?.expertId || "").trim();
  if (!conversationId) {
    throw new BrowserSandboxSeatError(
      "Browser sandbox requires conversationId (Case id). Cannot attach sticky pen-sandbox.",
    );
  }
  if (!expertId) {
    throw new BrowserSandboxSeatError(
      "Browser sandbox requires expertId (Participant Session seat). " +
        "Missing expert fails closed — no Case-level shared box.",
    );
  }
  return {
    conversationId,
    expertId,
    seatKey: formatBrowserSandboxSeatKey(conversationId, expertId),
  };
}

/** Stable short slug for Docker names / AGENT_BROWSER_SESSION (full ids live in labels). */
export function seatKeySlug(seatKey: string): string {
  return createHash("sha256").update(String(seatKey || "")).digest("hex").slice(0, 16);
}

export function containerNameForSeat(seatKey: string): string {
  return `node4-browser-${seatKeySlug(seatKey)}`;
}

/** @deprecated Use containerNameForSeat — kept as alias for seat-keyed names. */
export function containerNameForParentTask(seatKey: string): string {
  return containerNameForSeat(seatKey);
}

/** Shared agent-browser session name for a seat (cookies/storage). */
export function agentBrowserSessionName(seatKey: string): string {
  return `node4-${seatKeySlug(seatKey)}`;
}

/**
 * @deprecated Spec #427 — sticky key is Participant Session, not parent task.
 * Prefer resolveBrowserSandboxSeat. Kept only for transitional call sites.
 */
export function resolveBrowserSandboxParentTaskId(
  task: {
    taskId?: string;
    parentTaskId?: string;
    conversationId?: string;
    expertId?: string;
  } | null | undefined,
): string {
  try {
    return resolveBrowserSandboxSeat(task).seatKey;
  } catch {
    const explicit = String(task?.parentTaskId || "").trim();
    if (explicit) return explicit;
    const tid = String(task?.taskId || "").trim();
    const idx = tid.indexOf("/sub/");
    if (idx > 0) return tid.slice(0, idx);
    return tid;
  }
}
