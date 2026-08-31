/**
 * Mid-run user_steer delivery for an active work burst.
 *
 * Platform FE sends user_steer while conversation is running; Node must inject
 * into the live Agent (steer/followUp) instead of rejecting as "still working".
 *
 * Race: busy is set before the Free/Graph session registers. Pending steers
 * and case_scope_updated (busy-only) queue until registerActiveSession flushes them.
 * Do not queue Scope while idle — that snapshot can overwrite a later dispatch.
 */

export type ActiveSessionHandle = {
  conversationId: string;
  taskId: string;
  /** Prefer mid-run padding after current tool batch (pi Agent.steer). */
  steer: (text: string) => void;
  /** Fallback: inject after agent would stop (pi Agent.followUp). */
  followUp: (text: string) => void;
  /** HTTP Surface 纳入 / live Scope push — mutate the burst TaskEnvelope. */
  applyScope?: (scope: unknown) => void;
};

const byConversation = new Map<string, ActiveSessionHandle>();
/** Steers that arrived while busy but before any session registered. */
const pendingByConversation = new Map<string, string[]>();
/** Last case_scope_updated during busy-before-register. Not queued while idle. */
const pendingScopeByConversation = new Map<string, unknown>();

function injectIntoHandle(
  handle: ActiveSessionHandle,
  text: string,
): "steer" | "followUp" | null {
  try {
    handle.steer(text);
    return "steer";
  } catch {
    try {
      handle.followUp(text);
      return "followUp";
    } catch {
      return null;
    }
  }
}

function flushPending(conversationId: string, handle: ActiveSessionHandle): void {
  const pending = pendingByConversation.get(conversationId);
  if (!pending?.length) return;
  pendingByConversation.delete(conversationId);
  for (const text of pending) {
    if (injectIntoHandle(handle, text) == null) {
      console.warn(
        `[active-session] failed to flush pending steer for ${conversationId}`,
      );
    }
  }
}

function flushPendingScope(conversationId: string, handle: ActiveSessionHandle): void {
  if (!pendingScopeByConversation.has(conversationId)) return;
  const pending = pendingScopeByConversation.get(conversationId);
  pendingScopeByConversation.delete(conversationId);
  if (handle.applyScope) handle.applyScope(pending);
}

export function registerActiveSession(handle: ActiveSessionHandle): () => void {
  const id = String(handle.conversationId || "").trim();
  if (!id) return () => {};
  byConversation.set(id, handle);
  flushPending(id, handle);
  flushPendingScope(id, handle);
  return () => {
    const cur = byConversation.get(id);
    if (cur === handle) byConversation.delete(id);
  };
}

export function getActiveSession(conversationId: string): ActiveSessionHandle | undefined {
  return byConversation.get(String(conversationId || "").trim());
}

/** Apply Case Scope onto the live burst envelope (HTTP Surface 纳入). */
export function applyScopeToLiveSession(conversationId: string, scope: unknown): boolean {
  const id = String(conversationId || "").trim();
  if (!id) return false;
  const handle = getActiveSession(id);
  if (!handle?.applyScope) return false;
  handle.applyScope(scope);
  pendingScopeByConversation.delete(id);
  return true;
}

/**
 * Queue Scope until a session registers (busy race), or apply now if live.
 * Caller must only enqueue while the conversation is busy. Idle 纳入 is
 * parked via applyScopeToParkedRuntimes; do not survive into the next dispatch.
 */
export function enqueuePendingScope(conversationId: string, scope: unknown): void {
  const id = String(conversationId || "").trim();
  if (!id) return;
  const handle = byConversation.get(id);
  if (handle?.applyScope) {
    handle.applyScope(scope);
    pendingScopeByConversation.delete(id);
    return;
  }
  pendingScopeByConversation.set(id, scope);
}

/**
 * Queue mid-run text until a session registers (busy race), or inject now if live.
 * registerActiveSession drains the queue via steer/followUp.
 */
export function enqueuePendingSteer(conversationId: string, text: string): void {
  const id = String(conversationId || "").trim();
  const trimmed = String(text || "").trim();
  if (!id || !trimmed) return;
  const handle = byConversation.get(id);
  if (handle) {
    if (injectIntoHandle(handle, trimmed) == null) {
      console.warn(
        `[active-session] inject failed for ${id}; dropping steer`,
      );
    }
    return;
  }
  const q = pendingByConversation.get(id) || [];
  q.push(trimmed);
  pendingByConversation.set(id, q);
}

/** Drop queued steers (e.g. work burst ended without a live session). */
export function clearPendingSteers(conversationId: string): void {
  pendingByConversation.delete(String(conversationId || "").trim());
}

/** Drop queued Scope so a later dispatch is not overwritten by an idle snapshot. */
export function clearPendingScope(conversationId: string): void {
  pendingScopeByConversation.delete(String(conversationId || "").trim());
}

/**
 * Deliver mid-run user text. Returns true if injected into a live session.
 * Prefer steer (next turn boundary after tools); fall back to followUp.
 * Does not enqueue — caller may use enqueuePendingSteer on no_session.
 */
export function deliverUserSteerToActiveSession(
  conversationId: string,
  text: string,
): { ok: true; mode: "steer" | "followUp" } | { ok: false; reason: "no_session" | "empty" } {
  const trimmed = String(text || "").trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  const handle = getActiveSession(conversationId);
  if (!handle) return { ok: false, reason: "no_session" };
  const mode = injectIntoHandle(handle, trimmed);
  if (mode) return { ok: true, mode };
  return { ok: false, reason: "no_session" };
}

/** Test helper. */
export function clearActiveSessionsForTests(): void {
  byConversation.clear();
  pendingByConversation.clear();
  pendingScopeByConversation.clear();
}
