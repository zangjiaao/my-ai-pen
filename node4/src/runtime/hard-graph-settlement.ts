/**
 * Single settlement path for Hard Graph Expert tasks.
 * session-runner must not invent a second task_complete dialect.
 */

import type { PlatformSink, TaskEnvelope } from "../types.js";
import {
  hardGraphToHarnessStatus,
  type HardGraphTerminal,
} from "./hard-graph-runner.js";

export type HardGraphSettlementResult = {
  /** Platform task_complete.status vocabulary only. */
  harnessStatus: "completed" | "incomplete" | "blocked";
  workMode: string;
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
}): Promise<HardGraphSettlementResult> {
  const harnessStatus = hardGraphToHarnessStatus(options.terminal);
  const workMode = `hard_graph:${options.graphId}:terminal:${options.terminal}`;
  const endTime = new Date().toISOString();

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
  });

  return { harnessStatus, workMode };
}
