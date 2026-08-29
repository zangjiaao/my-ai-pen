/**
 * Engagement close-out (Spec #139 NC-Closeout).
 * Dual storage: taskDir file + platform event/message; same JSON semantics.
 */

import { join } from "node:path";
import { writeFileInsideRoot } from "./session-workspace.js";
import type { FindingStore } from "./finding-store.js";
import type { HardGraphStageRecord, HardGraphTerminal } from "./hard-graph-runner.js";
import type { PriorSeedResult } from "./prior-seed.js";
import type { PlatformSink, TaskEnvelope } from "../types.js";
import type { HypothesisPromoteSummary } from "./hypothesis-store.js";

export type EngagementCloseout = {
  scope: unknown;
  target: unknown;
  graphId: string;
  terminal: HardGraphTerminal;
  stages: Array<{
    stageId: string;
    outcome: string;
    attempts: number;
    errors?: string[];
  }>;
  surfaces: {
    total?: number;
    by_status?: Record<string, number>;
    sample_paths?: string[];
  };
  findings: {
    by_severity: Record<string, number>;
    booked_titles: string[];
    feedback_ok_unbooked: string[];
    /** Store ids only (summary companion to titles). */
    feedback_ok_unbooked_ids?: string[];
    unbookable: Array<{ finding_id: string; reason: string }>;
  };
  priors: {
    prior_n: number;
    re_verified: number;
    still_open: number;
    empty_prior: boolean;
  };
  feedback: Array<{
    stageId: string;
    l0?: string;
    l1?: string;
  }>;
  residual_risk: string;
  language?: string;
  /**
   * NC-Honesty-Advance C1 / residual class.
   * Set when terminal=blocked and feedback_ok rows remain unbooked.
   */
  residual_class?: "blocked_with_unbooked_feedback_ok" | string;
  /** Whether a booking-only tail stage ran after mid-graph block. */
  booking_tail_ran?: boolean;
  blocked_reasons?: string[];
  /** Explicit honesty: process is incomplete when terminal is blocked. */
  process_complete?: boolean;
  /**
   * Spec #274: promote summary of run-local hypothesis queue (not Finding Store).
   * Cross-Graph continuity via Delivery/Handoff only — not a live shared queue.
   */
  hypothesis_summary?: HypothesisPromoteSummary;
};

