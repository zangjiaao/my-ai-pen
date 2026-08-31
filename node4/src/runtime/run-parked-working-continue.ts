/**
 * Spec #283 (I0.9): run the next user turn on a parked captain working runtime.
 * Attach path only — cold reseed is the caller's fallback.
 *
 * End policy matches Free/Graph finallies via decideCaptainEndDisposition (Spec #354):
 * incomplete / abort / package complete → re-park; dispose only via explicit whitelist.
 */

import { join } from "node:path";
import type { Node4Config } from "../config.js";
import type { PlatformSink, TaskEnvelope } from "../types.js";
import { GoalStore } from "../stores/goal.js";
import {
  formatLiveStateHarness,
  lastDeltaFromRuntime,
  mapPdcaVerdictToHarnessStatus,
  pdcaSettleEnabled,
  persistPdcaOnRuntime,
  projectOverlayFromRuntime,
  settleParticipantTurn,
  type ParticipantTurnSettlement,
} from "./pdca-settlement.js";
import { joinHarnessPrefixes } from "./harness-channel.js";
import { registerActiveSession } from "./active-session-registry.js";
import { applyServerScopeToTask } from "../tools/decision.js";
import {
  attachNode4SessionObservability,
  CheckpointThrottle,
  createUsageLedgerFromEnv,
  emitCheckpointUpdate,
  PlatformTextStream,
  stampPanelConfiguredModel,
  type ObservabilityContext,
} from "./platform-observability.js";
import { PanelAgentTracker } from "./panel-agents.js";
import { extractLlmTurnError, LlmTurnError } from "./llm-turn-error.js";
import { emitTodoPlanTreeUpdate } from "./plan-projection.js";
import {
  buildWorksetSettleEmitPackage,
  writeAttackSurfaceCandidatesArtifact,
} from "./workset-settle-emit.js";
import {
  applyCaptainEndDisposition,
  decideCaptainEndDisposition,
  harnessStatusAfterParkedContinue,
  rebindParkedRuntimeTask,
  type ParkedWorkingRuntime,
  type WorkingWorkMode,
} from "./working-session-park.js";
import { formatCaseSpeechHarness, selectCaseSpeechDelta } from "./case-speech.js";

export type ParkedContinueResult = {
  terminalStatus: "completed" | "incomplete" | "blocked";
  attached: true;
  workMode: WorkingWorkMode;
  sameRuntime: true;
  /** True when captain was re-parked for a later same-Session continue. */
  reparked: boolean;
};

/**
 * Best-effort: re-project parked todos onto the new task_id so UI Tasks is not empty
 * solely because task_id changed (does not wipe or re-init store).
 */
async function reemitParkedTodos(
  platform: PlatformSink,
  task: TaskEnvelope,
  parked: ParkedWorkingRuntime,
): Promise<void> {
  try {
    const open = parked.todo.openCount();
    const phases = parked.todo.snapshot();
    if (!phases.some((p) => p.tasks.length > 0)) return;
    await platform.send({
      type: "todo_updated",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      op: "view",
      phases,
      open_count: open,
      scope: "case",
      parked_continue: true,
    } as any);
    // Free / non-GraphStore path: project TodoStore plan_tree under new task_id.
    // Graph L2 SOT is GraphStore when present; still re-emit Todo projection for mid-stage
    // park where hardGraphRun may already be gone after aborted Hard run.
    await emitTodoPlanTreeUpdate(platform, task, parked.todo, "parked_continue.reemit");
  } catch {
    /* best-effort — agent memory still holds TodoStore */
  }
}

/**
 * Prompt the parked captain with the continue message; re-park when incomplete.
 *
 * Spec #455 S2: turn body is `task.instruction` (operator utterance) only —
 * no cold multi-block user prompt rebuild / case_context re-inject here.
 */
