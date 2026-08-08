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

/** Format busy-union seconds as compact mm:ss or h:mm:ss. */
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

/**
 * Given messages + finalized map, ensure only one message id is the B1 anchor per burst.
 * Prefer messages already stamped; else last text/status/error agent row.
 */
export function selectResultAnchorMessageIds(
  messages: Array<{ id?: string; role?: string; msg_type?: string; content?: Record<string, unknown> }>,
  finalized: Record<string, number> | undefined,
): Record<string, number> {
  /** messageId → work_seconds for B1 display */
  const out: Record<string, number> = {};
  if (!finalized || !messages?.length) return out;

  // Prefer server-stamped anchors
  for (const m of messages) {
    const id = String(m.id || "").trim();
    if (!id || m.role !== "agent") continue;
    const content = m.content && typeof m.content === "object" ? m.content : {};
    const secs = resultAnchorWorkSeconds(content);
    if (secs != null) {
      out[id] = secs;
    }
  }
  if (Object.keys(out).length) return out;

  // Fallback: last agent result-like message gets the most recent finalized seconds
  // when server stamp is missing (reload race). One duration total if single finalized.
  const values = Object.entries(finalized).filter(([k]) => !k.startsWith("task:"));
  if (values.length !== 1) return out;
  const [, secs] = values[0];
  const resultTypes = new Set(["text", "status", "task_complete", "task_error", "task_incomplete", "engagement_closeout"]);
  let lastId = "";
  for (const m of messages) {
    if (m.role !== "agent") continue;
    const mt = String(m.msg_type || "").toLowerCase();
    if (resultTypes.has(mt) || m.content?.text) {
      lastId = String(m.id || "").trim();
    }
  }
  if (lastId) out[lastId] = Math.floor(Number(secs) || 0);
  return out;
}
