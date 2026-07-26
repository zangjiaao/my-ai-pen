/**
 * Engagement close-out (Spec #139 NC-Closeout).
 * Dual storage: taskDir file + platform event/message; same JSON semantics.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FindingStore } from "./finding-store.js";
import type { HardGraphStageRecord, HardGraphTerminal } from "./hard-graph-runner.js";
import type { PriorSeedResult } from "./prior-seed.js";
import type { PlatformSink, TaskEnvelope } from "../types.js";

export type EngagementCloseout = {
  scope: unknown;
  target: unknown;
  graphId: string;
  terminal: HardGraphTerminal;
  stages: Array<{ stageId: string; outcome: string; attempts: number }>;
  surfaces: {
    total?: number;
    by_status?: Record<string, number>;
    sample_paths?: string[];
  };
  findings: {
    by_severity: Record<string, number>;
    booked_titles: string[];
    feedback_ok_unbooked: string[];
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
}): EngagementCloseout {
  const snap = input.store.snapshot();
  const by_severity: Record<string, number> = {};
  const booked_titles: string[] = [];
  const feedback_ok_unbooked: string[] = [];
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
    }
    if (r.prior && r.status !== "booked") still_open_priors += 1;
  }
  const unbookable = input.unbookable || [];
  const residual =
    input.residualRisk ||
    [
      still_open_priors > 0 ? `${still_open_priors} prior(s) still open without re-verify booking` : "",
      feedback_ok_unbooked.length
        ? `${feedback_ok_unbooked.length} feedback_ok unbooked`
        : "",
      unbookable.length ? `${unbookable.length} explicit unbookable` : "",
      (input.surfaceSummary?.by_status?.open || 0) > 0
        ? "open surfaces remain untested"
        : "",
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

  return {
    scope: input.task.scope,
    target: input.task.target,
    graphId: input.graphId,
    terminal: input.terminal,
    stages: input.stages.map((s) => ({
      stageId: s.stageId,
      outcome: s.outcome,
      attempts: s.attempts,
    })),
    surfaces: input.surfaceSummary || {},
    findings: {
      by_severity,
      booked_titles: booked_titles.slice(0, 40),
      feedback_ok_unbooked: feedback_ok_unbooked.slice(0, 40),
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
  };
}

export async function writeEngagementCloseout(options: {
  taskDir: string;
  platform: PlatformSink;
  task: TaskEnvelope;
  closeout: EngagementCloseout;
}): Promise<{ path: string }> {
  const dir = join(options.taskDir, "hard-graph");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "engagement-closeout.json");
  const body = JSON.stringify(options.closeout, null, 2);
  await writeFile(path, body, "utf8");
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