export async function runParkedWorkingContinue(options: {
  config: Node4Config;
  platform: PlatformSink;
  task: TaskEnvelope;
  parked: ParkedWorkingRuntime;
  signal?: AbortSignal;
}): Promise<ParkedContinueResult> {
  const { platform, task, parked, signal } = options;
  const workMode = parked.workMode;
  const startedAt = new Date().toISOString();
  let reparked = false;
  let harnessStatus: "completed" | "incomplete" | "blocked" = "incomplete";

  // Rebind live task/platform onto stored runtime when present.
  if (parked.runtime) {
    rebindParkedRuntimeTask(parked, task);
    parked.runtime.platform = platform;
    if (parked.runtime.lifecycle) {
      parked.runtime.lifecycle.abortSignal = signal;
    }
    if (parked.todo) {
      parked.runtime.todo = parked.todo;
    }
  }

  const panelLabel =
    (typeof task.expertName === "string" && task.expertName.trim()) ||
    "Expert";
  const panel =
    parked.runtime?.lifecycle?.panelAgents ||
    new PanelAgentTracker(task.instruction || "continue", panelLabel);
  // Prior park may have setMainTerminal(aborted) → status stopped forever if reused.
  panel.resetMainForContinue({
    phase: workMode === "graph" ? "parked_graph_continue" : "parked_free_continue",
    task: task.instruction || undefined,
  });
  if (workMode === "graph") {
    panel.setWorkMode({
      work_mode: "graph",
      graph_id: parked.graphId,
    });
  } else {
    panel.setWorkMode({ work_mode: "free" });
  }

  const usage = createUsageLedgerFromEnv();
  stampPanelConfiguredModel(panel, usage);
  const textStream = new PlatformTextStream(platform, task, {
    sessionId: () =>
      String(parked.session?.sessionId || parked.agentSessionId || "").trim(),
  });
  const checkpointThrottle = new CheckpointThrottle();
  const obsCounters = {
    toolCallCount: 0,
    activeTool: undefined as string | undefined,
    phase: workMode === "graph" ? "parked_graph_continue" : "parked_free_continue",
  };
  const runtimeForObs = parked.runtime || {
    task,
    workspaceDir: options.config.workspaceDir,
    piDir: "",
    platform,
    todo: parked.todo,
    findingsDir: "",
    lifecycle: {},
  };
  const obsCtx: ObservabilityContext = {
    platform,
    task,
    runtime: runtimeForObs as any,
    goals: (parked.runtime?.goals as GoalStore | undefined) || new GoalStore(),
    usage,
    panel,
    startedAt,
    rolePackId: parked.runtime?.rolePackId || "runtime",
    counters: obsCounters,
  };

  await platform.send({
    type: "task_start",
    conversation_id: task.conversationId,
    task_id: task.taskId,
    target: task.target,
    started_at: startedAt,
    work_mode: workMode,
    graph_id: parked.graphId,
    panel_agents: panel.list(),
    parked_continue: true,
    // Spec #455: park attach is always same-Session continue (package = accounting).
    session_continue: true,
    stage_id: parked.stageId,
  } as any);

  await reemitParkedTodos(platform, task, parked);

  const session = parked.session;
  const unregister = registerActiveSession({
    conversationId: task.conversationId,
    taskId: task.taskId,
    steer: (text) => session.steer(text),
    followUp: (text) => session.followUp(text),
    applyScope: (scope) => applyServerScopeToTask(task, scope),
  });

  const sessionObs = attachNode4SessionObservability({
    session,
    obsCtx,
    textStream,
    checkpointThrottle,
    disposeTextStream: false,
  });
  // Collab copy: surface parked pi Agent.sessionId on panel + checkpoint.
  const piSid = String(
    session.sessionId || parked.agentSessionId || obsCtx.agentSessionId || "",
  ).trim();
  if (piSid) {
    obsCtx.agentSessionId = piSid;
    try {
      panel.setAgentSessionId(piSid);
    } catch {
      /* ignore */
    }
    await emitCheckpointUpdate(obsCtx, { status: "running" }).catch(() => {});
  }

  const cancelled = () => Boolean(signal?.aborted);
  if (signal) {
    const onAbort = () => {
      try {
        session.abort();
      } catch {
        /* ignore */
      }
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  let stop: "aborted" | "completed" | "error" = "completed";
  let pdcaPreviousOverlay: Awaited<ReturnType<typeof projectOverlayFromRuntime>> | undefined;
  let pdcaLast: ParticipantTurnSettlement | undefined;
  try {
    if (cancelled()) {
      stop = "aborted";
    } else {
      const userTurn = task.instruction || "继续";
      const speech = selectCaseSpeechDelta(task.caseContext, {
        cursor: parked.speechCursor,
        selfSessionId: session.sessionId || parked.agentSessionId,
        selfExpertId: task.expertId || parked.expertId,
        selfExpertName: task.expertName,
        thisTurnText: userTurn,
      });
      if (pdcaSettleEnabled() && workMode === "free" && parked.runtime) {
        pdcaPreviousOverlay = await projectOverlayFromRuntime(parked.runtime).catch(() => undefined);
      }
      await session.prompt(userTurn, {
        prefixHarness: joinHarnessPrefixes(
          formatCaseSpeechHarness(speech.lines),
          pdcaSettleEnabled() && workMode === "free" && pdcaPreviousOverlay
            ? formatLiveStateHarness(pdcaPreviousOverlay, lastDeltaFromRuntime(parked.runtime!))
            : undefined,
        ),
      });
      parked.speechCursor = speech.cursorAfter || parked.speechCursor;
      if (cancelled()) {
        stop = "aborted";
      } else {
        const llmErr = extractLlmTurnError(session.messages);
        if (llmErr) {
          try {
            await textStream.emitFinalText(llmErr);
          } catch {
            /* best-effort */
          }
          throw new LlmTurnError(llmErr);
        }
      }
    }
  } catch (err) {
    if (cancelled()) {
      stop = "aborted";
    } else {
      stop = "error";
      throw err;
    }
  } finally {
    try {
      unregister();
    } catch {
      /* ignore */
    }
    try {
      sessionObs.unsubscribe();
    } catch {
      /* ignore */
    }
    await textStream.dispose().catch(() => {});

    const aborted = stop === "aborted" || cancelled();
    let openTodoCount = 0;
    try {
      openTodoCount = parked.todo.openCount();
    } catch {
      openTodoCount = 0;
    }
    // Spec #354: package complete still re-parks; dispose only via pending whitelist.
    harnessStatus = harnessStatusAfterParkedContinue({
      aborted,
      workMode,
      openTodoCount,
    });
    if (pdcaSettleEnabled() && workMode === "free" && parked.runtime) {
      try {
        const overlayNow = await projectOverlayFromRuntime(parked.runtime);
        const pdca = settleParticipantTurn({
          overlay: overlayNow,
          previousOverlay: pdcaPreviousOverlay,
          noProgressStreak: parked.runtime.lifecycle.pdcaNoProgressStreak ?? 0,
          aborted,
        });
        persistPdcaOnRuntime(parked.runtime, pdca);
        pdcaLast = pdca;
        harnessStatus = mapPdcaVerdictToHarnessStatus(pdca.verdict);
      } catch {
        // Overlay read failed: do not complete from empty Todo / missing snapshot.
        if (harnessStatus === "completed") harnessStatus = "incomplete";
      }
    }
    const decision = decideCaptainEndDisposition({
      aborted,
    });
    const applied = applyCaptainEndDisposition({
      decision,
      entry: {
        conversationId: task.conversationId,
        expertId: String(task.expertId || parked.expertId || ""),
        workMode: parked.workMode,
        graphId: parked.graphId,
        stageId: parked.stageId,
        taskId: task.taskId,
        session: parked.session,
        todo: parked.todo,
        accounts: task.accounts ?? parked.accounts,
        runtime: parked.runtime,
        speechCursor: parked.speechCursor,
        dispose: parked.dispose,
      },
    });
    reparked = applied.parked;
  }

  const endTime = new Date().toISOString();
  const aborted = stop === "aborted" || cancelled();

  panel.setMainTerminal(
    aborted ? "aborted" : harnessStatus === "completed" ? "completed" : "failed",
  );

  // Spec #311 parity with Free settle (shared helper).
  const findingsDir = String(parked.runtime?.findingsDir || "").trim();
  const piDir = String(parked.runtime?.piDir || "").trim();
  const worksetSource = workMode === "graph" ? "hard_settle" : "free_settle";
  const settlePkg = await buildWorksetSettleEmitPackage({
    task,
    findingsDir,
    source: worksetSource,
  });
  if (piDir) {
    await writeAttackSurfaceCandidatesArtifact(piDir, settlePkg.attackSurfaceCandidates);
  }

  const goals = (parked.runtime?.goals as GoalStore | undefined) || obsCtx.goals;
  const goalModeOn = Boolean(goals?.isActive?.() || task.goalObjective);

  await emitCheckpointUpdate(obsCtx, {
    terminal: true,
    status: harnessStatus,
    endTime,
    attackSurfaceCandidates: settlePkg.attackSurfaceCandidates,
  }).catch(() => {});

  await platform.send({
    type: "task_complete",
    conversation_id: task.conversationId,
    task_id: task.taskId,
    status: harnessStatus,
    summary:
      aborted
        ? "Parked working session interrupted again."
        : reparked
          ? "Parked working session continue settled (captain re-parked)."
          : "Parked working session continue settled.",
    stop_reason: aborted ? "aborted" : "parked_continue",
    work_mode: workMode,
    parked_continue: true,
    session_continue: true,
    reparked,
    end_time: endTime,
    started_at: startedAt,
    attack_surface_candidates: settlePkg.attackSurfaceCandidates,
    next_scope_candidates: settlePkg.nextScopeCandidates,
    workset_candidates: [
      ...settlePkg.worksetCandidates,
      ...(parked.runtime?.lifecycle.worksetProposed || []),
    ],
    workset_source: settlePkg.worksetSource,
    goal_mode: goalModeOn,
    goal_objective: task.goalObjective || undefined,
    ...(pdcaLast
      ? {
          pdca_verdict: pdcaLast.verdict,
          pdca_unresolved: pdcaLast.unresolved,
          pdca_reason: pdcaLast.reason,
        }
      : {}),
  } as any);

  return {
    terminalStatus: harnessStatus,
    attached: true,
    workMode,
    sameRuntime: true,
    reparked,
  };
}
