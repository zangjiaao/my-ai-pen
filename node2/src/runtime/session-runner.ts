import { cp, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Node2Config } from "../config.js";
import { ActorStore } from "../stores/actors.js";
import { CoverageStore } from "../stores/coverage.js";
import { EvidenceStore } from "../stores/evidence.js";
import { PlanStore } from "../stores/plan.js";
import { TodoStore } from "../stores/todo.js";
import { TrafficStore } from "../stores/traffic.js";
import { createExternalTrafficSource } from "../traffic/external-source.js";
import type { PlatformMessage, PlatformSink, TaskEnvelope, ToolRuntime } from "../types.js";
import { PENTEST_TOOL_NAMES } from "../tools/index.js";
import { TaskDiagnostics } from "./agent-observability.js";
import { startCaidoBridge } from "./caido-bridge.js";
import {
  conversionMetrics,
  finishCompletedEligibility,
  formatCandidate,
  formatDiscoveryQueuePayload,
  missingRiskFamiliesFromCoverage,
  surfaceInventoryFromTraffic,
} from "./detection-conversion.js";
import { stopBrowserSandbox } from "./browser-sandbox.js";
import {
  engagementRequiresFullCoverageGate,
  isKnownPentestWorkflow,
  resolveEffectiveEngagement,
  resolveExplicitEngagement,
  workflowCatalogForPrompt,
} from "./engagement.js";
import { createPentestExtension } from "./pentest-extension.js";
import { buildSystemPrompt } from "./prompt.js";

const TEXT_STREAM_FLUSH_MS = 250;
const DEFAULT_COMPLETION_GATE_ROUNDS = 1;

