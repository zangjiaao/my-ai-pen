/**
 * Expert hard-graph task path: ownership inverted to Hard Graph runner.
 * Main OMP loop is not the stage scheduler. Outer continues do not apply.
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileInsideRoot } from "./session-workspace.js";
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
import { disposeGraphFeedbackHandle } from "./hard-graph-feedback-agent.js";
import { settleHardGraphTask } from "./hard-graph-settlement.js";
import {
  pdcaSettleEnabled,
  projectOverlayFromRuntime,
} from "./pdca-settlement.js";
import { HardGraphPlanStore, emitHardGraphPlanTreeUpdate } from "./hard-graph-plan.js";
import {
  createUsageLedgerFromEnv,
  emitCheckpointUpdate,
  stampPanelConfiguredModel,
  type ObservabilityContext,
} from "./platform-observability.js";
import { PanelAgentTracker } from "./panel-agents.js";
import { GoalStore } from "../stores/goal.js";
import { ensureProcessQuality } from "./package-honesty-host.js";
import { seedPriorsAtGraphStart } from "./prior-seed.js";
import { seedSurfacesFromTargetAtTaskStart } from "./surface-target-seed.js";
import { buildEngagementCloseout, writeEngagementCloseout } from "./engagement-closeout.js";
import {
  createGraphRunQualityState,
  ensureGraphRunQuality,
} from "./graph-run-quality.js";
import { l1MaxStageRefine } from "./l1-critic.js";
import { validateHypothesisWorkModeForGraph } from "./hard-graph-definition.js";
import {
  buildHypothesisPromoteSummary,
  reseedHypothesisQueue,
  type HypothesisSeedGist,
} from "./hypothesis-store.js";
import { isLlmTurnError } from "./llm-turn-error.js";
import { buildStageAdvanceDecisionPayload } from "./stage-advance-feedback.js";

export type HardGraphTaskResult = {
  /** Platform task_complete.status (completed | incomplete | blocked). */
  harnessStatus: "completed" | "incomplete" | "blocked";
  piDir: string;
  graphId: string;
  terminal: HardGraphTerminal;
  workMode: string;
};

/** Pull hypothesis gists from case_context Delivery / promote materials (structured only). */
function extractHypothesisGistsFromCase(
  caseContext: TaskEnvelope["caseContext"],
): HypothesisSeedGist[] {
  if (!caseContext || typeof caseContext !== "object") return [];
  const raw = caseContext as Record<string, unknown>;
  const candidates = [
    raw.hypothesis_summary,
    raw.hypothesisSummary,
    (raw.delivery as Record<string, unknown> | undefined)?.hypothesis_summary,
    (raw.delivery as Record<string, unknown> | undefined)?.hypothesisSummary,
  ];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const gists = (c as { gists?: unknown }).gists;
    if (Array.isArray(gists) && gists.length) {
      return gists
        .filter((g) => g && typeof g === "object")
        .map((g) => {
          const o = g as Record<string, unknown>;
          return {
            id: o.id != null ? String(o.id) : undefined,
            status: o.status != null ? String(o.status) : undefined,
            statement: String(o.statement || "").trim(),
            signal: o.signal != null ? String(o.signal) : undefined,
            prove_if: o.prove_if != null ? String(o.prove_if) : undefined,
            disprove_if: o.disprove_if != null ? String(o.disprove_if) : undefined,
            revisit_if: o.revisit_if != null ? String(o.revisit_if) : undefined,
          } as HypothesisSeedGist;
        })
        .filter((g) => g.statement);
    }
  }
  return [];
}

function workModeForEvent(event: HardGraphStageEvent): string {
  if (event.type === "stage_start") {
    return `hard_graph:${event.graphId}:${event.stageId}`;
  }
  if (event.type === "stage_end") {
    return `hard_graph:${event.graphId}:${event.stageId}:${event.outcome}`;
  }
  return `hard_graph:${event.graphId}:terminal:${event.terminal}`;
}

/**
 * Stage boundaries: plan_tree (Tasks) + work_status (busy). Not status_update —
 * that channel is ephemeral harness, not a Graph ledger.
 */
