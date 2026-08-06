/**
 * Progressive stream identity + pending chrome (Spec #276).
 *
 * Pending is **chrome**, not a Message. Live overlay keys are **stream_id only**.
 * No live-slot Message dual identity.
 */

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

// ---------------------------------------------------------------------------
// Pending chrome lifecycle (S2) — not a Message; list-tail only
// ---------------------------------------------------------------------------

export type PendingChrome = {
  conversationId: string;
  label: string;
} | null;

export type PendingChromeEvent =
  | { type: "send_success"; conversationId: string; label?: string }
  | { type: "stream_started" }
  | { type: "terminal" }
  | { type: "clear" }
  /** Tool feedback must never show or reseed pending chrome. */
  | { type: "tool_output" };

const DEFAULT_PENDING_LABEL = "思考中…";

/** Pure state machine for post-send “思考中…” chrome. */
export function reducePendingChrome(
  current: PendingChrome,
  event: PendingChromeEvent,
): PendingChrome {
  switch (event.type) {
    case "send_success": {
      const conversationId = String(event.conversationId || "").trim();
      if (!conversationId) return null;
      const label = String(event.label || DEFAULT_PENDING_LABEL).trim() || DEFAULT_PENDING_LABEL;
      return { conversationId, label };
    }
    case "stream_started":
    case "terminal":
    case "clear":
      return null;
    case "tool_output":
      return current;
    default:
      return current;
  }
}

/** Whether pending chrome should render for the active conversation. */
export function pendingChromeVisible(
  pending: PendingChrome,
  conversationId: string | null | undefined,
): boolean {
  if (!pending || !conversationId) return false;
  return pending.conversationId === conversationId;
}

// ---------------------------------------------------------------------------
// Live map: Record<streamId, frame> only (S1 / fail-closed)
// ---------------------------------------------------------------------------

export type LiveStreamFrame = {
  streamId: string;
  msgType: "text" | "thinking";
  text: string;
  messageId?: string;
  conversationId?: string;
  /** Extra content (attribution, etc.) for display mapping. */
  content?: Record<string, unknown>;
};

/**
 * Upsert progressive frame only when stream_id is present (fail-closed).
 * Missing stream_id → map unchanged; never invents live-slot or synthetic keys.
 */
export function upsertLiveByStreamId(
  live: Record<string, LiveStreamFrame>,
  input: {
    streamId?: string | null;
    msgType: "text" | "thinking";
    text: string;
    messageId?: string;
    conversationId?: string;
    content?: Record<string, unknown>;
  },
): Record<string, LiveStreamFrame> {
  const streamId = String(input.streamId || "").trim();
  if (!streamId) return live;
  const body = String(input.text || "");
  if (!body) return live;

  const existing = live[streamId];
  const prevText = existing?.text || "";
  const text = mergeProgressiveText(prevText, body);
  return {
    ...live,
    [streamId]: {
      streamId,
      msgType: input.msgType,
      text,
      messageId: String(input.messageId || existing?.messageId || "").trim() || undefined,
      conversationId:
        String(input.conversationId || existing?.conversationId || "").trim() || undefined,
      content: {
        ...(existing?.content || {}),
        ...(input.content || {}),
      },
    },
  };
}

export function clearLiveStreams(): Record<string, LiveStreamFrame> {
  return {};
}

export function hasProgressiveLive(live: Record<string, LiveStreamFrame>): boolean {
  return Object.keys(live).length > 0;
}

// ---------------------------------------------------------------------------
// Prune (S3)
// ---------------------------------------------------------------------------

export type DurableStreamSnapshot = {
  streamId: string;
  text: string;
};

/**
 * Drop live keys when durable (RQ) already has the same stream_id with text ≥ live.
 */
export function pruneLiveCatchUp(
  live: Record<string, LiveStreamFrame>,
  durable: DurableStreamSnapshot[],
): Record<string, LiveStreamFrame> {
  const keys = Object.keys(live);
  if (!keys.length) return live;

  const byStream = new Map<string, string>();
  for (const row of durable) {
    const sid = String(row.streamId || "").trim();
    if (!sid) continue;
    byStream.set(sid, String(row.text || ""));
  }
  if (!byStream.size) return live;

  let changed = false;
  const next: Record<string, LiveStreamFrame> = {};
  for (const [sid, frame] of Object.entries(live)) {
    const durableText = byStream.get(sid);
    if (durableText !== undefined && durableText.length >= (frame.text || "").length) {
      changed = true;
      continue;
    }
    next[sid] = frame;
  }
  return changed ? next : live;
}