export function buildEngagementCloseout(input: {
  task: TaskEnvelope;
  graphId: string;
  terminal: HardGraphTerminal;
  stages: HardGraphStageRecord[];
  store: FindingStore;
  priorSeed?: PriorSeedResult;
  unbookable?: Array<{ finding_id: string; reason: string }>;
  l1ByStage?: Record<string, { last?: { decision: string; gaps: string[] } }>;
  surfaceSummary?: { total?: number; by_status?: Record<string, number>; sample_paths?: string[] };
  residualRisk?: string;
  /** Spec #274 promote summary (optional). */
  hypothesis_summary?: HypothesisPromoteSummary;
}): EngagementCloseout {
  const snap = input.store.snapshot();
  const by_severity: Record<string, number> = {};
  const booked_titles: string[] = [];
  const feedback_ok_unbooked: string[] = [];
  const feedback_ok_unbooked_ids: string[] = [];
  let re_verified = 0;
  let still_open_priors = 0;
  for (const r of snap) {
    const sev = String(r.severity || "unset").toLowerCase();
    by_severity[sev] = (by_severity[sev] || 0) + 1;
    if (r.status === "booked") {
      booked_titles.push(r.title.slice(0, 120));
      if (r.prior) re_verified += 1;
    } else if (r.status === "feedback_ok") {
      feedback_ok_unbooked.push(`${r.id}:${r.title}`.slice(0, 120));
      feedback_ok_unbooked_ids.push(r.id);
    }
    if (r.prior && r.status !== "booked") still_open_priors += 1;
  }
  const unbookable = input.unbookable || [];
  const blocked_reasons = input.stages
    .filter((s) => s.outcome === "blocked" || s.outcome === "skipped")
    .flatMap((s) =>
      (s.errors || []).length
        ? (s.errors || []).map((e) => `${s.stageId}:${e}`)
        : [`${s.stageId}:${s.outcome}`],
    );
  // Post-block booking tail only (not a normal completed graph that simply ran validate_book).
  const hasSkippedAfterUpstream = input.stages.some(
    (s) =>
      s.outcome === "skipped" ||
      (s.errors || []).includes("skipped_after_upstream_blocked"),
  );
  const bookingStageRan = input.stages.some(
    (s) =>
      (s.stageId === "validate_book" || String(s.stageId).endsWith("_book")) &&
      s.attempts > 0 &&
      (s.outcome === "passed" || s.outcome === "blocked"),
  );
  const booking_tail_ran =
    input.terminal === "blocked" && hasSkippedAfterUpstream && bookingStageRan;
  const residual =
    input.residualRisk ||
    [
      input.terminal === "blocked"
        ? "Graph process incomplete (terminal=blocked) — do not treat as full coverage success"
        : input.terminal === "paused"
          ? "Graph paused after stage Feedback — later stages not opened"
          : "",
      still_open_priors > 0 ? `${still_open_priors} prior(s) still open without re-verify booking` : "",
      feedback_ok_unbooked.length
        ? `${feedback_ok_unbooked.length} feedback_ok unbooked`
        : "",
      unbookable.length ? `${unbookable.length} explicit unbookable` : "",
      (input.surfaceSummary?.by_status?.open || 0) > 0
        ? "open surfaces remain untested"
        : "",
      booking_tail_ran ? "booking-only tail ran after upstream block" : "",
    ]
      .filter(Boolean)
      .join("; ") || "No residual flags from Product state snapshot.";

  const feedback = input.stages.map((s) => {
    const l1 = input.l1ByStage?.[s.stageId]?.last;
    return {
      stageId: s.stageId,
      l0: s.outcome === "passed" ? "pass" : s.outcome,
      l1: l1?.decision,
    };
  });

  const residual_class =
    input.terminal === "blocked" && feedback_ok_unbooked_ids.length > 0
      ? "blocked_with_unbooked_feedback_ok"
      : undefined;

  return {
    scope: input.task.scope,
    target: input.task.target,
    graphId: input.graphId,
    terminal: input.terminal,
    stages: input.stages.map((s) => ({
      stageId: s.stageId,
      outcome: s.outcome,
      attempts: s.attempts,
      ...(s.errors?.length ? { errors: s.errors.slice(0, 20) } : {}),
    })),
    surfaces: input.surfaceSummary || {},
    findings: {
      by_severity,
      booked_titles: booked_titles.slice(0, 40),
      feedback_ok_unbooked: feedback_ok_unbooked.slice(0, 40),
      feedback_ok_unbooked_ids: feedback_ok_unbooked_ids.slice(0, 40),
      unbookable: unbookable.slice(0, 40),
    },
    priors: {
      prior_n: input.priorSeed?.prior_n ?? input.store.counts().prior_n,
      re_verified,
      still_open: still_open_priors,
      empty_prior: Boolean(input.priorSeed?.empty_prior ?? input.store.counts().prior_n === 0),
    },
    feedback,
    residual_risk: residual,
    language: input.task.agentLanguage,
    process_complete: input.terminal === "completed",
    ...(blocked_reasons.length ? { blocked_reasons: blocked_reasons.slice(0, 40) } : {}),
    ...(booking_tail_ran ? { booking_tail_ran: true } : {}),
    ...(residual_class ? { residual_class } : {}),
    ...(input.hypothesis_summary
      ? { hypothesis_summary: input.hypothesis_summary }
      : {}),
  };
}

export async function writeEngagementCloseout(options: {
  caseDir: string;
  platform: PlatformSink;
  task: TaskEnvelope;
  closeout: EngagementCloseout;
}): Promise<{ path: string }> {
  const path = join(options.caseDir, "hard-graph", "engagement-closeout.json");
  const body = JSON.stringify(options.closeout, null, 2);
  await writeFileInsideRoot(path, options.caseDir, body);
  await options.platform.send({
    type: "engagement_closeout",
    conversation_id: options.task.conversationId,
    task_id: options.task.taskId,
    message: `engagement_closeout terminal=${options.closeout.terminal} graph=${options.closeout.graphId}`,
    engagement_closeout: options.closeout as unknown as Record<string, unknown>,
    status: options.closeout.terminal,
  });
  return { path };
}