/** Long-lived Pi session bound to one platform conversation. */
export type LivingPentestSession = {
  conversationId: string;
  taskId: string;
  followUp(userText: string, signal?: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
};

/**
 * Standalone / one-shot entry: run work then dispose the Pi session.
 * Prefer createLivingPentestSession for conversation-scoped multi-turn chat.
 */
export async function runPentestTask(
  config: Node2Config,
  platform: PlatformSink,
  task: TaskEnvelope,
  signal?: AbortSignal,
): Promise<void> {
  const living = await createLivingPentestSession(config, platform, task, signal);
  await living.dispose();
}

/**
 * Create a living conversation participant: runs the initial instruction, then
 * keeps the Pi session + stores so the user can keep talking (继续 / steers).
 */
export async function createLivingPentestSession(
  config: Node2Config,
  platform: PlatformSink,
  task: TaskEnvelope,
  signal?: AbortSignal,
): Promise<LivingPentestSession> {
  task = normalizeSidecarTaskTarget(config, task);
  const taskDir = join(config.workspaceDir, task.taskId);
  await mkdir(taskDir, { recursive: true });
  const diagnostics = await TaskDiagnostics.create(taskDir, task, config.llmCost);
  const platformOut = diagnostics.wrapPlatform(platform);
  const caidoBridge = await startCaidoBridge(config, platformOut, task);

  const runtime: ToolRuntime = {
    task,
    workspaceDir: config.workspaceDir,
    platform: platformOut,
    plan: new PlanStore(),
    todo: new TodoStore(),
    coverage: new CoverageStore(),
    evidence: new EvidenceStore(join(taskDir, "evidence")),
    traffic: new TrafficStore(),
    actors: new ActorStore(),
    pocCatalogPath: config.pocCatalogPath,
    workflowRuns: [],
    lifecycle: {},
    trafficProxyUrl: caidoBridge?.caidoUrl || config.trafficProxyUrl,
    externalTrafficSource: caidoBridge?.source || createExternalTrafficSource({
      url: config.externalTrafficSourceUrl,
      token: config.externalTrafficSourceToken,
    }),
    scannerSandbox: {
      enabled: config.scannerSandboxAutoStart,
      image: config.scannerSandboxImage,
    },
  };
  await syncWorkflowBundles(config, taskDir);

  const authStorage = AuthStorage.create(join(config.piAgentDir, "auth.json"));
  setRuntimeApiKey(authStorage, config.modelProvider);
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  if (config.modelProvider === "custom") {
    registerCustomModel(modelRegistry, config);
  } else if (config.llmBaseUrl) {
    modelRegistry.registerProvider(config.modelProvider, { baseUrl: config.llmBaseUrl });
  }
  const model = modelRegistry.find(config.modelProvider, config.modelId);
  if (!model) throw new Error(`model not found: ${config.modelProvider}/${config.modelId}`);

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 2 },
  });
  process.env.PI_WORKFLOW_SUBAGENT_BACKEND ??= "inline";

  // Enable in-process worker subagents that share this runtime's stores/tools.
  runtime.workerLaunch = {
    config,
    model,
    authStorage,
    modelRegistry,
    settingsManager,
    taskDir,
    mergeWorkerUsage: async (usage) => {
      await diagnostics.mergeWorkerUsage({
        requests: Number(usage.requests) || 0,
        input_tokens: Number(usage.input_tokens) || 0,
        output_tokens: Number(usage.output_tokens) || 0,
        cached_tokens: Number(usage.cached_tokens) || 0,
        cache_write_tokens: Number(usage.cache_write_tokens) || 0,
        reasoning_tokens: Number(usage.reasoning_tokens) || 0,
        total_tokens: Number(usage.total_tokens) || 0,
        cost: Number(usage.cost) || 0,
        agent_count: Number(usage.agent_count) || 1,
        model: usage.model,
        tool_calls: usage.tool_calls,
      });
    },
    noteWorker: async (type, details) => {
      await diagnostics.noteRuntime(type, details);
    },
  };

  const resourceLoader = new DefaultResourceLoader({
    cwd: taskDir,
    agentDir: config.piAgentDir,
    settingsManager,
    additionalExtensionPaths: [config.piWorkflowPackageDir],
    additionalSkillPaths: [config.pentestSkillsDir],
    extensionFactories: [createPentestExtension(runtime)],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    systemPrompt: buildSystemPrompt(task),
  });
  await resourceLoader.reload();

  // Persist Pi session entries under the task dir so stalled runs remain inspectable.
  const piSessionDir = join(taskDir, "pi-sessions");
  await mkdir(piSessionDir, { recursive: true });
  const { session } = await createAgentSession({
    cwd: taskDir,
    agentDir: config.piAgentDir,
    model,
    thinkingLevel: "medium",
    authStorage,
    modelRegistry,
    resourceLoader,
    tools: [...PENTEST_TOOL_NAMES],
    sessionManager: SessionManager.create(taskDir, piSessionDir),
    settingsManager,
  });

  const textStream = new PlatformTextStream(platformOut, task);
  const mainMaxMs = clampInt(
    Number(task.workerLimits?.mainMaxMs ?? process.env.NODE2_MAIN_MAX_MS ?? 1_800_000),
    60_000,
    7_200_000,
  );
  const mainMaxTurns = clampInt(
    Number(task.workerLimits?.mainMaxTurns ?? process.env.NODE2_MAIN_MAX_TURNS ?? 80),
    5,
    200,
  );
  let mainToolTurns = 0;
  let mainMaxTurnsReached = false;
  let mainTimedOut = false;
  let mainBudgetTimer: ReturnType<typeof setTimeout> | undefined;
  // One subscription for the whole living session; burst handlers swap in/out.
  let activeTextStream: PlatformTextStream | undefined = textStream;
  let burstOnToolStart: (() => void) | undefined = () => {
    mainToolTurns += 1;
    if (mainToolTurns >= mainMaxTurns && !mainMaxTurnsReached) {
      mainMaxTurnsReached = true;
      void diagnostics.noteRuntime("main_max_turns", { turns: mainToolTurns, max: mainMaxTurns });
      void session.abort?.();
    }
  };
  session.subscribe(async (event) => {
    if (event?.type === "tool_execution_start") {
      burstOnToolStart?.();
    }
    await diagnostics.handleAgentEvent(event);
    if (activeTextStream) await activeTextStream.handle(event);
    await handleSessionEvent(platformOut, runtime, diagnostics, event);
  });

  try {
    const abortHandler = () => {
      void diagnostics.noteRuntime("signal_abort", { reason: "user_interrupt_or_abort" });
      void diagnostics.setPhase("aborted", { reason: "abort_signal" });
      void session.abort();
    };
    signal?.addEventListener("abort", abortHandler, { once: true });
    mainBudgetTimer = setTimeout(() => {
      mainTimedOut = true;
      void diagnostics.noteRuntime("main_max_ms", { max_ms: mainMaxMs });
      void session.abort?.();
    }, mainMaxMs);
    runtime.plan.start();
    await platformOut.send({
      type: "status_update",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      workflow_stage: runtime.plan.kanban().current_stage,
      active_tool: "pi",
      agent_phase: "starting",
      status: "running",
      message: "Pi pentest runtime started",
      progress: runtime.plan.progress(),
      kanban: runtime.plan.kanban(),
      diagnostics: diagnostics.paths,
    });
    await platformOut.send({
      type: "plan_tree_updated",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      reason: "runtime.start",
      workflow_stage: runtime.plan.kanban().current_stage,
      progress: runtime.plan.progress(),
      kanban: runtime.plan.kanban(),
      plan_tree: runtime.plan.snapshot(),
    });
    if (signal?.aborted) throw new Error("Task interrupted by user.");
    await diagnostics.noteRuntime("prompt_start", {
      stage: "main",
      main_max_ms: mainMaxMs,
      main_max_turns: mainMaxTurns,
    });
    try {
      await session.prompt(buildWorkflowFirstInstruction(task), { source: "interactive" });
    } catch (error) {
      if (!mainTimedOut && !mainMaxTurnsReached) throw error;
    }
    await textStream.flush();
    await diagnostics.noteRuntime("prompt_end", { stage: "main" });
    if (mainTimedOut) {
      throw new Error(
        `Main agent timed out after ${Math.round(mainMaxMs / 1000)}s (node 运行参数 · 主 Agent 超时).`,
      );
    }
    if (mainMaxTurnsReached) {
      throw new Error(
        `Main agent stopped after max ${mainMaxTurns} tool turns (node 运行参数 · 主 Agent 轮次).`,
      );
    }
    throwIfLastAssistantError(session.messages);
    if (signal?.aborted) throw new Error("Task interrupted by user.");
    const gateRounds = completionGateRounds();
    let gate = completionGate(runtime);
    await diagnostics.noteRuntime("completion_gate_eval", {
      ok: gate.canComplete,
      summary: gate.summary,
      rounds_allowed: gateRounds,
      finish_status: runtime.lifecycle.finishScan?.status,
    });
    // Only reprompt when the agent has not yet settled the lifecycle (no finish_scan,
    // or completed was never accepted). Explicit incomplete/blocked must not thrash
    // the model back into finish_scan(completed) loops.
    for (
      let round = 0;
      !gate.canComplete && !isTerminalFinishStatus(runtime.lifecycle.finishScan?.status) && round < gateRounds;
      round += 1
    ) {
      if (mainTimedOut || mainMaxTurnsReached || signal?.aborted) break;
      const gapPrompt = completionGapPrompt(runtime, gate);
      await platformOut.send({
        type: "completion_blocked",
        conversation_id: task.conversationId,
        task_id: task.taskId,
        round: round + 1,
        audit: gate.audit,
        message: "Runtime completion gate found unresolved runtime safety checks.",
        agent_phase: "completion_gate",
      });
      await diagnostics.noteRuntime("completion_gate_reprompt", { round: round + 1, summary: gate.summary });
      try {
        await session.prompt(gapPrompt, { source: "interactive" });
      } catch (error) {
        if (!mainTimedOut && !mainMaxTurnsReached) throw error;
        break;
      }
      await textStream.flush();
      if (mainTimedOut || mainMaxTurnsReached) break;
      throwIfLastAssistantError(session.messages);
      if (signal?.aborted) throw new Error("Task interrupted by user.");
      gate = completionGate(runtime);
      await diagnostics.noteRuntime("completion_gate_eval", {
        ok: gate.canComplete,
        summary: gate.summary,
        round: round + 1,
        finish_status: runtime.lifecycle.finishScan?.status,
      });
    }
    if (mainTimedOut) {
      throw new Error(
        `Main agent timed out after ${Math.round(mainMaxMs / 1000)}s (node 运行参数 · 主 Agent 超时).`,
      );
    }
    if (mainMaxTurnsReached) {
      throw new Error(
        `Main agent stopped after max ${mainMaxTurns} tool turns (node 运行参数 · 主 Agent 轮次).`,
      );
    }

    const finishStatus = runtime.lifecycle.finishScan?.status;
    const settledIncomplete = isTerminalFinishStatus(finishStatus) && finishStatus !== "completed";
    if (!gate.canComplete || settledIncomplete) {
      runtime.plan.setPhase("report");
      const incompleteSummary =
        runtime.lifecycle.finishScan?.summary ||
        extractLastAssistantText(session.messages).slice(0, 4000) ||
        gate.summary;
      const terminalStatus = finishStatus === "blocked" ? "blocked" : "incomplete";
      // Unified terminal channel with completed path: only task_complete (status=incomplete|blocked).
      // Do not also send task_incomplete — that produced duplicate "Task incomplete" UI rows.
      await platformOut.send({
        type: "task_complete",
        conversation_id: task.conversationId,
        task_id: task.taskId,
        status: terminalStatus,
        summary: incompleteSummary,
        audit: gate.audit,
      });
      await platformOut.send({
        type: "plan_tree_updated",
        conversation_id: task.conversationId,
        task_id: task.taskId,
        reason: settledIncomplete ? "runtime.finish_incomplete" : "runtime.incomplete_summary",
        workflow_stage: runtime.plan.kanban().current_stage,
        progress: runtime.plan.progress(),
        kanban: runtime.plan.kanban(),
        plan_tree: runtime.plan.snapshot(),
      });
      await platformOut.send({
        type: "checkpoint_update",
        conversation_id: task.conversationId,
        task_id: task.taskId,
        checkpoint: await buildNode2Checkpoint(runtime, task, diagnostics),
      });
      // Fall through — keep Pi session alive for follow-up chat (do not return).
    } else {
      runtime.plan.complete();
      const completedSummary =
        runtime.lifecycle.finishScan?.summary ||
        extractLastAssistantText(session.messages).slice(0, 4000) ||
        "Task completed.";
      // task_complete must be first: platform stops billing/timer on this message.
      // Heavy checkpoint/plan_tree payloads are best-effort after status is settled.
      await platformOut.send({
        type: "task_complete",
        conversation_id: task.conversationId,
        task_id: task.taskId,
        status: "completed",
        summary: completedSummary,
      });
      await platformOut.send({
        type: "checkpoint_update",
        conversation_id: task.conversationId,
        task_id: task.taskId,
        checkpoint: await buildNode2Checkpoint(runtime, task, diagnostics),
      });
      await platformOut.send({
        type: "plan_tree_updated",
        conversation_id: task.conversationId,
        task_id: task.taskId,
        reason: "runtime.complete",
        workflow_stage: runtime.plan.kanban().current_stage,
        progress: runtime.plan.progress(),
        kanban: runtime.plan.kanban(),
        plan_tree: runtime.plan.snapshot(),
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await diagnostics.noteRuntime("task_error", { message });
    await diagnostics.setPhase("error", { error: message });
    await writeFile(
      join(taskDir, "last-error.json"),
      JSON.stringify({ ts: new Date().toISOString(), message, stack: error instanceof Error ? error.stack : undefined }, null, 2),
      "utf8",
    );
    // Notify platform but keep the Pi session alive for multi-turn follow-up.
    await platformOut.send({
      type: "task_error",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      message,
    } as PlatformMessage);
    await diagnostics.noteRuntime("task_error_kept_alive", { message });
  } finally {
    if (mainBudgetTimer) clearTimeout(mainBudgetTimer);
    await textStream.dispose();
    activeTextStream = undefined;
    burstOnToolStart = undefined;
    // Do NOT dispose session / caido / stores — living participant stays in the group chat.
    await diagnostics.noteRuntime("task_burst_end", { phase: diagnostics.snapshot().phase, keep_alive: true });
  }

  let disposed = false;
  /** Last settled terminal status for this living mind (for pure-Q&A follow-ups). */
  let lastSettledStatus: "completed" | "incomplete" | "blocked" | "failed" | undefined =
    runtime.lifecycle.finishScan?.status === "completed"
      ? "completed"
      : runtime.lifecycle.finishScan?.status === "blocked"
        ? "blocked"
        : runtime.lifecycle.finishScan?.status === "incomplete"
          ? "incomplete"
          : diagnostics.snapshot().phase === "error"
            ? "failed"
            : undefined;
  if (!lastSettledStatus && runtime.lifecycle.finishScan) {
    lastSettledStatus = "incomplete";
  }
  const living: LivingPentestSession = {
    conversationId: task.conversationId,
    taskId: task.taskId,
    async followUp(userText: string, followSignal?: AbortSignal): Promise<void> {
      if (disposed) throw new Error("Living session is disposed");
      const text = String(userText || "").trim();
      if (!text) return;
      const result = await runFollowUpBurst({
        config,
        platform,
        platformOut,
        task,
        taskDir,
        runtime,
        session,
        diagnostics,
        signal: followSignal,
        userText: text,
        priorSettledStatus: lastSettledStatus,
        attachBurst: (stream, onToolStart) => {
          activeTextStream = stream;
          burstOnToolStart = onToolStart;
        },
        detachBurst: () => {
          activeTextStream = undefined;
          burstOnToolStart = undefined;
        },
      });
      if (result.settledStatus) lastSettledStatus = result.settledStatus;
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      activeTextStream = undefined;
      burstOnToolStart = undefined;
      try {
        session.dispose();
      } catch {
        // already disposed
      }
      await stopBrowserSandbox(task.taskId).catch(() => undefined);
      await caidoBridge?.stop();
      await diagnostics.noteRuntime("living_session_disposed", {});
    },
  };
  return living;
}

/** Re-export name used by conversation-host for clarity. */
export const continueLivingPentestSession = async (
  living: LivingPentestSession,
  userText: string,
  signal?: AbortSignal,
): Promise<void> => living.followUp(userText, signal);

async function runFollowUpBurst(input: {
  config: Node2Config;
  platform: PlatformSink;
  platformOut: PlatformSink;
  task: TaskEnvelope;
  taskDir: string;
  runtime: ToolRuntime;
  session: { prompt: (text: string, opts?: { source?: string }) => Promise<void>; abort?: () => void; messages: any[] };
  diagnostics: TaskDiagnostics;
  signal?: AbortSignal;
  userText: string;
  priorSettledStatus?: "completed" | "incomplete" | "blocked" | "failed";
  attachBurst: (stream: PlatformTextStream, onToolStart: () => void) => void;
  detachBurst: () => void;
}): Promise<{ settledStatus?: "completed" | "incomplete" | "blocked" | "failed" }> {
  const { platformOut, task, runtime, session, diagnostics, signal, userText, priorSettledStatus, attachBurst, detachBurst } = input;
  // Fresh budget window for each user turn after idle — does not wipe memory.
  const mainMaxMs = clampInt(
    Number(task.workerLimits?.mainMaxMs ?? process.env.NODE2_MAIN_MAX_MS ?? 1_800_000),
    60_000,
    7_200_000,
  );
  const mainMaxTurns = clampInt(
    Number(task.workerLimits?.mainMaxTurns ?? process.env.NODE2_MAIN_MAX_TURNS ?? 80),
    5,
    200,
  );
  let mainToolTurns = 0;
  let mainMaxTurnsReached = false;
  let mainTimedOut = false;
  let mainBudgetTimer: ReturnType<typeof setTimeout> | undefined;
  const textStream = new PlatformTextStream(platformOut, task);
  // Clear previous finish so a new finish_scan can settle this burst.
  runtime.lifecycle.finishScan = undefined;
  runtime.lifecycle.finishCompletedRejects = 0;

  const abortHandler = () => {
    void diagnostics.noteRuntime("signal_abort", { reason: "user_interrupt_or_abort_follow_up" });
    void session.abort?.();
  };
  signal?.addEventListener("abort", abortHandler, { once: true });

  attachBurst(textStream, () => {
    mainToolTurns += 1;
    if (mainToolTurns >= mainMaxTurns && !mainMaxTurnsReached) {
      mainMaxTurnsReached = true;
      void diagnostics.noteRuntime("main_max_turns", { turns: mainToolTurns, max: mainMaxTurns, mode: "follow_up" });
      void session.abort?.();
    }
  });

  mainBudgetTimer = setTimeout(() => {
    mainTimedOut = true;
    void diagnostics.noteRuntime("main_max_ms", { max_ms: mainMaxMs, mode: "follow_up" });
    void session.abort?.();
  }, mainMaxMs);

  try {
    await platformOut.send({
      type: "status_update",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      workflow_stage: runtime.plan.kanban().current_stage,
      active_tool: "pi",
      agent_phase: "follow_up",
      status: "running",
      message: "Continuing in the same agent session",
      progress: runtime.plan.progress(),
      kanban: runtime.plan.kanban(),
    });
    await diagnostics.noteRuntime("prompt_start", {
      stage: "follow_up",
      main_max_ms: mainMaxMs,
      main_max_turns: mainMaxTurns,
    });
    const prompt = [
      "You are continuing the same authorized engagement in an existing multi-turn session.",
      "Your prior tool results, findings, plan, and conversation memory are still available — do not pretend this is a fresh agent.",
      "If the user asks to continue unfinished work, resume from remaining gaps and call finish_scan when the engagement outcome is settled.",
      "If the user is only asking a question, answer with tools only when needed; you may finish without finish_scan for pure Q&A.",
      "",
      "User message:",
      userText,
    ].join("\n");
    try {
      await session.prompt(prompt, { source: "interactive" });
    } catch (error) {
      if (!mainTimedOut && !mainMaxTurnsReached) throw error;
    }
    await textStream.flush();
    await diagnostics.noteRuntime("prompt_end", { stage: "follow_up" });

    if (mainTimedOut) {
      await platformOut.send({
        type: "task_error",
        conversation_id: task.conversationId,
        task_id: task.taskId,
        message: `Main agent timed out after ${Math.round(mainMaxMs / 1000)}s on follow-up (node 运行参数 · 主 Agent 超时). Session kept alive — you can send another message.`,
      } as PlatformMessage);
      return { settledStatus: "failed" };
    }
    if (mainMaxTurnsReached) {
      await platformOut.send({
        type: "task_error",
        conversation_id: task.conversationId,
        task_id: task.taskId,
        message: `Main agent stopped after max ${mainMaxTurns} tool turns on follow-up (node 运行参数 · 主 Agent 轮次). Session kept alive — send 继续 or a narrower instruction.`,
      } as PlatformMessage);
      return { settledStatus: "failed" };
    }

    const finishStatus = runtime.lifecycle.finishScan?.status;
    if (finishStatus === "completed" || finishStatus === "incomplete" || finishStatus === "blocked") {
      const summary =
        runtime.lifecycle.finishScan?.summary ||
        extractLastAssistantText(session.messages).slice(0, 4000) ||
        "Follow-up finished.";
      const settled =
        finishStatus === "completed" ? "completed" : finishStatus === "blocked" ? "blocked" : "incomplete";
      await platformOut.send({
        type: "task_complete",
        conversation_id: task.conversationId,
        task_id: task.taskId,
        status: settled,
        summary,
      } as PlatformMessage);
      await platformOut.send({
        type: "checkpoint_update",
        conversation_id: task.conversationId,
        task_id: task.taskId,
        checkpoint: await buildNode2Checkpoint(runtime, task, diagnostics),
      } as PlatformMessage);
      return { settledStatus: settled };
    }

    // Pure chat / Q&A turn: settle so billing/timer stops, keep Pi memory.
    // Map prior "failed" → incomplete on settle so a normal answer does not re-flash task_error UI.
    const restore: "completed" | "incomplete" | "blocked" =
      priorSettledStatus === "blocked"
        ? "blocked"
        : priorSettledStatus === "incomplete" || priorSettledStatus === "failed"
          ? "incomplete"
          : "completed";
    const qaSummary =
      extractLastAssistantText(session.messages).slice(0, 4000) ||
      "Answered follow-up in the same agent session.";
    await platformOut.send({
      type: "task_complete",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      status: restore,
      summary: qaSummary,
    } as PlatformMessage);
    await platformOut.send({
      type: "checkpoint_update",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      checkpoint: await buildNode2Checkpoint(runtime, task, diagnostics),
    } as PlatformMessage);
    return { settledStatus: restore };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await platformOut.send({
      type: "task_error",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      message: `${message} (session kept alive)`,
    } as PlatformMessage);
    return { settledStatus: "failed" };
  } finally {
    if (mainBudgetTimer) clearTimeout(mainBudgetTimer);
    signal?.removeEventListener("abort", abortHandler);
    await textStream.dispose();
    detachBurst();
  }
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizeSidecarTaskTarget(config: Node2Config, task: TaskEnvelope): TaskEnvelope {
  if (!config.caidoSidecarAutoStart) return task;
  const targetValue = typeof task.target?.value === "string" ? task.target.value : "";
  const normalizedTarget = dockerHostTarget(targetValue);
  if (!normalizedTarget || normalizedTarget === targetValue) return task;
  const scopeAllow = Array.isArray(task.scope?.allow) ? task.scope.allow : [];
  return {
    ...task,
    instruction: [
      task.instruction,
      "",
      `Runtime note: Caido sidecar mode remapped local target ${targetValue} to ${normalizedTarget} so Docker-based proxy tooling can reach the host service. Use the remapped URL for browser/http/traffic/verifier requests.`,
    ].join("\n"),
    target: { ...task.target, value: normalizedTarget, requested_value: targetValue },
    scope: {
      ...task.scope,
      allow: scopeAllow.map((item) => typeof item === "string" && item === targetValue ? normalizedTarget : item),
      requested_allow: scopeAllow,
    },
    snapshot: {
      ...task.snapshot,
      requested_target: targetValue,
      sidecar_target: normalizedTarget,
    },
  };
}

function dockerHostTarget(value: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return value;
    url.hostname = "host.docker.internal";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

async function syncWorkflowBundles(config: Node2Config, taskDir: string): Promise<void> {
  if (!(await exists(config.pentestWorkflowsDir))) return;
  await mkdir(join(taskDir, "workflows"), { recursive: true });
  await cp(config.pentestWorkflowsDir, join(taskDir, "workflows"), {
    recursive: true,
    force: true,
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function buildNode2Checkpoint(
  runtime: ToolRuntime,
  task: TaskEnvelope,
  diagnostics: TaskDiagnostics,
): Promise<Record<string, unknown>> {
  const diag = diagnostics.snapshot();
  const engagementInfo = resolveEffectiveEngagement(task, runtime.workflowRuns);
  const targetValue =
    typeof task.target?.value === "string"
      ? task.target.value
      : typeof task.target?.url === "string"
        ? String(task.target.url)
        : "";
  return {
    ...runtime.plan.checkpoint(),
    runtime: "node2-pi",
    tool_names: PENTEST_TOOL_NAMES,
    workflows: runtime.workflowRuns,
    lifecycle: runtime.lifecycle,
    coverage: await runtime.coverage.summary(),
    evidence: await runtime.evidence.list(),
    diagnostics: diag,
    // Panel parity fields (Node3-shaped run/agent synthesis on the platform).
    scan_mode: task.scanMode,
    engagement: engagementInfo.engagement,
    started_at: diag.startedAt,
    task_target: task.target,
    targets_info: targetValue
      ? [{ type: "url", target: targetValue, original: targetValue }]
      : [],
    panel_agents: buildPanelAgents(runtime, diag),
    worker_runs: runtime.lifecycle.workerRuns || [],
    llm_usage: diagnostics.llmUsage(),
  };
}

/** Build Node3-shaped panel_agents (main + worker runs) for checkpoint/right panel. */
export function buildPanelAgents(
  runtime: ToolRuntime,
  diag: { phase: string; activeTool?: string },
): Array<Record<string, unknown>> {
  const terminal = diag.phase === "finished" || diag.phase === "error" || diag.phase === "aborted";
  const agents: Array<Record<string, unknown>> = [
    {
      id: "node2-main",
      name: "Main Agent",
      status: terminal ? "completed" : "running",
      parent_id: null,
      task: runtime.task.instruction?.slice(0, 240) || "Authorized security task",
      skills: [],
      pending_count: 0,
      role: "main",
      current_tool: diag.activeTool || "",
      current_action: diag.phase || "",
    },
  ];
  for (const run of runtime.lifecycle.workerRuns || []) {
    const outcome = run.outcome || (run.ok ? "completed" : /timed out|timeout/i.test(String(run.error || "")) ? "timeout" : "failed");
    const panelStatus =
      outcome === "completed" ? "completed" : outcome === "timeout" ? "timed_out" : outcome === "aborted" ? "stopped" : "failed";
    agents.push({
      id: run.workerId,
      name: `Worker ${run.role}`,
      status: panelStatus,
      parent_id: "node2-main",
      task: run.task?.slice(0, 240) || "",
      skills: [],
      pending_count: 0,
      role: run.role,
      current_tool: "",
      current_action: outcome,
      outcome,
      duration_ms: run.durationMs,
      tool_call_count: run.toolCallCount,
      error: run.error,
    });
  }
  return agents;
}

function buildWorkflowFirstInstruction(task: TaskEnvelope): string {
  const scanMode = task.scanMode || "standard";
  const explicit = resolveExplicitEngagement(task);
  const lines: string[] = [
    "Start by selecting the correct pi-workflow for this task, then execute its brief with Node2 tools.",
    `Scan intensity: ${scanMode}. ${scanModeGuidance(scanMode)} (intensity is independent of engagement/workflow choice).`,
  ];

  if (explicit) {
    lines.push(
      `Structured engagement="${explicit.engagement}" → use workflow_run with workflow="${explicit.workflow}", thinking="low".`,
      "Preserve target, scope, and the user instruction in the workflow task payload.",
    );
  } else {
    lines.push(
      "No structured engagement field was provided. Understand the user's instruction and choose the matching workflow yourself (LLM judgment — do not apply a rigid keyword table).",
      workflowCatalogForPrompt(),
      'Call workflow_run with workflow="<chosen>", thinking="low", and a concrete task preserving the user instruction.',
    );
  }

  lines.push(
    "After the workflow returns, follow that engagement only:",
    "- pentest-web (assess): workflow_run brief → seed intentional Tasks with coverage(plan) from workPackages/steps → dispatch worker packages (STRICT: one role + 1–2 endpoints each; multi-surface mega-packages are rejected) → update plan status running→done per package → on worker timeout, re-dispatch a narrower package or main-session probes → coverage(next_work) to fill family gaps → main agent finish_scan. Never bulk-skip only to force completed. Do not finish_scan(completed) while timeout/failed worker packages or open checklist items remain.",
    "- Auth walls: before blocking captcha/admin/IDOR paths for 'no credentials', attempt an explicit credential path (register, known demo accounts from the app, session from traffic, authorized secret recovery). Put credential work in its own step/package.",
    "- Stored XSS / OOB: without a callback URL or admin-bot environment, document the environment gap (blocked/incomplete) instead of claiming full impact proof.",
    "- pentest-verify: seed plan steps from verificationSteps; mark each running/done as you probe; finish when confirmed, disproven, or blocked — do not full-site sweep.",
    "- pentest-retest: seed plan steps from retestSteps; mark each running/done while replaying the prior path; report still-vulnerable vs fixed.",
    "- pentest-consult: seed a short answer plan (outline → draft sections → final summary); mark steps done as the answer is produced; live tools only if authorized and necessary.",
    "Plan ownership: YOU maintain the user-facing Tasks checklist with coverage(plan) during execution. Do not invent work only at the end or leave every item pending until finish_scan.",
    "Use browser/http/scan/actor/traffic/verifier/finding as appropriate to the chosen engagement.",
    "Prefer scan for established tools (httpx, katana, nuclei, nmap, ffuf, sqlmap, …) via the scanner sandbox when discovery is in scope.",
    "When verifier returns confirmed=true with evidence_id, call finding(action='confirm') immediately with that evidence_id and finding_kind='vuln' (or flag/auth if the artifact is a token/secret).",
    "Vuln, Flag, and Key are independent finding objects — never combine a vulnerability write-up and a captured flag/secret into one confirm; use separate finding(confirm) calls.",
    "Call finish_scan only when ready to end the lifecycle:",
    "- status=completed only if high-priority coverage is resolved (tried/failed/passed or substantive skip/block notes), assess multi-actor/surface gates are met when applicable, and every intentional checklist item is done/blocked/skipped.",
    "- If material work remains, call finish_scan(status='incomplete') ONCE — do not spam finish_scan(completed) or bulk-skip to force completed.",
    "- After a worker timeout: prefer one narrower re-dispatch; if retries are exhausted the package is failed — apply the advice in plan notes (split endpoints, raise node worker timeout in 节点管理, or mark incomplete with blockers).",
    "Completion gates follow the engagement of the workflow you ran (or explicit task.engagement).",
    "",
    "Original user instruction:",
    task.instruction || "Run an authorized web security task against the target and report outcomes with evidence.",
  );
  return lines.join("\n");
}

function scanModeGuidance(scanMode: string): string {
  if (scanMode === "quick") {
    return "Prioritize reachability, login/session capture, high-signal endpoint discovery, and deterministic checks for the most likely high-impact issues under a tight timebox.";
  }
  if (scanMode === "deep") {
    return "After scan-first recon, broaden endpoint/parameter enumeration, try chained or bypass-oriented checks, and document meaningful negatives without creating broad upfront matrices.";
  }
  return "Run balanced scan-first recon, select plausible vulnerability classes from observed attack surface, and verify findings with deterministic evidence.";
}

function completionGateRounds(): number {
  const raw = Number(process.env.NODE2_COMPLETION_GATE_ROUNDS || DEFAULT_COMPLETION_GATE_ROUNDS);
  if (!Number.isFinite(raw)) return DEFAULT_COMPLETION_GATE_ROUNDS;
  return Math.max(0, Math.min(Math.floor(raw), 8));
}

function completionGate(runtime: ToolRuntime): { canComplete: boolean; audit: Record<string, unknown>; summary: string } {
  const engagementInfo = resolveEffectiveEngagement(runtime.task, runtime.workflowRuns);
  const planAudit = runtime.plan.audit();
  const workflowAudit = workflowCompletionAudit(runtime);
  const finishAudit = finishScanAudit(runtime);
  const coverageAudit = coverageCompletionAudit(runtime, engagementInfo.engagement);
  const summary = [planAudit.summary, workflowAudit.summary, finishAudit.summary, coverageAudit.summary].filter(Boolean).join("; ");
  return {
    canComplete: planAudit.canComplete && workflowAudit.canComplete && finishAudit.canComplete && coverageAudit.canComplete,
    audit: {
      ...planAudit,
      engagement: engagementInfo,
      workflow: workflowAudit,
      finish_scan: finishAudit,
      coverage: coverageAudit,
      summary,
    },
    summary,
  };
}

function coverageCompletionAudit(
  runtime: ToolRuntime,
  engagement: string,
): {
  canComplete: boolean;
  summary: string;
  unresolved: unknown[];
  conversion?: unknown;
  missingRiskFamilies?: unknown[];
} {
  if (!engagementRequiresFullCoverageGate(engagement as import("./engagement.js").Engagement)) {
    return {
      canComplete: true,
      summary: `${engagement} engagement: full-site coverage conversion gate not required`,
      unresolved: [],
    };
  }
  // Explicit incomplete/blocked finish already waived full-site conversion for task end.
  const finishStatus = runtime.lifecycle.finishScan?.status;
  if (finishStatus === "incomplete" || finishStatus === "blocked") {
    return {
      canComplete: true,
      summary: `coverage conversion not required after finish_scan(${finishStatus})`,
      unresolved: [],
    };
  }
  const rows = runtime.coverage.listSync?.() || [];
  const actorSummary = runtime.actors?.summary?.() ?? { count: runtime.actors?.count() ?? 0, actors: [] as Array<{ hasAuth?: boolean }> };
  const actorAuthCount = Array.isArray(actorSummary.actors)
    ? actorSummary.actors.filter((actor) => Boolean(actor?.hasAuth)).length
    : Number(actorSummary.count || 0);
  const eligibility = finishCompletedEligibility(rows, {
    status: "completed",
    actorCount: Number(actorSummary.count || 0),
    actorAuthCount,
    engagement,
    surfaceInventory: surfaceInventoryFromTraffic(runtime.traffic),
  });
  const metrics = conversionMetrics(rows);
  if (eligibility.allowed) {
    return {
      canComplete: true,
      summary: "high-priority coverage, risk families, multi-actor, and surface quality resolved or absent",
      unresolved: [],
      conversion: metrics,
      missingRiskFamilies: [],
    };
  }
  return {
    canComplete: false,
    summary: eligibility.reason,
    unresolved: eligibility.untestedHighPriority.slice(0, 20).map(formatCandidate),
    conversion: metrics,
    missingRiskFamilies: eligibility.missingRiskFamilies,
  };
}

function isTerminalFinishStatus(status: string | undefined): boolean {
  return status === "completed" || status === "incomplete" || status === "blocked";
}

function finishScanAudit(runtime: ToolRuntime): { canComplete: boolean; summary: string; finishScan?: unknown } {
  const finishScan = runtime.lifecycle.finishScan;
  if (!finishScan) return { canComplete: false, summary: "finish_scan has not been called" };
  // incomplete/blocked are valid terminal lifecycle outcomes — do not force the agent
  // to keep retrying finish_scan(completed) against conversion gates.
  if (finishScan.status === "incomplete" || finishScan.status === "blocked") {
    return {
      canComplete: true,
      summary: `finish_scan settled as ${finishScan.status} (terminal incomplete lifecycle)`,
      finishScan,
    };
  }
  if (finishScan.status !== "completed") {
    return {
      canComplete: false,
      summary: `finish_scan requested ${finishScan.status}`,
      finishScan,
    };
  }
  const rows = runtime.coverage.listSync?.() || [];
  const engagementInfo = resolveEffectiveEngagement(runtime.task, runtime.workflowRuns);
  const actorSummary = runtime.actors?.summary?.() ?? { count: runtime.actors?.count() ?? 0, actors: [] as Array<{ hasAuth?: boolean }> };
  const actorAuthCount = Array.isArray(actorSummary.actors)
    ? actorSummary.actors.filter((actor) => Boolean(actor?.hasAuth)).length
    : Number(actorSummary.count || 0);
  const eligibility = finishCompletedEligibility(rows, {
    status: "completed",
    actorCount: Number(actorSummary.count || 0),
    actorAuthCount,
    engagement: engagementInfo.engagement,
    surfaceInventory: surfaceInventoryFromTraffic(runtime.traffic),
  });
  if (!eligibility.allowed) {
    return {
      canComplete: false,
      summary: eligibility.reason,
      finishScan,
    };
  }
  return {
    canComplete: true,
    summary: `finish_scan completed (engagement=${engagementInfo.engagement})`,
    finishScan,
  };
}

function workflowCompletionAudit(runtime: ToolRuntime): { canComplete: boolean; summary: string; runs: unknown[] } {
  const explicit = resolveExplicitEngagement(runtime.task);
  const runs = runtime.workflowRuns.filter(
    (run) => isKnownPentestWorkflow(run.specPath) || isKnownPentestWorkflow(run.openCommand) || !run.specPath,
  );
  const completedKnown = runs.filter((run) => run.status === "completed" && (isKnownPentestWorkflow(run.specPath) || isKnownPentestWorkflow(run.openCommand)));
  if (explicit) {
    const expected = explicit.workflow;
    const match = completedKnown.some(
      (run) =>
        (run.specPath && run.specPath.includes(expected)) ||
        (run.openCommand && run.openCommand.includes(expected)),
    );
    // Also accept completed run with empty specPath if only one workflow completed and name unknown — prefer strict match.
    if (match) return { canComplete: true, summary: `${expected} workflow completed`, runs };
    if (runs.length === 0) return { canComplete: false, summary: `${expected} workflow has not run`, runs };
    return {
      canComplete: false,
      summary: `${expected} workflow did not complete; latest status=${runs[runs.length - 1]?.status || "unknown"}`,
      runs,
    };
  }
  if (completedKnown.length > 0) {
    return {
      canComplete: true,
      summary: `engagement workflow completed (${completedKnown[completedKnown.length - 1]?.specPath || "known"})`,
      runs,
    };
  }
  if (runs.length === 0) return { canComplete: false, summary: "no engagement pi-workflow has run yet", runs };
  return {
    canComplete: false,
    summary: `engagement workflow did not complete; latest status=${runs[runs.length - 1]?.status || "unknown"}`,
    runs,
  };
}

function completionGapPrompt(runtime: ToolRuntime, gate: { audit: Record<string, unknown>; summary: string }): string {
  const workflow = gate.audit.workflow as { canComplete?: boolean; summary?: string } | undefined;
  const finishScan = gate.audit.finish_scan as { canComplete?: boolean; summary?: string } | undefined;
  const coverage = gate.audit.coverage as {
    canComplete?: boolean;
    summary?: string;
    unresolved?: any[];
    missingRiskFamilies?: import("./detection-conversion.js").RiskFamilyGap[];
  } | undefined;
  const parts = [runtime.plan.gapPrompt()];
  if (workflow && !workflow.canComplete) {
    const engagementInfo = resolveEffectiveEngagement(runtime.task, runtime.workflowRuns);
    const expected = resolveExplicitEngagement(runtime.task)?.workflow || engagementInfo.workflow;
    parts.push(
      [
        "",
        "The mandatory engagement pi-workflow completion gate is still unresolved.",
        workflow.summary || "engagement workflow has not completed.",
        `Run workflow_run with the workflow that matches the user's intent (expected or preferred: "${expected}"), thinking="low", wait for it to complete, then execute its brief with Node2 tools before summarizing.`,
        workflowCatalogForPrompt(),
      ].join("\n"),
    );
  }
  if (finishScan && !finishScan.canComplete) {
    const alreadyIncomplete = /finish_scan requested (incomplete|blocked)/i.test(String(finishScan.summary || ""));
    parts.push(
      [
        "",
        "The mandatory finish_scan lifecycle gate is still unresolved.",
        finishScan.summary || "finish_scan has not been called.",
        alreadyIncomplete
          ? "Lifecycle is already incomplete/blocked — do not retry finish_scan(completed). Stop tool loops; the runtime will settle the task."
          : "If high-priority conversion gaps remain and cannot be cleared with live probes, call finish_scan(status='incomplete') ONCE with a concise summary of what was done and what remains. " +
            "Only use status='completed' when conversion/multi-actor/surface gates are actually satisfied. Do not spam finish_scan.",
      ].join("\n"),
    );
  }
  if (coverage && !coverage.canComplete) {
    const unresolved = Array.isArray(coverage.unresolved) ? coverage.unresolved.slice(0, 12) : [];
    const rows = runtime.coverage.listSync?.() || [];
    const familyGaps =
      Array.isArray(coverage.missingRiskFamilies) && coverage.missingRiskFamilies.length > 0
        ? coverage.missingRiskFamilies
        : missingRiskFamiliesFromCoverage(rows);
    const inventory = surfaceInventoryFromTraffic(runtime.traffic);
    const actorSummary = runtime.actors?.summary?.() ?? { count: runtime.actors?.count() ?? 0, actors: [] as Array<{ hasAuth?: boolean }> };
    const actorAuthCount = Array.isArray(actorSummary.actors)
      ? actorSummary.actors.filter((actor) => Boolean(actor?.hasAuth)).length
      : Number(actorSummary.count || 0);
    const queue = formatDiscoveryQueuePayload(rows, {
      familyGaps,
      surfaceInventory: inventory,
      actorCount: Number(actorSummary.count || 0),
      actorAuthCount,
      limit: 8,
    });
    parts.push(
      [
        "",
        "Coverage / assess-quality gate still open — run coverage(action='next_work') and execute live probes.",
        coverage.summary || "Unresolved high-priority coverage or multi-actor/surface gaps remain.",
        queue.guidance,
        ...unresolved.slice(0, 6).map((row) => `- ${typeof row === "string" ? row : formatCandidate(row as any)}`),
      ].join("\n"),
    );
  }
  return parts.join("\n");
}

async function handleSessionEvent(
  platform: PlatformSink,
  runtime: ToolRuntime,
  diagnostics: TaskDiagnostics,
  event: any,
): Promise<void> {
  const state = diagnostics.snapshot();
  if (event.type === "turn_start") {
    await platform.send({
      type: "status_update",
      conversation_id: runtime.task.conversationId,
      task_id: runtime.task.taskId,
      workflow_stage: runtime.plan.kanban().current_stage,
      active_tool: "pi",
      agent_phase: "llm_waiting",
      status: "running",
      turn: state.turn,
      progress: runtime.plan.progress(),
      kanban: runtime.plan.kanban(),
      llm_usage: diagnostics.llmUsage(),
    } as PlatformMessage);
  }
  // Throttled mid-run checkpoint so the right panel can refresh tokens/cost live.
  if (
    (event.type === "turn_end" || (event.type === "message_end" && event.message?.role === "assistant")) &&
    diagnostics.shouldEmitUsageCheckpoint()
  ) {
    await platform.send({
      type: "checkpoint_update",
      conversation_id: runtime.task.conversationId,
      task_id: runtime.task.taskId,
      checkpoint: await buildNode2Checkpoint(runtime, runtime.task, diagnostics),
    } as PlatformMessage);
  }
  if (event.type === "tool_execution_start") {
    await platform.send({
      type: "status_update",
      conversation_id: runtime.task.conversationId,
      task_id: runtime.task.taskId,
      workflow_stage: runtime.plan.kanban().current_stage,
      active_tool: String(event.toolName || "tool"),
      agent_phase: "tool_running",
      status: "running",
      tool_run_id: event.toolCallId,
      turn: state.turn,
      progress: runtime.plan.progress(),
      kanban: runtime.plan.kanban(),
    } as PlatformMessage);
  }
  if (event.type === "tool_execution_end") {
    await platform.send({
      type: "status_update",
      conversation_id: runtime.task.conversationId,
      task_id: runtime.task.taskId,
      workflow_stage: runtime.plan.kanban().current_stage,
      active_tool: String(event.toolName || "tool"),
      agent_phase: "llm_waiting",
      status: event.isError ? "tool_error" : "running",
      tool_run_id: event.toolCallId,
      turn: state.turn,
      progress: runtime.plan.progress(),
      kanban: runtime.plan.kanban(),
    } as PlatformMessage);
  }
  if (event.type === "agent_end") {
    await platform.send({
      type: "status_update",
      conversation_id: runtime.task.conversationId,
      task_id: runtime.task.taskId,
      workflow_stage: runtime.plan.kanban().current_stage,
      active_tool: "pi",
      agent_phase: "agent_end",
      status: "running",
      turn: state.turn,
      progress: runtime.plan.progress(),
      kanban: runtime.plan.kanban(),
    } as PlatformMessage);
    await platform.send({
      type: "plan_tree_updated",
      conversation_id: runtime.task.conversationId,
      task_id: runtime.task.taskId,
      reason: "agent.end",
      workflow_stage: runtime.plan.kanban().current_stage,
      progress: runtime.plan.progress(),
      kanban: runtime.plan.kanban(),
      plan_tree: runtime.plan.snapshot(),
    } as PlatformMessage);
  }
  if (event.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason === "error") {
    await platform.send({
      type: "model_error",
      conversation_id: runtime.task.conversationId,
      task_id: runtime.task.taskId,
      message: event.message.errorMessage || "Assistant model returned an error.",
      agent_phase: "error",
      workflow_stage: runtime.plan.kanban().current_stage,
      progress: runtime.plan.progress(),
      kanban: runtime.plan.kanban(),
    } as PlatformMessage);
  }
}

function setRuntimeApiKey(authStorage: any, provider: string): void {
  const key = providerKey(provider);
  if (key) authStorage.setRuntimeApiKey(provider as any, key);
}

function providerKey(provider: string): string {
  const normalized = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return process.env[`${normalized}_API_KEY`] || process.env.LLM_API_KEY || "";
}

class PlatformTextStream {
  private sequence = 0;
  private streamId = "";
  private text = "";
  private lastSentText = "";
  private timer: NodeJS.Timeout | undefined;
  private sending: Promise<void> = Promise.resolve();

  constructor(
    private readonly platform: PlatformSink,
    private readonly task: TaskEnvelope,
  ) {}

  async handle(event: any): Promise<void> {
    if (event.type === "message_start" && event.message?.role === "assistant") {
      this.startStream();
      this.text = assistantText(event.message);
      await this.scheduleFlush();
      return;
    }

    if (event.type === "message_update" && event.message?.role === "assistant") {
      if (!this.streamId) this.startStream();
      if (event.assistantMessageEvent?.type === "text_delta") {
        this.text += String(event.assistantMessageEvent.delta || "");
      } else {
        this.text = assistantText(event.message) || this.text;
      }
      await this.scheduleFlush();
      return;
    }

    if (event.type === "message_end" && event.message?.role === "assistant") {
      if (!this.streamId) this.startStream();
      this.text = assistantText(event.message) || this.text;
      await this.flush();
      this.streamId = "";
      this.text = "";
      this.lastSentText = "";
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.streamId || !this.text || this.text === this.lastSentText) return this.sending;

    const text = this.text;
    const streamId = this.streamId;
    this.lastSentText = text;
    this.sending = this.sending.then(() =>
      this.platform.send({
        type: "text",
        conversation_id: this.task.conversationId,
        task_id: this.task.taskId,
        content: { text, stream_id: streamId },
      } as PlatformMessage),
    );
    return this.sending;
  }

  async dispose(): Promise<void> {
    await this.flush();
  }

  private startStream(): void {
    this.sequence += 1;
    this.streamId = `${this.task.taskId}:assistant:${this.sequence}`;
    this.text = "";
    this.lastSentText = "";
  }

  private async scheduleFlush(): Promise<void> {
    if (this.timer || !this.streamId || !this.text) return;
    this.timer = setTimeout(() => {
      void this.flush();
    }, TEXT_STREAM_FLUSH_MS);
  }
}

function assistantText(message: any): string {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((item: any) => item?.type === "text")
    .map((item: any) => String(item.text || ""))
    .join("\n");
}

function registerCustomModel(modelRegistry: ModelRegistry, config: Node2Config): void {
  if (!config.llmBaseUrl) {
    throw new Error("LLM_BASE_URL is required when PI_MODEL_PROVIDER=custom");
  }

  const rates = config.llmCost;
  modelRegistry.registerProvider("custom", {
    name: "Custom LLM",
    baseUrl: config.llmBaseUrl,
    api: (config.llmApi || "openai-completions") as any,
    apiKey: "$LLM_API_KEY",
    models: [
      {
        id: config.modelId,
        name: config.modelId,
        reasoning: false,
        input: ["text"],
        // Pi calculateCost uses these USD-per-1M rates on each assistant usage block.
        cost: {
          input: rates.input,
          output: rates.output,
          cacheRead: rates.cacheRead,
          cacheWrite: rates.cacheWrite,
        },
        contextWindow: Number(process.env.LLM_CONTEXT_WINDOW || 128000),
        maxTokens: Number(process.env.LLM_MAX_TOKENS || 8192),
      },
    ],
  });
}

function extractLastAssistantText(messages: any[]): string {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    return message.content
      .filter((item: any) => item.type === "text")
      .map((item: any) => item.text || "")
      .join("\n")
      .trim();
  }
  return "";
}

function throwIfLastAssistantError(messages: any[]): void {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue;
    if (message.stopReason === "error") {
      throw new Error(`Model error: ${message.errorMessage || "assistant stopped with error"}`);
    }
    return;
  }
}
