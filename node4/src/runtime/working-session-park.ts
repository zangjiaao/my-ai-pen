/**
 * Spec #283 (I0.9): Working session continue after interrupt.
 *
 * Park the captain working runtime on user interrupt (do not dispose).
 * Continue (same Participant Session + work mode) attaches the next user
 * message as the next turn on that parked runtime.
 *
 * #282 = mode continuity (Graph not Free). I0.9 = working-runtime continuity.
 * Park is memory-only within the live Node process (v1). Process death / TTL
 * miss → honest mode-correct reseed (never silent Free demotion when Graph).
 *
 * End policy (shared by Free finally, Graph stage finally, parked-continue):
 * - interrupt/abort → park
 * - product-terminal complete → dispose
 * - incomplete mid-work (incl. natural end of a parked-continue turn) → re-park
 */

import type { Node4AgentSession } from "./run-node4-agent.js";
import type { TodoStore } from "../stores/todo.js";
import type { ToolRuntime } from "../types.js";

/** Default idle park TTL (30 minutes). Documented product choice for v1. */
export const DEFAULT_PARK_TTL_MS = 30 * 60 * 1000;

export type WorkingWorkMode = "free" | "graph";

export type ParkedWorkingRuntime = {
  conversationId: string;
  expertId: string;
  workMode: WorkingWorkMode;
  graphId?: string;
  stageId?: string;
  /** Last task_id (accounting only; product identity is Session). */
  taskId: string;
  session: Node4AgentSession;
  todo: TodoStore;
  /** Structured credentials / accounts when present at park time. */
  accounts?: unknown;
  /** Live ToolRuntime (Free parent or Graph stage child) — rebind platform/task on attach. */
  runtime?: ToolRuntime;
  parkedAt: number;
  /** Tear down when park is dropped (TTL / mode mismatch / terminal). */
  dispose: () => void | Promise<void>;
};

export type CaptainEndDisposition =
  | { disposition: "park"; reason: "interrupted" | "incomplete" }
  | { disposition: "dispose"; reason: "product_terminal" | "expert_transfer" | "settled" };

const parks = new Map<string, ParkedWorkingRuntime>();

/** Participant Session key: conversation_id + expert_id (fallback conversation alone). */
export function parkSessionKey(
  conversationId: string,
  expertId?: string | null,
): string {
  const c = String(conversationId || "").trim();
  const e = String(expertId || "").trim();
  if (!c) return "";
  return e ? `${c}::${e}` : c;
}

export function isParkExpired(
  entry: { parkedAt: number },
  now: number,
  ttlMs: number = DEFAULT_PARK_TTL_MS,
): boolean {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false;
  return now - entry.parkedAt > ttlMs;
}

/**
 * Unified captain end disposition — one policy for Free finally, Graph stage finally,
 * and parked-continue finally (Issue 4: avoid dual end policies).
 *
 * - aborted → park (interrupt)
 * - productTerminal → dispose (true Session/engagement terminal only)
 * - otherwise incomplete mid-work → park (multi-turn continuity after continue)
 */
export function decideCaptainEndDisposition(input: {
  aborted: boolean;
  /**
   * True only when product harness status is terminal **completed**
   * (not incomplete). Never set merely because one session.prompt returned.
   */
  productTerminal?: boolean;
  /** Explicit Expert transfer ends Session park chain. */
  expertTransfer?: boolean;
}): CaptainEndDisposition {
  if (input.expertTransfer) {
    return { disposition: "dispose", reason: "expert_transfer" };
  }
  if (input.aborted) {
    return { disposition: "park", reason: "interrupted" };
  }
  if (input.productTerminal) {
    return { disposition: "dispose", reason: "product_terminal" };
  }
  return { disposition: "park", reason: "incomplete" };
}

/**
 * Interrupt-site helper: abort → park; successful stage/burst settle → dispose.
 * Prefer `decideCaptainEndDisposition` for parked-continue (productTerminal from harness).
 */