export async function emitHardGraphStageStatus(options: {
  platform: PlatformSink;
  task: TaskEnvelope;
  event: HardGraphStageEvent;
  startedAt: string;
  /** Optional L1/L2 Tasks map — updated and re-emitted on stage boundaries. */
  plan?: HardGraphPlanStore;
  /** Spec #321: Task Map history — stage boundaries mutate live only (E5). */
  taskMap?: import("../stores/task-map.js").TaskMapHistory;
}): Promise<void> {
  const { platform, task, event, plan, taskMap } = options;
  const work_mode = workModeForEvent(event);
  const mapOpts = taskMap ? { taskMap } : undefined;

  if (event.type === "stage_start") {
    if (plan) {
      plan.setStageStatus(event.stageId, "running");
      await emitHardGraphPlanTreeUpdate(
        platform,
        task,
        plan,
        `stage_start:${event.stageId}`,
        mapOpts,
      );
    }
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
        // Spec #281: drop running L2 under ending stage before/while L1 closes.
        plan.neutralizeOpenRunningL2(event.stageId);
        plan.setStageStatus(event.stageId, planStatus);
        await emitHardGraphPlanTreeUpdate(
          platform,
          task,
          plan,
          `stage_end:${event.stageId}:${event.outcome}`,
          mapOpts,
        );
      }
    }
    return;
  }
}

/** Spec #282: after Feedback pause, resume Hard at the next declared stage id. */
async function resolvePausedStartStage(
  caseDir: string,
  task: TaskEnvelope,
): Promise<string | undefined> {
  if (task.graphExecution !== "resume") return undefined;
  try {
    const raw = await readFile(join(caseDir, "hard-graph", "run-result.json"), "utf8");
    const saved = JSON.parse(raw) as {
      terminal?: string;
      advance?: { decision?: string; nextStageId?: string };
    };
    if (saved.terminal === "paused" && saved.advance?.decision === "pause") {
      const next = String(saved.advance.nextStageId || "").trim();
      return next || undefined;
    }
  } catch {
    /* no prior run-result */
  }
  return undefined;
}

/**
 * Run Expert task under Hard Graph runner (no Main-as-scheduler).
 * Settles via settleHardGraphTask (single task_complete dialect).
 */