/** Extract stream text snapshots from durable message-like rows (for catch-up prune). */
export function durableStreamSnapshots(
  messages: Array<{
    msg_type?: string;
    content?: { stream_id?: unknown; text?: unknown; reasoning?: unknown };
  }>,
): DurableStreamSnapshot[] {
  const out: DurableStreamSnapshot[] = [];
  for (const m of messages) {
    const raw = m.content?.stream_id;
    const streamId = typeof raw === "string" ? raw.trim() : "";
    if (!streamId) continue;
    const text =
      (typeof m.content?.text === "string" ? m.content.text : "")
      || (typeof m.content?.reasoning === "string" ? m.content.reasoning : "");
    out.push({ streamId, text });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Display merge (S4)
// ---------------------------------------------------------------------------

export type StreamMessageLike = {
  id: string;
  conversation_id?: string;
  msg_type: string;
  role?: string;
  content: Record<string, unknown>;
  created_at?: string;
};

function readStreamId(content: Record<string, unknown> | undefined): string {
  const raw = content?.stream_id;
  return typeof raw === "string" ? raw.trim() : "";
}

function messageMergeKey(msg: StreamMessageLike): string {
  const streamId = readStreamId(msg.content);
  return streamId ? `stream:${streamId}` : `id:${msg.id}`;
}

/**
 * Default map from live frame → list Message-like (render boundary).
 * Not a Message type from types.ts — callers cast if needed.
 */
export function liveFrameToMessageLike(frame: LiveStreamFrame): StreamMessageLike {
  const id = frame.messageId || frame.streamId;
  return {
    id,
    conversation_id: frame.conversationId,
    role: "agent",
    msg_type: frame.msgType,
    content: {
      ...(frame.content || {}),
      text: frame.text,
      ...(frame.msgType === "thinking" ? { reasoning: frame.text } : {}),
      stream_id: frame.streamId,
      message_id: id,
    },
    created_at: new Date(0).toISOString(),
  };
}

/**
 * RQ messages (filter agent_pending) ∪ live by stream_id.
 * Live-only streams append after durable order. No live-slot keys.
 */
export function mergeMessagesWithLiveStreams<T extends StreamMessageLike>(
  durable: T[],
  live: Record<string, LiveStreamFrame>,
  opts?: {
    activeConversationId?: string | null;
    liveToMessage?: (frame: LiveStreamFrame) => T;
  },
): T[] {
  const activeId = opts?.activeConversationId ?? null;
  const base = durable.filter((m) => m.msg_type !== "agent_pending");
  const toMsg =
    opts?.liveToMessage
    || ((frame: LiveStreamFrame) => liveFrameToMessageLike(frame) as T);

  const byKey = new Map<string, T>();
  for (const m of base) {
    byKey.set(messageMergeKey(m), m);
  }

  for (const frame of Object.values(live)) {
    if (activeId && frame.conversationId && frame.conversationId !== activeId) continue;
    const streamId = String(frame.streamId || "").trim();
    if (!streamId) continue;
    const key = `stream:${streamId}`;
    const liveMsg = toMsg(frame);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, liveMsg);
      continue;
    }
    const prevText =
      String(prev.content.text || "") || String(prev.content.reasoning || "");
    const text = mergeProgressiveText(prevText, frame.text);
    const stableId = frame.messageId || prev.id;
    byKey.set(key, {
      ...prev,
      ...liveMsg,
      id: stableId,
      content: {
        ...prev.content,
        ...liveMsg.content,
        text,
        ...(frame.msgType === "thinking" || prev.msg_type === "thinking"
          ? { reasoning: text }
          : {}),
        stream_id: streamId,
        message_id: stableId,
      },
    });
  }

  const seen = new Set<string>();
  const merged: T[] = [];
  for (const m of base) {
    const key = messageMergeKey(m);
    merged.push(byKey.get(key) || m);
    seen.add(key);
  }
  for (const [key, msg] of byKey) {
    if (seen.has(key)) continue;
    merged.push(msg);
  }
  return merged;
}