export function decideParkOnEnd(input: {
  aborted: boolean;
  expertTransfer?: boolean;
}): CaptainEndDisposition {
  return decideCaptainEndDisposition({
    aborted: input.aborted,
    // Non-abort end of Free/Graph harness burst is product settle of that burst.
    productTerminal: !input.aborted,
    expertTransfer: input.expertTransfer,
  });
}

/**
 * Pure: whether continue should attach a parked runtime or reseed.
 * C1 free-in-envelope must not consume a Graph park as if incomplete resume.
 */
export function decideAttachOnContinue(input: {
  hasPark: boolean;
  parkExpired: boolean;
  parkWorkMode?: WorkingWorkMode;
  /** Session work mode for this continue (structured envelope / path). */
  sessionWorkMode: WorkingWorkMode;
  /** Post-complete C1 free-in-envelope — never attach Graph park as resume. */
  continueInEnvelope?: boolean;
}):
  | { action: "attach" }
  | {
      action: "reseed";
      reason: "miss" | "ttl_expired" | "mode_mismatch" | "c1_continue";
    } {
  if (input.continueInEnvelope) {
    return { action: "reseed", reason: "c1_continue" };
  }
  if (!input.hasPark) {
    return { action: "reseed", reason: "miss" };
  }
  if (input.parkExpired) {
    return { action: "reseed", reason: "ttl_expired" };
  }
  if (
    input.parkWorkMode &&
    input.parkWorkMode !== input.sessionWorkMode
  ) {
    return { action: "reseed", reason: "mode_mismatch" };
  }
  return { action: "attach" };
}

/** Park a captain working runtime (replaces any prior park for the same Session key). */
export function parkWorkingSession(entry: ParkedWorkingRuntime): string {
  const key = parkSessionKey(entry.conversationId, entry.expertId);
  if (!key) return "";
  const prev = parks.get(key);
  if (prev && prev !== entry) {
    void Promise.resolve(prev.dispose()).catch(() => {});
  }
  parks.set(key, { ...entry, parkedAt: entry.parkedAt || Date.now() });
  return key;
}

/**
 * Apply shared end disposition: park or dispose the captain handle.
 * Used by Free finally, Graph stage finally, and parked-continue finally.
 */
export function applyCaptainEndDisposition(options: {
  decision: CaptainEndDisposition;
  entry: Omit<ParkedWorkingRuntime, "parkedAt"> & { parkedAt?: number };
}): { parked: boolean; disposed: boolean } {
  if (options.decision.disposition === "park") {
    parkWorkingSession({
      ...options.entry,
      parkedAt: options.entry.parkedAt ?? Date.now(),
    });
    return { parked: true, disposed: false };
  }
  try {
    void Promise.resolve(options.entry.dispose());
  } catch {
    /* ignore */
  }
  return { parked: false, disposed: true };
}

export function peekParkedSession(
  conversationId: string,
  expertId?: string | null,
): ParkedWorkingRuntime | undefined {
  const key = parkSessionKey(conversationId, expertId);
  if (!key) return undefined;
  return parks.get(key);
}

/**
 * Take parked runtime for attach (removes from park map).
 * Caller owns dispose / re-park. Expired entries are disposed and treated as miss.
 */
export function takeParkedSession(
  conversationId: string,
  expertId?: string | null,
  options?: { now?: number; ttlMs?: number },
):
  | { ok: true; entry: ParkedWorkingRuntime }
  | { ok: false; reason: "miss" | "ttl_expired" } {
  const key = parkSessionKey(conversationId, expertId);
  if (!key) return { ok: false, reason: "miss" };
  const entry = parks.get(key);
  if (!entry) return { ok: false, reason: "miss" };
  const now = options?.now ?? Date.now();
  const ttlMs = options?.ttlMs ?? DEFAULT_PARK_TTL_MS;
  if (isParkExpired(entry, now, ttlMs)) {
    parks.delete(key);
    void Promise.resolve(entry.dispose()).catch(() => {});
    return { ok: false, reason: "ttl_expired" };
  }
  parks.delete(key);
  return { ok: true, entry };
}

