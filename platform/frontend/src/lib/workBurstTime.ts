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
 * Composer C1: visible only while Case has an active work-burst that is busy
 * or authorize-paused (paused clock still shows). Hidden when settled/idle.
 */
export function composerTimerVisible(workBurst: WorkBurstProjection | null | undefined, working: boolean): boolean {
  if (!workBurst) return false;
  if (workBurst.active_burst_id) {
    // Show while open burst exists (including authorize pause).
    return true;
  }
  // Optimistic: session working but ledger not yet projected.
  return working && (workBurst.live_work_seconds != null || workBurst.accruing === true);
}

/**
 * Live seconds for composer: ledger live value when present; otherwise null
 * (caller may tick from anchor while accruing).
 */
export function composerLiveSeconds(
  workBurst: WorkBurstProjection | null | undefined,
  opts?: { nowMs?: number; tickAnchor?: { seconds: number; atMs: number } | null },
): number | null {
  if (!workBurst?.active_burst_id) return null;
  const base = workBurst.live_work_seconds;
  if (base == null || !Number.isFinite(Number(base))) return null;
  const paused = workBurst.authorize_paused === true || workBurst.accruing === false;
  if (paused) return Math.max(0, Math.floor(Number(base)));
  const tick = opts?.tickAnchor;
  if (tick && opts?.nowMs != null) {
    const delta = Math.max(0, Math.floor((opts.nowMs - tick.atMs) / 1000));
    return Math.max(0, Math.floor(tick.seconds) + delta);
  }
  return Math.max(0, Math.floor(Number(base)));
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

/**
 * messageId → work_seconds for B1 display.
 *
 * Prefer server-stamped content; then attach each finalized burst to the **last
 * agent text of each user→agent turn** so multi-turn Cases always show 耗时
 * (not only when finalized map has exactly one entry).
 */
export function selectResultAnchorMessageIds(
  messages: Array<{ id?: string; role?: string; msg_type?: string; content?: Record<string, unknown> }>,
  finalized: Record<string, number> | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!messages?.length) return out;

  const stampedBurstIds = new Set<string>();

  // 1) Prefer server-stamped anchors on agent result rows
  for (const m of messages) {
    const id = String(m.id || "").trim();
    if (!id || !isAgentResultMessage(m)) continue;
    const content = m.content && typeof m.content === "object" ? m.content : {};
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
    const id = segmentEnds[si];
    if (out[id] != null) continue;
    out[id] = pendingFinalized[fi][1];
    fi -= 1;
  }

  // 4) No turn segmentation but we have ledger seconds: last agent result
  if (Object.keys(out).length === 0 && pendingFinalized.length > 0) {
    const last = segmentEnds[segmentEnds.length - 1];
    if (last) out[last] = pendingFinalized[pendingFinalized.length - 1][1];
  }

  return out;
}
