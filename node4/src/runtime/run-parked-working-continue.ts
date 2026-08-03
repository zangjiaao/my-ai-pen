/**
 * Spec #283 (I0.9): run the next user turn on a parked captain working runtime.
 * Attach path only — cold reseed is the caller's fallback.
 */

import type { Node4Config } from "../config.js";
import type { PlatformSink, TaskEnvelope } from "../types.js";
import { GoalStore } from "../stores/goal.js";
import { registerActiveSession } from "./active-session-registry.js";
import {
  attachNode4SessionObservability,
  CheckpointThrottle,
  createUsageLedgerFromEnv,
  emitCheckpointUpdate,
  PlatformTextStream,
  type ObservabilityContext,
} from "./platform-observability.js";
import { PanelAgentTracker } from "./panel-agents.js";
import { extractLlmTurnError, LlmTurnError } from "./llm-turn-error.js";
import {
  decideParkOnEnd,
  parkWorkingSession,
  type ParkedWorkingRuntime,
  type WorkingWorkMode,
} from "./working-session-park.js";

export type ParkedContinueResult = {
  terminalStatus: "completed" | "incomplete" | "blocked";
  attached: true;
  workMode: WorkingWorkMode;
  sameRuntime: true;
};

/**
 * Prompt the parked captain with the continue message; re-park on interrupt.
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

  // Rebind live task/platform onto stored runtime when present.
  if (parked.runtime) {
    parked.runtime.task = task;
    parked.runtime.platform = platform;
    if (parked.runtime.lifecycle) {
      parked.runtime.lifecycle.abortSignal = signal;
    }
    // Prefer parked todo as SOT (not wipe-to-empty).
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
  if (workMode === "graph") {
    panel.setWorkMode({
      work_mode: "graph",
      graph_id: parked.graphId,
    });
  } else {
    panel.setWorkMode({ work_mode: "free" });
  }

  const usage = createUsageLedgerFromEnv();
  const textStream = new PlatformTextStream(platform, task);
  const checkpointThrottle = new CheckpointThrottle();
  const obsCounters = {
    toolCallCount: 0,
    activeTool: undefined as string | undefined,
    phase: workMode === "graph" ? "parked_graph_continue" : "parked_free_continue",
  };
  const runtimeForObs = parked.runtime || {
    task,
    workspaceDir: options.config.workspaceDir,
    taskDir: `${options.config.workspaceDir}/${task.taskId}`,
    platform,
    todo: parked.todo,
    findingsDir: `${options.config.workspaceDir}/${task.taskId}/findings`,
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
    stage_id: parked.stageId,
  } as any);

  await platform.send({
    type: "status_update",
    conversation_id: task.conversationId,
    task_id: task.taskId,
    message:
      workMode === "graph"
        ? `parked graph continue stage=${parked.stageId || "?"} graph=${parked.graphId || "?"}`
        : "parked free continue",
    agent_phase: "parked_continue",
    status: "running",
    work_mode: workMode === "graph" ? `hard_graph:${parked.graphId || "graph"}:parked` : "free",
    parked_continue: true,
  } as any);

  const session = parked.session;
  const unregister = registerActiveSession({
    conversationId: task.conversationId,
    taskId: task.taskId,
    steer: (text) => session.steer(text),
    followUp: (text) => session.followUp(text),
  });

  const sessionObs = attachNode4SessionObservability({
    session,
    obsCtx,
    textStream,
    checkpointThrottle,
    disposeTextStream: false,
  });

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
  try {
    if (cancelled()) {
      stop = "aborted";
    } else {
      await session.prompt(task.instruction || "继续");
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

    const parkDecision = decideParkOnEnd({
      aborted: stop === "aborted" || cancelled(),
      naturalComplete: stop === "completed",
    });

    if (parkDecision.disposition === "park") {
      parkWorkingSession({
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
        parkedAt: Date.now(),
        dispose: parked.dispose,
      });
    } else {
      try {
        await Promise.resolve(parked.dispose());
      } catch {
        /* ignore */
      }
    }
  }

  const endTime = new Date().toISOString();
  // Parked continue after interrupt is typically incomplete unless agent fully settled.
  // Natural stop of one continue turn without abort → incomplete (mid-work continuity),
  // so next continue can still attach if we re-parked; if we disposed on naturalComplete
  // above, terminal reflects best-effort chat complete for free.
  const harnessStatus: "completed" | "incomplete" =
    stop === "aborted" || cancelled()
      ? "incomplete"
      : workMode === "free"
        ? "completed"
        : "incomplete";

  panel.setMainTerminal(
    stop === "aborted" ? "aborted" : harnessStatus === "completed" ? "completed" : "failed",
  );
  await emitCheckpointUpdate(obsCtx, {
    terminal: true,
    status: harnessStatus,
    endTime,
  }).catch(() => {});

  await platform.send({
    type: "task_complete",
    conversation_id: task.conversationId,
    task_id: task.taskId,
    status: harnessStatus,
    summary:
      stop === "aborted"
        ? "Parked working session interrupted again."
        : "Parked working session continue settled.",
    stop_reason: stop === "aborted" ? "aborted" : "parked_continue",
    work_mode: workMode,
    parked_continue: true,
    end_time: endTime,
    started_at: startedAt,
  } as any);

  return {
    terminalStatus: harnessStatus,
    attached: true,
    workMode,
    sameRuntime: true,
  };
}
