/**
 * Spec #325 S2 — work-burst time ledger views (composer C1 + B1 result anchor).
 * Pure projections of platform `work_burst` payload / message meta.
 */

export type WorkBurstProjection = {
  case_started_at?: string | null;
  active_burst_id?: string | null;
  live_work_seconds?: number | null;
  accruing?: boolean;
  authorize_paused?: boolean;
  finalized_work_seconds?: Record<string, number>;
  bursts?: Record<
    string,
    {
      id?: string;
      status?: string;
      work_seconds?: number | null;
      task_ids?: string[];
      authorize_paused?: boolean;
    }
  >;
};

export type ScopedWorkBurst = {
  conversationId: string;
  projection: WorkBurstProjection;
} | null;

/** Return a work-burst only to the Case that owns the projection. */
export function workBurstForConversation(
  scoped: ScopedWorkBurst,
  conversationId: string | null | undefined,
): WorkBurstProjection | null {
  const activeId = String(conversationId || "").trim();
  if (!scoped || !activeId || scoped.conversationId !== activeId) return null;
  return scoped.projection;
}

/** Format busy-union seconds as compact mm:ss or h:mm:ss (composer live timer). */
export function formatWorkSeconds(seconds: unknown): string {
  const n = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Agent result B1 duration label (left of result card): 耗时：11s / 耗时：1m 5s / 耗时：1h 1m 5s
 */
export function formatAgentDurationLabel(seconds: unknown): string {
  const n = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  if (h > 0) {
    if (m > 0 || s > 0) {
      return s > 0 ? `耗时：${h}h ${m}m ${s}s` : `耗时：${h}h ${m}m`;
    }
    return `耗时：${h}h`;
  }
  if (m > 0) {
    return s > 0 ? `耗时：${m}m ${s}s` : `耗时：${m}m`;
  }
  return `耗时：${s}s`;
}

/**
 * Composer C1 + list-tail Working (Spec #325): same open/close lifecycle.
 * - Open: active work-burst id (incl. authorize-paused), or Case `working`
 *   (send→first-burst gap / reload before ledger lands).
 * - Closed: settled/idle (no active_burst_id and not working).
 */
export function composerTimerVisible(workBurst: WorkBurstProjection | null | undefined, working: boolean): boolean {
  if (workBurst?.active_burst_id) return true;
  return working;
}

/**
 * Live seconds for composer: ledger live value when present; otherwise null
 * (caller may tick from anchor while accruing).
 */
export function composerLiveSeconds(
  workBurst: WorkBurstProjection | null | undefined,
  opts?: {
    nowMs?: number;
    tickAnchor?: { seconds: number; atMs: number } | null;
    /** Tenths / remount-safe display. Default floors to whole seconds (composer C1). */
    precise?: boolean;
  },
): number | null {
  if (!workBurst?.active_burst_id) return null;
  const base = workBurst.live_work_seconds;
  if (base == null || !Number.isFinite(Number(base))) return null;
  const paused = workBurst.authorize_paused === true || workBurst.accruing === false;
  const n = Number(base);
  if (paused) return Math.max(0, opts?.precise ? n : Math.floor(n));
  const tick = opts?.tickAnchor;
  if (tick && opts?.nowMs != null) {
    const rawDelta = Math.max(0, (opts.nowMs - tick.atMs) / 1000);
    const delta = opts?.precise ? rawDelta : Math.floor(rawDelta);
    const start = opts?.precise ? Number(tick.seconds) : Math.floor(tick.seconds);
    return Math.max(0, start + delta);
  }
  return Math.max(0, opts?.precise ? n : Math.floor(n));
}

/** List-tail Working tenths (`12.3s` / `1m 5.3s`) from the same C1 seconds. */
export function formatElapsedTenths(seconds: unknown): string {
  const n = Math.max(0, Number(seconds) || 0);
  if (n < 60) return `${n.toFixed(1)}s`;
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${m}m ${s.toFixed(1)}s`;
}

/** B1: message content carries finalized duration for result-anchor card only. */
export function resultAnchorWorkSeconds(content: Record<string, unknown> | null | undefined): number | null {
  if (!content || typeof content !== "object") return null;
  if (content.is_result_anchor !== true && content.is_result_anchor !== "true") {
    // Still accept stamped work_seconds without flag for reload resilience.
    if (content.work_seconds == null) return null;
  }
  const n = Number(content.work_seconds);
  if (!Number.isFinite(n) || n < 0) return null;
  // Only show when this is the anchor locus (flag) or has work_burst_id + work_seconds.
  if (content.is_result_anchor === true || content.is_result_anchor === "true") {
    return Math.floor(n);
  }
  if (content.work_burst_id && content.work_seconds != null) {
    return Math.floor(n);
  }
  return null;
}

const RESULT_MSG_TYPES = new Set(["text", "task_complete", "task_error", "task_incomplete", ""]);

function isAgentResultMessage(m: {
  role?: string;
  msg_type?: string;
}): boolean {
  if (String(m.role || "") !== "agent") return false;
  const mt = String(m.msg_type ?? "text").toLowerCase();
  return RESULT_MSG_TYPES.has(mt);
}

/** True when a tool_call content still looks in-flight (mid-interrupt sticky). */
export function toolContentLooksRunning(content: Record<string, unknown> | null | undefined): boolean {
  if (!content || typeof content !== "object") return false;
  const top = String(content.status ?? "").trim().toLowerCase();
  if (top && !["done", "ok", "success", "completed", "complete", "saved", "loaded",
    "fail", "failed", "error", "blocked", "canceled", "cancelled", "interrupted"].includes(top)) {
    return true;
  }
  const items = Array.isArray(content.tool_items) ? content.tool_items : [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const st = String((raw as Record<string, unknown>).status ?? "").trim().toLowerCase();
    if (!st) continue;
    if (["running", "in_progress", "pending", "active"].includes(st)) return true;
    if (!["done", "ok", "success", "completed", "complete", "saved", "loaded",
      "fail", "failed", "error", "blocked", "canceled", "cancelled", "interrupted"].includes(st)
      && !/^\d{3}$/.test(st)) {
      return true;
    }
  }
  // Top empty + progressive summary like "shell running" with no terminal items.
  if (!top && /\s+running$/i.test(String(content.summary ?? "").trim())) return true;
  return top === "running";
}

/**
 * messageId → work_seconds for B1 display.
 *
 * Prefer server-stamped content; then attach each finalized burst to the **last
 * agent text of each user→agent turn** so multi-turn Cases always show 耗时
 * (not only when finalized map has exactly one entry).
 *
 * @param opts.streamingMessageIds — message / stream ids still progressive; withheld.
 * @param opts.suppressOpenSegment — when Case is still working, withhold 耗时 on
 *   **all** agent result rows after the last user message (covers stamp-before-
 *   stream-end races and live-map catch-up prune). Historical turns still show.
 *
 * Also withholds 耗时 on a turn segment while any tool_call in that segment is
 * still `running` — avoids 「耗时」 sitting above a stuck mid-interrupt shell card.
 */
export function selectResultAnchorMessageIds(
  messages: Array<{ id?: string; role?: string; msg_type?: string; content?: Record<string, unknown> }>,
  finalized: Record<string, number> | undefined,
  opts?: {
    streamingMessageIds?: Iterable<string> | null;
    /** When true, no 耗时 on the open user→agent segment (active turn). */
    suppressOpenSegment?: boolean;
  },
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!messages?.length) return out;

  const streaming = new Set(
    [...(opts?.streamingMessageIds || [])].map((id) => String(id || "").trim()).filter(Boolean),
  );

  // Open segment = after last user message. Suppress 耗时 there while turn is live.
  const openSegmentIds = new Set<string>();
  if (opts?.suppressOpenSegment) {
    let lastUserIdx = -1;
    for (let i = 0; i < messages.length; i++) {
      if (String(messages[i]!.role || "") === "user") lastUserIdx = i;
    }
    if (lastUserIdx >= 0) {
      for (let i = lastUserIdx + 1; i < messages.length; i++) {
        const m = messages[i]!;
        if (!isAgentResultMessage(m)) continue;
        const id = String(m.id || "").trim();
        if (id) openSegmentIds.add(id);
        const content = m.content && typeof m.content === "object" ? m.content : {};
        const sid = String(content.stream_id || "").trim();
        if (sid) openSegmentIds.add(sid);
        const mid = String(content.message_id || "").trim();
        if (mid) openSegmentIds.add(mid);
      }
    }
  }

  // Segment indexes where a tool_call is still running — no B1 耗时 on that turn yet.
  const inflightToolSegmentEndIds = new Set<string>();
  {
    let segmentResultId: string | null = null;
    let segmentHasRunningTool = false;
    const flush = () => {
      if (segmentHasRunningTool && segmentResultId) {
        inflightToolSegmentEndIds.add(segmentResultId);
      }
    };
    for (const m of messages) {
      if (String(m.role || "") === "user") {
        flush();
        segmentResultId = null;
        segmentHasRunningTool = false;
        continue;
      }
      if (isAgentResultMessage(m)) {
        const id = String(m.id || "").trim();
        if (id) segmentResultId = id;
      }
      if (String(m.msg_type || "") === "tool_call") {
        const content = m.content && typeof m.content === "object" ? m.content : {};
        if (toolContentLooksRunning(content)) segmentHasRunningTool = true;
      }
    }
    flush();
  }

  const isWithheld = (id: string, content?: Record<string, unknown>): boolean => {
    if (streaming.has(id)) return true;
    if (openSegmentIds.has(id)) return true;
    if (inflightToolSegmentEndIds.has(id)) return true;
    if (content) {
      const sid = String(content.stream_id || "").trim();
      if (sid && (streaming.has(sid) || openSegmentIds.has(sid))) return true;
      const mid = String(content.message_id || "").trim();
      if (mid && (streaming.has(mid) || openSegmentIds.has(mid))) return true;
    }
    return false;
  };

  const stampedBurstIds = new Set<string>();

  // 1) Prefer server-stamped anchors on agent result rows (skip open/streaming)
  for (const m of messages) {
    const id = String(m.id || "").trim();
    if (!id || !isAgentResultMessage(m)) continue;
    const content = m.content && typeof m.content === "object" ? m.content : {};
    if (isWithheld(id, content)) continue;
    const secs = resultAnchorWorkSeconds(content);
    if (secs != null) {
      out[id] = secs;
      const bid = String(content.work_burst_id || "").trim();
      if (bid) stampedBurstIds.add(bid);
    }
  }

  // 2) Turn ends: last agent result after each user message (or stream tail)
  const segmentEnds: string[] = [];
  let pending: string | null = null;
  for (const m of messages) {
    if (String(m.role || "") === "user") {
      if (pending) segmentEnds.push(pending);
      pending = null;
      continue;
    }
    if (isAgentResultMessage(m)) {
      const id = String(m.id || "").trim();
      if (id) pending = id;
    }
  }
  if (pending) segmentEnds.push(pending);

  // 3) Attach remaining finalized bursts (newest → newest turn) so multi-turn never drops 耗时
  const pendingFinalized = Object.entries(finalized || {})
    .filter(([k, v]) => !String(k).startsWith("task:") && Number.isFinite(Number(v)))
    .filter(([bid]) => !stampedBurstIds.has(String(bid)))
    .map(([bid, v]) => [String(bid), Math.max(0, Math.floor(Number(v)))] as const);

  let fi = pendingFinalized.length - 1;
  for (let si = segmentEnds.length - 1; si >= 0 && fi >= 0; si--) {
    const id = segmentEnds[si]!;
    if (out[id] != null) continue;
    // Still open turn / streaming this reply — wait until output + settle finish.
    if (isWithheld(id)) continue;
    out[id] = pendingFinalized[fi]![1];
    fi -= 1;
  }

  // 4) No turn segmentation but we have ledger seconds: last agent result
  if (Object.keys(out).length === 0 && pendingFinalized.length > 0) {
    const last = segmentEnds[segmentEnds.length - 1];
    if (last && !isWithheld(last)) {
      out[last] = pendingFinalized[pendingFinalized.length - 1]![1];
    }
  }

  return out;
}
