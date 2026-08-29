/**
 * Single settlement path for Hard Graph Expert tasks.
 * session-runner must not invent a second task_complete dialect.
 *
 * Spec #311: also emit workset_candidates (proposed Next) from open surfaces / OOS hosts.
 */

import type { PlatformSink, TaskEnvelope } from "../types.js";
import {
  hardGraphToHarnessStatus,
  type HardGraphTerminal,
} from "./hard-graph-runner.js";
import {
  applyBaseHonestyToGraphStatus,
  type LiveStateOverlay,
} from "./pdca-settlement.js";
import {
  filterEmitableWorksetCandidates,
  worksetCandidatesFromHardSettle,
  type WorksetCandidate,
} from "./workset-emit.js";

export type HardGraphSettlementResult = {
  /** Platform task_complete.status vocabulary only. */
  harnessStatus: "completed" | "incomplete" | "blocked";
  workMode: string;
  worksetCandidates: WorksetCandidate[];
};

/**
 * Emit harness-owned task_complete for a finished Hard Graph run.
 */
export async function settleHardGraphTask(options: {
  platform: PlatformSink;
  task: TaskEnvelope;
  packId: string;
  graphId: string;
  terminal: HardGraphTerminal;
  bookedFindings?: number;
  startedAt: string;
  /** Aggregated run usage (Hard Graph stage ledgers merged). */
  llmUsage?: Record<string, unknown>;
  /** Open / in_probe surfaces from SQLite working store (Hard Workset emit, #371). */
  openSurfaces?: Array<{
    location: string;
    path_key: string;
    kind?: string;
    status: string;
  }>;
  /** Finding location strings for OOS host discovery. */
  locationStrings?: string[];
  goalMode?: boolean;
  goalObjective?: string;
  /** Spec #519: optional live overlay — Graph may not complete while base honesty is dirty. */
  overlay?: LiveStateOverlay;
  /** Spec #532: this-run workset(propose) stash. */
  extraWorksetCandidates?: WorksetCandidate[];
}): Promise<HardGraphSettlementResult> {
  let harnessStatus = hardGraphToHarnessStatus(options.terminal);
  if (options.overlay) {
    harnessStatus = applyBaseHonestyToGraphStatus(harnessStatus, options.overlay);
  }
  const workMode = `hard_graph:${options.graphId}:terminal:${options.terminal}`;
  const endTime = new Date().toISOString();

  const worksetCandidates = filterEmitableWorksetCandidates([
    ...worksetCandidatesFromHardSettle({
      task: options.task,
      openSurfaces: options.openSurfaces,
      locationStrings: options.locationStrings,
      source: "hard_settle",
    }),
    ...(options.extraWorksetCandidates || []),
  ]);

  // Legacy next_scope shape for OOS hosts (platform still migrates into Workset).
  const nextScopeCandidates = worksetCandidates
    .filter((c) => c.family === "t_host")
    .map((c) => ({
      host: c.host,
      port: c.port,
      urls: c.urls || [],
      source: "hard_settle",
      in_scope: false,
    }));

  await options.platform.send({
    type: "task_complete",
    conversation_id: options.task.conversationId,
    task_id: options.task.taskId,
    status: harnessStatus,
    summary: `Hard Graph ${options.graphId} terminal=${options.terminal}`,
    stop_reason: `hard_graph_${options.terminal}`,
    continue_count: 0,
    booked_findings: options.bookedFindings ?? 0,
    role_pack: options.packId,
    work_mode: workMode,
    started_at: options.startedAt,
    end_time: endTime,
    ...(options.llmUsage ? { llm_usage: options.llmUsage } : {}),
    workset_candidates: worksetCandidates,
    workset_source: "hard_settle",
    next_scope_candidates: nextScopeCandidates,
    attack_surface_candidates: [
      ...worksetCandidates
        .filter((c) => c.family === "t_host")
        .map((c) => ({
          host: c.host,
          port: c.port,
          urls: c.urls || [],
          source: "hard_settle",
          in_scope: false,
        })),
      ...worksetCandidates
        .filter((c) => c.family === "t_surface")
        .map((c) => ({
          host: c.host || "",
          urls: c.location ? [c.location] : c.urls || [],
          source: "hard_settle",
          in_scope: true,
        })),
    ],
    goal_mode: Boolean(options.goalMode || options.task.goalObjective),
    goal_objective: options.goalObjective || options.task.goalObjective || undefined,
  });

  return { harnessStatus, workMode, worksetCandidates };
}
