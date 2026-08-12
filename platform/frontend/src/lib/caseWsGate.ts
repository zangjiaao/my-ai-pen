/**
 * Case-scoped WebSocket handler gate (single entry).
 *
 * Blank home / optimistic Case delete must not absorb Case plan_tree, panel,
 * checkpoint, or chat frames for a disposed conversation. Gate once when
 * registering handlers — do not copy `if (!isActive…)` into every branch.
 */

export type CaseWsHandler = (msg: Record<string, unknown>) => void;

/**
 * Fail-closed: no open Case → drop Case-scoped frames.
 * Open Case + matching conversation_id → allow.
 * Open Case + missing conversation_id (legacy) → allow (caller Case is SoT).
 */
export function isActiveCaseMessage(
  msg: Record<string, unknown>,
  activeId: string | null | undefined,
): boolean {
  const active = String(activeId || "").trim();
  if (!active) return false;
  const convId = msg.conversation_id;
  if (convId == null || String(convId).trim() === "") return true;
  return String(convId) === active;
}

export type GateCaseWsHandlersOptions = {
  /**
   * Types that must run even when blank / other Case is open
   * (e.g. conversation_working patches store by conversation_id for sidebar).
   */
  bypass?: readonly string[];
};

/**
 * Wrap a handler map so Case-scoped types only run when isActiveCaseMessage.
 * Bypass types are left as-is (they own their own conversation_id filtering).
 */
export function gateCaseWsHandlers(
  activeId: string | null | undefined,
  handlers: Record<string, CaseWsHandler>,
  options?: GateCaseWsHandlersOptions,
): Record<string, CaseWsHandler> {
  const bypass = new Set(
    (options?.bypass || []).map((t) => String(t || "").trim()).filter(Boolean),
  );
  const out: Record<string, CaseWsHandler> = {};
  for (const [type, handler] of Object.entries(handlers)) {
    if (!handler) continue;
    if (bypass.has(type)) {
      out[type] = handler;
      continue;
    }
    out[type] = (msg) => {
      if (!isActiveCaseMessage(msg, activeId)) return;
      handler(msg);
    };
  }
  return out;
}