export async function runHardGraphExpertTask(options: {
  config: Node4Config;
  platform: PlatformSink;
  task: TaskEnvelope;
  caseDir: string;
  pack: RolePack;
  graph: HardGraphDefinition;
  /** Real parent ToolRuntime — required for production pi stages. */
  parentRuntime: ToolRuntime;
  signal?: AbortSignal;
  /** Test inject: skip real pi */
  stageExecutor?: StageExecutor;
}): Promise<HardGraphTaskResult> {
  const { config, platform, task, caseDir, pack, graph, parentRuntime, signal } = options;
  const startedAt = new Date().toISOString();

  await mkdir(join(caseDir, "hard-graph"), { recursive: true });

  // Run-level Tasks map + usage + panel (single hardGraphRun owner).
  const graphPlan = new HardGraphPlanStore(graph);
  const runUsage = createUsageLedgerFromEnv();
  const panelLabel =
    (typeof task.expertName === "string" && task.expertName.trim()) || pack.id || "Expert";
  const panel = new PanelAgentTracker(task.instruction || "Expert Graph task", panelLabel);
  panel.setWorkMode({
    work_mode: "graph",
    graph_id: graph.id,
    graph_label: graph.label,
  });
  stampPanelConfiguredModel(panel, runUsage);
  const graphQuality = createGraphRunQualityState();
  parentRuntime.lifecycle.hardGraphRun = {
    plan: graphPlan,
    usage: runUsage,
    panel,
    graphQuality,
  };
  parentRuntime.lifecycle.panelAgents = panel;
  // Spec #321 E4: entering/restarting Graph is a new participation map.
  // Archive prior Free/Graph live (if any) and install this Graph plan as live.
  // Stage advances later only mutate live (emitHardGraphPlanTreeUpdate E5).
  {
    const taskMap = parentRuntime.todo.getTaskMap();
    const initialTree = graphPlan.toPlanTree();
    const meta = { work_mode: "graph" as const, graph_id: graph.id, title: graph.label || graph.id };
    if (taskMap.hasLiveContent()) {
      taskMap.archiveThenInstall(initialTree, meta);
    } else {
      taskMap.installLive(initialTree, meta);
    }
  }
  // Spec #116: ensure Store-first process quality survives all stages
  const processQuality = ensureProcessQuality(parentRuntime.lifecycle);

  // Spec #274: fail-closed if stage enables hypothesis mode without pack availability
  const hypGate = validateHypothesisWorkModeForGraph(
    graph,
    pack.capabilities?.hypothesis_work_mode === true,
  );
  if (!hypGate.ok) {
    throw new Error(hypGate.error);
  }

  // Spec #274: optional copy-in re-seed from Case Delivery (new run-local store only)
  const deliveryGists = extractHypothesisGistsFromCase(task.caseContext);
  if (deliveryGists.length && graph.stages.some((s) => s.hypothesis_work_mode === true)) {
    reseedHypothesisQueue(processQuality.hypothesisStore, deliveryGists);
  }

  // Spec #139 D2: host-seed Finding Store priors at graph-start (strip bookable proof)
  const priorSeed = seedPriorsAtGraphStart(
    processQuality.findingStore,
    task.caseContext,
  );
  graphQuality.priorSeed = priorSeed;

  // Spec #381 / D8: TARGET + scope.allow → Surface seen (idempotent if session-runner already seeded).
  await seedSurfacesFromTargetAtTaskStart(parentRuntime).catch((err) => {
    console.warn(
      `[node4] surface target seed (hard-graph) failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });

  // Spec #278: task_start carries Session actual Graph mode for AgentRow + dual-rail.
  await platform.send({
    type: "task_start",
    conversation_id: task.conversationId,
    task_id: task.taskId,
    target: task.target,
    role_pack: pack.id,
    started_at: startedAt,
    work_mode: "graph",
    graph_id: graph.id,
    graph_label: graph.label,
    engagement_template: graph.id,
    panel_agents: panel.list(),
    // Spec #455: same-Session continue cold Graph reseed (if platform flagged).
    ...(task.sessionContinue ? { session_continue: true as const } : {}),
  } as PlatformMessage);

  const workStart: PlatformMessage = {
    type: "work_status",
    conversation_id: task.conversationId,
    task_id: task.taskId,
    working: true,
    work_mode: `hard_graph:${graph.id}`,
    graph_id: graph.id,
  };
  await platform.send(workStart);

  // L1 stage map before any stage todos (live already installed above; E5 re-emit only).
  await emitHardGraphPlanTreeUpdate(platform, task, graphPlan, "graph_start", {
    taskMap: parentRuntime.todo.getTaskMap(),
  });

  const availableTools = toolNamesForPack(pack);
  const startStageId = await resolvePausedStartStage(caseDir, task);
  const executeStage =
    options.stageExecutor ??
    createHardGraphStageExecutor({
      config,
      parentRuntime,
      pack,
      abortSignal: signal,
    });

  let result;
  try {
    result = await runHardGraph({
      graph,
      executeStage,
      availableTools,
      abortSignal: signal,
      instruction: task.instruction,
      ...(startStageId ? { startStageId } : {}),
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
        emitHardGraphStageStatus({
          platform,
          task,
          event,
          startedAt,
          plan: graphPlan,
          taskMap: parentRuntime.todo.getTaskMap(),
        }),
    });
  } catch (err) {
    // LlmTurnError: runner already closed stage/run plan events. Emit failed checkpoint
    // (no task_complete) so Status panel is not left spinning, then rethrow → main task_error.
    if (isLlmTurnError(err)) {
      if (parentRuntime.lifecycle.hardGraphRun) {
        parentRuntime.lifecycle.hardGraphRun.stageId = undefined;
      }
      try {
        panel.setMainTerminal("failed");
      } catch {
        /* ignore */
      }
      const failObs: ObservabilityContext = {
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
      await emitCheckpointUpdate(failObs, {
        terminal: true,
        status: "failed",
        endTime: new Date().toISOString(),
      }).catch(() => {});
      await platform
        .send({
          type: "work_status",
          conversation_id: task.conversationId,
          task_id: task.taskId,
          working: false,
          work_mode: `hard_graph:${graph.id}:terminal:llm_error`,
        })
        .catch(() => {});
      await disposeGraphFeedbackHandle(parentRuntime).catch(() => {});
      throw err;
    }
    await disposeGraphFeedbackHandle(parentRuntime).catch(() => {});
    throw err;
  }

  if (
    result.terminal === "paused" &&
    result.advance?.decision === "pause" &&
    result.advance.nextStageId
  ) {
    const card = buildStageAdvanceDecisionPayload({
      conversationId: task.conversationId,
      taskId: task.taskId,
      graphId: graph.id,
      stageId: result.advance.stageId,
      nextStageId: result.advance.nextStageId,
      captainSummary: result.advance.summary,
      expertId: task.expertId,
      expertName: task.expertName,
      requestId: randomUUID(),
    });
    await platform.send(card as PlatformMessage);
  }

  await writeFileInsideRoot(
    join(caseDir, "hard-graph", "run-result.json"),
    caseDir,
    JSON.stringify(result, null, 2),
  );

  // Spec #139 NC-Closeout: dual storage on any terminal
  try {
    const gq = ensureGraphRunQuality(parentRuntime.lifecycle.hardGraphRun) || graphQuality;
    const hypothesis_summary = buildHypothesisPromoteSummary(processQuality.hypothesisStore);
    const closeout = buildEngagementCloseout({
      task,
      graphId: graph.id,
      terminal: result.terminal,
      stages: result.stages,
      store: processQuality.findingStore,
      priorSeed: gq.priorSeed,
      unbookable: gq.unbookable,
      l1ByStage: gq.l1ByStage,
      surfaceSummary: ((await parentRuntime.surfaceSqlite?.summary?.()) ??
        parentRuntime.surfaceLedger?.summary?.()) as
        | { total?: number; by_status?: Record<string, number>; sample_paths?: string[] }
        | undefined,
      hypothesis_summary,
    });
    gq.engagementCloseout = closeout;
    await writeEngagementCloseout({ caseDir, platform, task, closeout });
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
    result.terminal === "completed"
      ? "completed"
      : result.terminal === "paused"
        ? "paused"
        : result.terminal === "aborted"
          ? "aborted"
          : "failed",
  );
  const llmUsage = runUsage.snapshot({
    agent_count: panel.list().length,
  });

  // Spec #311 / #371: Hard settle emits Workset proposed from open surfaces + finding locations.
  // SQLite working store is coverage SoT; legacy JSON only for partial test runtimes.
  let openSurfaces: Array<{
    location: string;
    path_key: string;
    kind?: string;
    status: string;
  }> = [];
  let locationStrings: string[] = [];
  try {
    if (parentRuntime.surfaceSqlite) {
      await parentRuntime.surfaceSqlite.open().catch(() => undefined);
      openSurfaces = await parentRuntime.surfaceSqlite.listOpen();
    } else {
      const ledger = parentRuntime.surfaceLedger;
      if (ledger) {
        await ledger.load().catch(() => undefined);
        openSurfaces = ledger.listOpen();
      }
    }
  } catch {
    openSurfaces = [];
  }
  try {
    const { loadFindings } = await import("../tools/finding.js");
    const localFindings = await loadFindings(parentRuntime.findingsDir);
    locationStrings = localFindings
      .flatMap((f) => [
        String((f as { location?: unknown }).location || ""),
        String((f as { url?: unknown }).url || ""),
        String((f as { poc?: unknown }).poc || ""),
      ])
      .filter(Boolean);
  } catch {
    locationStrings = [];
  }

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
    openSurfaces,
    locationStrings,
    goalMode: Boolean(parentRuntime.goals?.isActive?.() || task.goalObjective),
    goalObjective: task.goalObjective,
    overlay: pdcaSettleEnabled()
      ? await projectOverlayFromRuntime(parentRuntime).catch(() => undefined)
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

  await disposeGraphFeedbackHandle(parentRuntime).catch(() => {});

  return {
    harnessStatus: settled.harnessStatus,
    piDir: parentRuntime.piDir,
    graphId: graph.id,
    terminal: result.terminal,
    workMode: settled.workMode,
  };
}
