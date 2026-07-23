/**
 * Expert hard-graph task path: ownership inverted to Hard Graph runner.
 * Main OMP loop is not the stage scheduler. Outer continues do not apply.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Node4Config } from "../config.js";
import type { RolePack } from "../roles/types.js";
import type { PlatformSink, TaskEnvelope } from "../types.js";
import { toolNamesForPack } from "../tools/index.js";
import type { HardGraphDefinition } from "./hard-graph-definition.js";
import { runHardGraph, type HardGraphStageEvent } from "./hard-graph-runner.js";
import { createPiHardGraphStageExecutor } from "./hard-graph-stage-executor.js";

export type HardGraphTaskResult = {
  terminalStatus: string;
  taskDir: string;
  graphId: string;
  hardGraphTerminal: "completed" | "blocked" | "aborted";
};

/**
 * Emit stage identity on existing status_update / work_mode channels.
 */
export async function emitHardGraphStageStatus(options: {
  platform: PlatformSink;
  task: TaskEnvelope;
  event: HardGraphStageEvent;
  startedAt: string;
}): Promise<void> {
  const { platform, task, event, startedAt } = options;
  if (event.type === "stage_start") {
    await platform.send({
      type: "status_update",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      message: `hard_graph stage_start graph=${event.graphId} stage=${event.stageId} attempt=${event.attempt}`,
      agent_phase: "hard_graph",
      status: "running",
      work_mode: `hard_graph:${event.graphId}:${event.stageId}`,
      hard_graph: {
        graph_id: event.graphId,
        stage_id: event.stageId,
        stage_index: event.stageIndex,
        attempt: event.attempt,
        event: "stage_start",
      },
      started_at: startedAt,
    } as any);
    await platform.send({
      type: "work_status",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      working: true,
      work_mode: `hard_graph:${event.graphId}:${event.stageId}`,
    } as any);
    return;
  }
  if (event.type === "stage_end") {
    await platform.send({
      type: "status_update",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      message: `hard_graph stage_end graph=${event.graphId} stage=${event.stageId} outcome=${event.outcome}`,
      agent_phase: "hard_graph",
      status: "running",
      work_mode: `hard_graph:${event.graphId}:${event.stageId}:${event.outcome}`,
      hard_graph: {
        graph_id: event.graphId,
        stage_id: event.stageId,
        stage_index: event.stageIndex,
        attempt: event.attempt,
        event: "stage_end",
        outcome: event.outcome,
        errors: event.errors,
        summary: event.summary,
      },
      started_at: startedAt,
    } as any);
    return;
  }
  if (event.type === "run_end") {
    await platform.send({
      type: "status_update",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      message: `hard_graph run_end graph=${event.graphId} terminal=${event.terminal}`,
      agent_phase: "hard_graph",
      status: event.terminal === "completed" ? "completed" : "failed",
      work_mode: `hard_graph:${event.graphId}:terminal:${event.terminal}`,
      hard_graph: {
        graph_id: event.graphId,
        event: "run_end",
        terminal: event.terminal,
      },
      started_at: startedAt,
    } as any);
  }
}

/**
 * Run Expert task under Hard Graph runner (no Main-as-scheduler).
 */
export async function runHardGraphExpertTask(options: {
  config: Node4Config;
  platform: PlatformSink;
  task: TaskEnvelope;
  taskDir: string;
  pack: RolePack;
  graph: HardGraphDefinition;
  signal?: AbortSignal;
  /** Test inject: skip real pi */
  stageExecutor?: ReturnType<typeof createPiHardGraphStageExecutor>;
}): Promise<HardGraphTaskResult> {
  const { config, platform, task, taskDir, pack, graph, signal } = options;
  const startedAt = new Date().toISOString();

  await mkdir(join(taskDir, "hard-graph"), { recursive: true });

  await platform.send({
    type: "status_update",
    conversation_id: task.conversationId,
    task_id: task.taskId,
    message: `hard_graph start graph=${graph.id} stages=${graph.stages.map((s) => s.id).join(",")}`,
    agent_phase: "hard_graph",
    status: "running",
    work_mode: `hard_graph:${graph.id}`,
    hard_graph: { graph_id: graph.id, event: "run_start", stages: graph.stages.map((s) => s.id) },
    started_at: startedAt,
  } as any);

  await platform.send({
    type: "work_status",
    conversation_id: task.conversationId,
    task_id: task.taskId,
    working: true,
    work_mode: `hard_graph:${graph.id}`,
  } as any);

  const availableTools = toolNamesForPack(pack);
  const executeStage =
    options.stageExecutor ??
    createPiHardGraphStageExecutor({
      config,
      task,
      taskDir,
      pack,
      abortSignal: signal,
    });

  const result = await runHardGraph({
    graph,
    executeStage,
    availableTools,
    abortSignal: signal,
    onEvent: (event) =>
      emitHardGraphStageStatus({ platform, task, event, startedAt }),
  });

  await writeFile(
    join(taskDir, "hard-graph", "run-result.json"),
    JSON.stringify(result, null, 2),
    "utf8",
  );

  const terminalStatus =
    result.terminal === "completed"
      ? "completed"
      : result.terminal === "aborted"
        ? "cancelled"
        : "failed";

  await platform.send({
    type: "work_status",
    conversation_id: task.conversationId,
    task_id: task.taskId,
    working: false,
    work_mode: `hard_graph:${graph.id}:terminal:${result.terminal}`,
  } as any);

  return {
    terminalStatus,
    taskDir,
    graphId: graph.id,
    hardGraphTerminal: result.terminal,
  };
}