/** Drop park without attach (mode mismatch cleanup, C1, tests). */
export async function dropParkedSession(
  conversationId: string,
  expertId?: string | null,
): Promise<boolean> {
  const key = parkSessionKey(conversationId, expertId);
  if (!key) return false;
  const entry = parks.get(key);
  if (!entry) return false;
  parks.delete(key);
  try {
    await Promise.resolve(entry.dispose());
  } catch {
    /* ignore */
  }
  return true;
}

/**
 * Resolve attach vs reseed for a continue turn, consuming park on attach.
 * On reseed after mode_mismatch/ttl/c1, park is dropped (Free and Graph).
 */
export function resolveWorkingSessionContinue(input: {
  conversationId: string;
  expertId?: string | null;
  sessionWorkMode: WorkingWorkMode;
  continueInEnvelope?: boolean;
  now?: number;
  ttlMs?: number;
}):
  | { action: "attach"; entry: ParkedWorkingRuntime }
  | {
      action: "reseed";
      reason: "miss" | "ttl_expired" | "mode_mismatch" | "c1_continue";
    } {
  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? DEFAULT_PARK_TTL_MS;
  const peeked = peekParkedSession(input.conversationId, input.expertId);
  const decision = decideAttachOnContinue({
    hasPark: Boolean(peeked),
    parkExpired: peeked ? isParkExpired(peeked, now, ttlMs) : false,
    parkWorkMode: peeked?.workMode,
    sessionWorkMode: input.sessionWorkMode,
    continueInEnvelope: input.continueInEnvelope,
  });
  if (decision.action === "reseed") {
    if (
      peeked &&
      (decision.reason === "ttl_expired" ||
        decision.reason === "mode_mismatch" ||
        decision.reason === "c1_continue")
    ) {
      // Drop any leftover park on C1 / TTL / mismatch (predictable; no surprise Free attach after C1).
      void dropParkedSession(input.conversationId, input.expertId);
    }
    return decision;
  }
  const taken = takeParkedSession(input.conversationId, input.expertId, {
    now,
    ttlMs,
  });
  if (!taken.ok) {
    return { action: "reseed", reason: taken.reason };
  }
  return { action: "attach", entry: taken.entry };
}

/** History observable: session still has prior messages after park. */
export function parkedSessionHasHistory(entry: ParkedWorkingRuntime): boolean {
  const msgs = entry.session?.messages;
  return Array.isArray(msgs) && msgs.length > 0;
}

/** Todo observable: not wiped solely by park/continue. */
export function parkedTodoNonEmpty(entry: ParkedWorkingRuntime): boolean {
  try {
    return entry.todo.snapshot().some((p) => p.tasks.length > 0);
  } catch {
    return false;
  }
}

/**
 * Harness status for a parked-continue turn.
 * Graph never product-completes from the mini-runner alone (stage/run gates live in Hard Graph).
 * Free completes only when no open todos remain (mid-work Free stays incomplete → re-park).
 */
export function harnessStatusAfterParkedContinue(input: {
  aborted: boolean;
  workMode: WorkingWorkMode;
  openTodoCount: number;
}): "completed" | "incomplete" {
  if (input.aborted) return "incomplete";
  if (input.workMode === "graph") return "incomplete";
  if (input.openTodoCount > 0) return "incomplete";
  return "completed";
}

export function clearWorkingSessionParksForTests(): void {
  for (const entry of parks.values()) {
    void Promise.resolve(entry.dispose()).catch(() => {});
  }
  parks.clear();
}

export function countParkedSessionsForTests(): number {
  return parks.size;
}
