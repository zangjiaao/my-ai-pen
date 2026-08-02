/**
 * Pure helpers for progressive message stream identity (thinking / text bubbles).
 *
 * Live-slot (`live-slot-${conversationId}`) is only a short-lived agent_pending
 * placeholder. Progressive thinking/text frames use per-stream_id keys so each
 * n4-thinking-…-N turn is its own React bubble.
 */

/** Prefer real stream/platform ids over the per-conversation live-slot placeholder. */
export function preferNonLiveSlotId(...candidates: Array<string | undefined | null>): string {
  const cleaned = candidates.map((c) => String(c || "").trim()).filter(Boolean);
  const real = cleaned.find((id) => !id.startsWith("live-slot-"));
  return real || cleaned[0] || "";
}

/**
 * Morph the live-slot pending placeholder into a progressive stream only when:
 * - the slot is still `agent_pending`, and
 * - a real `stream_id` is present (so the entry is keyed by stream, not live-slot).
 */
export function canMorphThinkingFromLiveSlot(
  slotMsgType: string | undefined | null,
  streamId: string | undefined | null,
): boolean {
  const sid = String(streamId || "").trim();
  return slotMsgType === "agent_pending" && Boolean(sid);
}

/** React list key: one key per progressive stream so thinking turns do not share a DOM node. */
export function messageListKey(msg: {
  id: string;
  content?: { stream_id?: unknown };
  created_at?: string;
}): string {
  const raw = msg.content?.stream_id;
  const streamId = typeof raw === "string" ? raw.trim() : "";
  if (streamId) return `stream:${streamId}`;
  return msg.id || `idx-${msg.created_at || ""}`;
}

/**
 * Merge progressive stream text frames (cumulative full text preferred).
 * Prefers monotonic growth / prefix relationship — never concatenates.
 */
export function mergeProgressiveText(prev: string, next: string): string {
  if (!next) return prev;
  if (!prev) return next;
  if (next.length >= prev.length || next.startsWith(prev) || prev.startsWith(next)) {
    return next.length >= prev.length ? next : prev;
  }
  return next || prev;
}
