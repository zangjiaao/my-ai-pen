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
import { HardGraphPlanStore, emitHardGraphPlanTreeUpdate } from "./hard-graph-plan.js";
import {
  createUsageLedgerFromEnv,
  emitCheckpointUpdate,
  type ObservabilityContext,
} from "./platform-observability.js";
import { PanelAgentTracker } from "./panel-agents.js";
import { GoalStore } from "../stores/goal.js";
import { ensureProcessQuality } from "./package-honesty-host.js";
import { seedPriorsAtGraphStart } from "./prior-seed.js";
import { buildEngagementCloseout, writeEngagementCloseout } from "./engagement-closeout.js";
import {
  createGraphRunQualityState,
  ensureGraphRunQuality,
} from "./graph-run-quality.js";
import { l1MaxStageRefine } from "./l1-critic.js";

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
  /** Optional L1/L2 Tasks map — updated and re-emitted on stage boundaries. */
  plan?: HardGraphPlanStore;
}): Promise<void> {
  const { platform, task, event, startedAt, plan } = options;
  const work_mode = workModeForEvent(event);
  const hard_graph = hardGraphPayload(event);

  if (event.type === "stage_start") {
    if (plan) {
      plan.setStageStatus(event.stageId, "running");
      await emitHardGraphPlanTreeUpdate(platform, task, plan, `stage_start:${event.stageId}`);
    }
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
    if (plan) {
      // failed_attempt keeps stage running (retry); terminal outcomes close L1.
      if (event.outcome !== "failed_attempt") {
        const planStatus =
          event.outcome === "passed"
            ? "done"
            : event.outcome === "skipped"
              ? "skipped"
              : event.outcome === "aborted" || event.outcome === "blocked"
                ? "blocked"
                : "failed";
        plan.setStageStatus(event.stageId, planStatus);
        await emitHardGraphPlanTreeUpdate(platform, task, plan, `stage_end:${event.stageId}:${event.outcome}`);
      }
    }
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

  // Run-level Tasks map + usage + panel (single hardGraphRun owner).
  const graphPlan = new HardGraphPlanStore(graph);
  const runUsage = createUsageLedgerFromEnv();
  const panelLabel =
    (typeof task.expertName === "string" && task.expertName.trim()) || pack.id || "Expert";
  const panel = new PanelAgentTracker(task.instruction || "Expert Graph task", panelLabel);
  const graphQuality = createGraphRunQualityState();
  parentRuntime.lifecycle.hardGraphRun = {
    plan: graphPlan,
    usage: runUsage,
    panel,
    graphQuality,
  };
  parentRuntime.lifecycle.panelAgents = panel;
  // Spec #116: ensure Store-first process quality survives all stages
  const processQuality = ensureProcessQuality(parentRuntime.lifecycle);

  // Spec #139 D2: host-seed Finding Store priors at graph-start (strip bookable proof)
  const priorSeed = seedPriorsAtGraphStart(
    processQuality.findingStore,
    task.caseContext,
  );
  graphQuality.priorSeed = priorSeed;

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

  // L1 stage map before any stage todos.
  await emitHardGraphPlanTreeUpdate(platform, task, graphPlan, "graph_start");

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
    l1Budget: {
      getRefineCount: (stageId) => graphQuality.l1ByStage[stageId]?.refine_n || 0,
      recordRefine: (stageId, gaps) => {
        const prev = graphQuality.l1ByStage[stageId] || { refine_n: 0 };
        prev.refine_n = (prev.refine_n || 0) + 1;
        prev.last = { decision: "refine", gaps };
        graphQuality.l1ByStage[stageId] = prev;
      },
      maxRefine: l1MaxStageRefine(),
    },
    onEvent: (event) =>
      emitHardGraphStageStatus({ platform, task, event, startedAt, plan: graphPlan }),
  });

  await writeFile(
    join(taskDir, "hard-graph", "run-result.json"),
    JSON.stringify(result, null, 2),
    "utf8",
  );

  // Spec #139 NC-Closeout: dual storage on any terminal
  try {
    const gq = ensureGraphRunQuality(parentRuntime.lifecycle.hardGraphRun) || graphQuality;
    const closeout = buildEngagementCloseout({
      task,
      graphId: graph.id,
      terminal: result.terminal,
      stages: result.stages,
      store: processQuality.findingStore,
      priorSeed: gq.priorSeed,
      unbookable: gq.unbookable,
      l1ByStage: gq.l1ByStage,
      surfaceSummary: parentRuntime.surfaceLedger?.summary?.() as
        | { total?: number; by_status?: Record<string, number>; sample_paths?: string[] }
        | undefined,
    });
    gq.engagementCloseout = closeout;
    await writeEngagementCloseout({ taskDir, platform, task, closeout });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[hard-graph] engagement close-out failed: ${msg}`);
    try {
      await platform.send({
        type: "engagement_closeout_error",
        conversation_id: task.conversationId,
        task_id: task.taskId,
        message: `engagement_closeout failed: ${msg}`,
        status: "error",
      });
    } catch {
      /* platform may be down */
    }
  }

  let bookedFindings = 0;
  try {
    const booked = await loadConfirmedFindings(parentRuntime.findingsDir);
    bookedFindings = booked.count;
  } catch {
    bookedFindings = 0;
  }

  panel.setMainTerminal(
    result.terminal === "completed" ? "completed" : result.terminal === "aborted" ? "aborted" : "failed",
  );
  const llmUsage = runUsage.snapshot({
    agent_count: panel.list().length,
  });

  const settled = await settleHardGraphTask({
    platform,
    task,
    packId: pack.id,
    graphId: graph.id,
    terminal: result.terminal,
    bookedFindings,
    startedAt,
    llmUsage:
      llmUsage.requests > 0 || llmUsage.total_tokens > 0
        ? (llmUsage as unknown as Record<string, unknown>)
        : undefined,
  });

  // Terminal checkpoint via shared builder (same plan_tree / llm_usage shapes as mid-run).
  if (parentRuntime.lifecycle.hardGraphRun) {
    parentRuntime.lifecycle.hardGraphRun.stageId = undefined;
  }
  const terminalObs: ObservabilityContext = {
    platform,
    task,
    runtime: parentRuntime,
    goals: parentRuntime.goals || new GoalStore(),
    usage: runUsage,
    panel,
    startedAt,
    rolePackId: pack.id,
    counters: { toolCallCount: 0, phase: "finished" },
  };
  await emitCheckpointUpdate(terminalObs, {
    terminal: true,
    status: settled.harnessStatus,
    endTime: new Date().toISOString(),
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
