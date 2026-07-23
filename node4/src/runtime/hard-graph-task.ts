/**
 * Expert hard-graph task path: ownership inverted to Hard Graph runner.
 * Main OMP loop is not the stage scheduler. Outer continues do not apply.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Node4Config } from "../config.js";
import type { RolePack } from "../roles/types.js";
import type { PlatformMessage, PlatformSink, TaskEnvelope, ToolRuntime } from "../types.js";
import { toolNamesForPack } from "../tools/index.js";
import { loadConfirmedFindings } from "../tools/finding.js";
import type { HardGraphDefinition } from "./hard-graph-definition.js";
import {
  runHardGraph,
  type HardGraphStageEvent,
  type HardGraphTerminal,
  type StageExecutor,
} from "./hard-graph-runner.js";
import { createHardGraphStageExecutor } from "./hard-graph-stage-executor.js";
import { settleHardGraphTask } from "./hard-graph-settlement.js";

export type HardGraphTaskResult = {
  /** Platform task_complete.status (completed | incomplete | blocked). */
  harnessStatus: "completed" | "incomplete" | "blocked";
  taskDir: string;
  graphId: string;
  terminal: HardGraphTerminal;
  workMode: string;
};

function workModeForEvent(event: HardGraphStageEvent): string {
  if (event.type === "stage_start") {
    return `hard_graph:${event.graphId}:${event.stageId}`;
  }
  if (event.type === "stage_end") {
    return `hard_graph:${event.graphId}:${event.stageId}:${event.outcome}`;
  }
  return `hard_graph:${event.graphId}:terminal:${event.terminal}`;
}

function hardGraphPayload(event: HardGraphStageEvent): Record<string, unknown> {
  if (event.type === "stage_start") {
    return {
      graph_id: event.graphId,
      stage_id: event.stageId,
      stage_index: event.stageIndex,
      attempt: event.attempt,
      event: "stage_start",
    };
  }
  if (event.type === "stage_end") {
    return {
      graph_id: event.graphId,
      stage_id: event.stageId,
      stage_index: event.stageIndex,
      attempt: event.attempt,
      event: "stage_end",
      outcome: event.outcome,
      errors: event.errors,
      summary: event.summary,
    };
  }
  return {
    graph_id: event.graphId,
    event: "run_end",
    terminal: event.terminal,
  };
}

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
  const work_mode = workModeForEvent(event);
  const hard_graph = hardGraphPayload(event);

  if (event.type === "stage_start") {
    const statusMsg: PlatformMessage = {
      type: "status_update",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      message: `hard_graph stage_start graph=${event.graphId} stage=${event.stageId} attempt=${event.attempt}`,
      agent_phase: "hard_graph",
      status: "running",
      work_mode,
      hard_graph,
      started_at: startedAt,
    };
    await platform.send(statusMsg);
    const workMsg: PlatformMessage = {
      type: "work_status",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      working: true,
      work_mode,
    };
    await platform.send(workMsg);
    return;
  }

  if (event.type === "stage_end") {
    const statusMsg: PlatformMessage = {
      type: "status_update",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      message: `hard_graph stage_end graph=${event.graphId} stage=${event.stageId} outcome=${event.outcome}`,
      agent_phase: "hard_graph",
      status: "running",
      work_mode,
      hard_graph,
      started_at: startedAt,
    };
    await platform.send(statusMsg);
    return;
  }

  const statusMsg: PlatformMessage = {
    type: "status_update",
    conversation_id: task.conversationId,
    task_id: task.taskId,
    message: `hard_graph run_end graph=${event.graphId} terminal=${event.terminal}`,
    agent_phase: "hard_graph",
    // Align with harness vocabulary (not "failed" — platform maps that poorly).
    status:
      event.terminal === "completed"
        ? "completed"
        : event.terminal === "aborted"
          ? "incomplete"
          : "blocked",
    work_mode,
    hard_graph,
    started_at: startedAt,
  };
  await platform.send(statusMsg);
}

/**
 * Run Expert task under Hard Graph runner (no Main-as-scheduler).
 * Settles via settleHardGraphTask (single task_complete dialect).
 */
export async function runHardGraphExpertTask(options: {
  config: Node4Config;
  platform: PlatformSink;
  task: TaskEnvelope;
  taskDir: string;
  pack: RolePack;
  graph: HardGraphDefinition;
  /** Real parent ToolRuntime — required for production pi stages. */
  parentRuntime: ToolRuntime;
  signal?: AbortSignal;
  /** Test inject: skip real pi */
  stageExecutor?: StageExecutor;
}): Promise<HardGraphTaskResult> {
  const { config, platform, task, taskDir, pack, graph, parentRuntime, signal } = options;
  const startedAt = new Date().toISOString();

  await mkdir(join(taskDir, "hard-graph"), { recursive: true });

  const startMsg: PlatformMessage = {
    type: "status_update",
    conversation_id: task.conversationId,
    task_id: task.taskId,
    message: `hard_graph start graph=${graph.id} stages=${graph.stages.map((s) => s.id).join(",")}`,
    agent_phase: "hard_graph",
    status: "running",
    work_mode: `hard_graph:${graph.id}`,
    hard_graph: { graph_id: graph.id, event: "run_start", stages: graph.stages.map((s) => s.id) },
    started_at: startedAt,
  };
  await platform.send(startMsg);

  const workStart: PlatformMessage = {
    type: "work_status",
    conversation_id: task.conversationId,
    task_id: task.taskId,
    working: true,
    work_mode: `hard_graph:${graph.id}`,
  };
  await platform.send(workStart);

  const availableTools = toolNamesForPack(pack);
  const executeStage =
    options.stageExecutor ??
    createHardGraphStageExecutor({
      config,
      parentRuntime,
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

  let bookedFindings = 0;
  try {
    const booked = await loadConfirmedFindings(parentRuntime.findingsDir);
    bookedFindings = booked.count;
  } catch {
    bookedFindings = 0;
  }

  const settled = await settleHardGraphTask({
    platform,
    task,
    packId: pack.id,
    graphId: graph.id,
    terminal: result.terminal,
    bookedFindings,
    startedAt,
  });

  const workEnd: PlatformMessage = {
    type: "work_status",
    conversation_id: task.conversationId,
    task_id: task.taskId,
    working: false,
    work_mode: settled.workMode,
  };
  await platform.send(workEnd);

  return {
    harnessStatus: settled.harnessStatus,
    taskDir,
    graphId: graph.id,
    terminal: result.terminal,
    workMode: settled.workMode,
  };
}
