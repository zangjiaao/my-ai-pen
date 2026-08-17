import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { Node4Config } from "../config.js";
import { node4Root } from "../config.js";
import { resolveRolePack } from "../roles/index.js";
import { EvidenceStore } from "../stores/evidence.js";
import { GoalStore } from "../stores/goal.js";
import { ProcessFactStore } from "../stores/process-fact.js";
import { SurfaceLedgerStore } from "../stores/surface-ledger.js";
import { SurfaceSqliteStore } from "../stores/surface-sqlite.js";
import { SkillStore } from "../stores/skill.js";
import { TodoStore } from "../stores/todo.js";
import { createProcessQualityState } from "./package-honesty-host.js";
import type { PlatformSink, TaskEnvelope, ToolRuntime } from "../types.js";
import { toolNamesForPack } from "../tools/index.js";
import { loadConfirmedFindings } from "../tools/finding.js";
import { createBoundNode4Session, type Node4AgentSession } from "./run-node4-agent.js";
import { registerActiveSession } from "./active-session-registry.js";
import { resolveTerminalTaskStatus } from "./harness-settlement.js";
import {
  composeContinuePrompt,
  resolveHarnessTerminalStatus,
  evaluateContinueAfterSegment,
  resolveOuterContinueBudgets,
  normalizeProductStopReason,
} from "./loop-policy.js";
import { selectNewUntestedSurfaces } from "./surface-harness.js";
import { buildSystemPrompt } from "./prompt.js";
import { writePostRunInspectArtifacts } from "./session-inspect.js";
import { SubagentHost } from "./subagent.js";
import { resetMidRunTodoCycle, createMidRunTodoTracker } from "./todo-harness.js";
import {
  applyMainActToolFilter,
  buildPentestGraphContext,
  freePentestGraphResolution,
  resolveGraphIdFromTask,
} from "./pentest-graph.js";
import {
  formatGraphL1CatalogInjection,
  isContinueInEnvelopeExecution,
  loadProductGraphL1Catalog,
  resolveExpertWorkPath,
  resolveHardGraph,
  unavailableGraphTerminal,
} from "./hard-graph-definition.js";
import { runHardGraphExpertTask } from "./hard-graph-task.js";
import {
  holdBrowserSandboxSeat,
  releaseBrowserSandboxSeat,
  resolveBrowserSandboxSeat,
} from "./browser-sandbox.js";
import { runTaskResourceCleanup } from "./task-resource-cleanup.js";
import {
  buildGoalBudgetLimitPrompt,
  buildGoalContinuationPrompt,
} from "../stores/goal.js";
import { PanelAgentTracker } from "./panel-agents.js";
import {
  attachNode4SessionObservability,
  CheckpointThrottle,
  createUsageLedgerFromEnv,
  emitCheckpointUpdate,
  PlatformTextStream,
  type ObservabilityContext,
} from "./platform-observability.js";
import {
  recordToolingHealthAtTaskStart,
  shouldEmitToolingHealth,
} from "./tooling-health.js";
import {
  buildWorksetSettleEmitPackage,
  writeAttackSurfaceCandidatesArtifact,
} from "./workset-settle-emit.js";
import { extractLlmTurnError } from "./llm-turn-error.js";
import {
  idleTimeoutLlmTurnError,
  mapPromptFailureToLlmTurnError,
  surfaceLlmTurnFailure,
} from "./llm-turn-surface.js";
import {
  applyCaptainEndDisposition,
  decideParkOnEnd,
  dropParkedSession,
  parkNeedsAgentReseed,
  resolveWorkingSessionContinue,
} from "./working-session-park.js";
import { runParkedWorkingContinue } from "./run-parked-working-continue.js";
import { formatCaseSpeechHarness, selectCaseSpeechDelta } from "./case-speech.js";
import type { TodoStore as TodoStoreType } from "../stores/todo.js";
import { seedTodoFromHandoff } from "./handoff-todo-seed.js";
import { seedSurfacesFromTargetAtTaskStart } from "./surface-target-seed.js";

export async function runNode4Task(
  config: Node4Config,
  platform: PlatformSink,
  task: TaskEnvelope,
  signal?: AbortSignal,
): Promise<{ terminalStatus: string; taskDir: string }> {
  const taskDir = join(config.workspaceDir, task.taskId);
  await mkdir(taskDir, { recursive: true });
  await mkdir(join(taskDir, "evidence"), { recursive: true });
  await mkdir(join(taskDir, "findings"), { recursive: true });
  await mkdir(join(taskDir, "scripts"), { recursive: true });
  await mkdir(join(taskDir, "subagents"), { recursive: true });
  await mkdir(join(taskDir, "facts"), { recursive: true });
  await mkdir(join(taskDir, "surfaces"), { recursive: true });
  await mkdir(join(taskDir, "tool-output"), { recursive: true });

  const roleResolved = resolveRolePack({ engagement: task.engagement, role: task.role });
  const pack = roleResolved.pack;
  if (roleResolved.blocked) {
    const msg = `Expert pack '${roleResolved.requested}' is not installed on this node. Install from catalog (expert-cli install) or use an offered engagement. Effective default is pentest.`;
    await platform.send({
      type: "task_error",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      message: msg,
    } as any);
    return { terminalStatus: "failed", taskDir };
  }
  /** Work-burst wall clock: right-panel Elapsed uses started_at → end_time (task lifecycle hooks). */
  const startedAt = new Date().toISOString();
  /**
   * Chat-only turn: built-in default seat, or expert without authorized target/scope.
   * Execution work bursts must NOT auto-start — respond conversationally (and use ledger tools for default).
   */
  const chatOnly = isChatOnlyTask(task, pack.id);
  /** default/consult/workspace: chat + ledger/report tools (not recon). Multi-tool work is in-loop, not outer continue. */
  const ledgerAssistSeat = isLedgerAssistSeat(pack.id);

  const eventsPath = join(taskDir, "events.jsonl");
  await writeFile(eventsPath, "", "utf8");
  /** High-frequency frames must not wait on workspace disk (WSL /mnt is slow). */
  const STREAM_TYPES = new Set(["text", "tool_output", "thinking", "agent_thinking", "status_update"]);
  const loggingPlatform: PlatformSink = {
    async send(message) {
      const line = `${JSON.stringify({ ts: new Date().toISOString(), ...message })}\n`;
      const typ = String((message as { type?: string }).type || "");
      if (STREAM_TYPES.has(typ)) {
        // Fire-and-forget: live UI must not queue behind appendFile.
        void appendFile(eventsPath, line, "utf8").catch(() => {});
      } else {
        await appendFile(eventsPath, line, "utf8").catch(() => {});
      }
      await platform.send(message);
    },
  };

  /**
   * Spec #283 I0.9: resolve park attach **before** allocating cold Free runtime stores
   * (empty TodoStore / goals / subagent host) so reseed-only paths build those.
   */
  const packRootForHard = pack.packRoot;
  const hardResolved = await resolveHardGraph({
    task,
    packRoot: packRootForHard,
    packId: pack.id,
    env: process.env,
  });
  const continueInEnvelope = isContinueInEnvelopeExecution({
    graphExecution: task.graphExecution,
  });
  const workPath = resolveExpertWorkPath({
    hardMode: hardResolved.mode,
    graphIntent: resolveGraphIdFromTask(task),
    chatOnly,
    ledgerAssistSeat,
    continueInEnvelope,
  });
  const sessionWorkModeForPark: "free" | "graph" =
    workPath.path === "hard" && hardResolved.mode === "hard" ? "graph" : "free";
  // Spec #354 S4: Session Delete handoff must not revive a ghost park.
  // Only `pendingHandoff` (hold consume) drops park — bare `pendingHandoffTodos`
  // is also used for Free cold-continue seed and must not kill a live park attach.
  if ((task as { pendingHandoff?: boolean }).pendingHandoff === true) {
    await dropParkedSession(task.conversationId, task.expertId || pack.id);
  }

  const parkContinue = resolveWorkingSessionContinue({
    conversationId: task.conversationId,
    expertId: task.expertId || pack.id,
    sessionWorkMode: sessionWorkModeForPark,
    continueInEnvelope,
  });
  /** Spec #354 L9: post-Reset parks keep Todo but need a fresh pi-agent-core Agent. */
  let handoffTodo: TodoStoreType | undefined;
  /** After Reset: mint/bind a new Agent.sessionId (pi /new style), do not reuse disposed id. */
  let reseedAgentSessionId: string | undefined;
  if (parkContinue.action === "attach") {
    if (parkNeedsAgentReseed(parkContinue.entry)) {
      handoffTodo = parkContinue.entry.todo;
      reseedAgentSessionId =
        String(parkContinue.entry.agentSessionId || parkContinue.entry.session?.sessionId || "").trim() ||
        undefined;
      // Shell park already consumed by resolveWorkingSessionContinue; reseed reuses Todo.
    } else {
      const parkedOut = await runParkedWorkingContinue({
        config,
        platform: loggingPlatform,
        task,
        parked: parkContinue.entry,
        signal,
      });
      return { terminalStatus: parkedOut.terminalStatus, taskDir };
    }
  }

  // --- Cold reseed path only (no park attach) ---
  const goals = new GoalStore();
  const panelLabel =
    (typeof task.expertName === "string" && task.expertName.trim()) ||
    (pack.id && pack.id !== "runtime" ? pack.id : "Expert");
  const panel = new PanelAgentTracker(task.instruction || "Authorized security task", panelLabel);
  // Free path: main row shows Free (Graph path sets graph badge in hard-graph-task).
  panel.setWorkMode({ work_mode: "free" });
  const usage = createUsageLedgerFromEnv();
  const textStream = new PlatformTextStream(loggingPlatform, task);
  const checkpointThrottle = new CheckpointThrottle();
  // Pack-scoped skills under experts/<id>/skills (catalog or install copy)
  // Pack-scoped skills only when an expert is installed (bare runtime has none)
  const skillsDir = (pack as { skillsRoot?: string }).skillsRoot;
  const skills = skillsDir ? new SkillStore(skillsDir) : undefined;
  const processFacts = new ProcessFactStore(join(taskDir, "facts"));
  await processFacts.ensureDir();
  // Spec #370–#371: SQLite is surface tool + Graph gate SoT (offline ok).
  // Legacy JSON still opened for one-shot migrate via store.open() and test fallbacks.
  const surfaceLedger = new SurfaceLedgerStore(SurfaceLedgerStore.pathFromTaskDir(taskDir));
  await surfaceLedger.ensureDir();
  await surfaceLedger.load();
  const surfaceSqlite = new SurfaceSqliteStore(SurfaceSqliteStore.pathFromTaskDir(taskDir));
  await surfaceSqlite.open();

  const runtime: ToolRuntime = {
    task,
    workspaceDir: config.workspaceDir,
    taskDir,
    platform: loggingPlatform,
    platformApi: config.nodeToken
      ? { baseUrl: config.platformHttpUrl, nodeToken: config.nodeToken }
      : undefined,
    // Spec #354: Reset/handoff may supply a live TodoStore with open items.
    todo: handoffTodo ?? seedTodoFromHandoff(task),
    evidence: new EvidenceStore(join(taskDir, "evidence")),
    findingsDir: join(taskDir, "findings"),
    goals,
    rolePackId: pack.id,
    skills,
    skillIds: pack.skillIds?.length ? pack.skillIds : undefined,
    processFacts,
    surfaceLedger,
    surfaceSqlite,
    lifecycle: {
      toolsInLastSegment: 0,
      panelAgents: panel,
      midRunTodo: createMidRunTodoTracker(),
      subagentDepth: 0,
      processQuality: createProcessQualityState(),
    },
  };
  runtime.subagents = new SubagentHost({
    task,
    taskDir,
    evidence: runtime.evidence,
    platform: loggingPlatform,
    goals,
    panelAgents: panel,
    // Spec #301 Free path: host auto-bind Worker ↔ Case Main todos on spawn.
    todo: () => runtime.todo,
  });

  // Spec #381 / D8: TARGET + scope.allow web origins → Surface seen (no traffic required).
  // Free + Hard Graph share this cold-start path; dual-write when Platform-bound.
  await seedSurfacesFromTargetAtTaskStart(runtime).catch((err) => {
    console.warn(
      `[node4] surface target seed failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  /**
   * Spec #333 / #427: package teardown = idle pool only.
   * Sticky pen-sandbox is **not** disposed on work-burst end (Session seat owns it).
   */
  const seatForHold = (() => {
    try {
      return resolveBrowserSandboxSeat(task);
    } catch {
      return null;
    }
  })();

  const cleanupTaskResources = () => {
    if (seatForHold) releaseBrowserSandboxSeat(seatForHold);
    return runTaskResourceCleanup({
      parentTaskId: task.taskId,
      idlePool: runtime.lifecycle.subagentIdlePool,
    });
  };

  /**
   * Graph × Pi Hard Graph path (ownership inversion).
   * Runs only after parent ToolRuntime exists so stage sessions use real stores/platform.
   * Default / ledger-assist seats never enter Expert Hard Graph.
   * Settlement is sole ownership of settleHardGraphTask (not a second dialect here).
   */
  // Expert Graph vs free OMP (#76 Soft retired). No Soft scenario inject path.
  if (workPath.path === "hard" && hardResolved.mode === "hard") {
    // Spec #334/#427: hold seat for lease heartbeat while burst runs.
    if (seatForHold) holdBrowserSandboxSeat(seatForHold);
    runtime.lifecycle.abortSignal = signal;
    try {
      const hardOut = await runHardGraphExpertTask({
        config,
        platform: loggingPlatform,
        task,
        taskDir,
        pack,
        graph: hardResolved.graph,
        parentRuntime: runtime,
        signal,
      });
      return { terminalStatus: hardOut.harnessStatus, taskDir };
    } finally {
      // Spec #333: dispose browser sandbox (and idle pool if any) after Hard Graph task.
      await cleanupTaskResources().catch(() => {});
    }
  }
  if (workPath.path === "unavailable") {
    // Spec #284 G5: fail-closed — never silent Free OMP under Graph intent.
    const term = unavailableGraphTerminal(workPath.graphId);
    await loggingPlatform
      .send({
        type: term.eventType,
        conversation_id: task.conversationId,
        task_id: task.taskId,
        message: term.message,
      } as any)
      .catch(() => {});
    return { terminalStatus: term.terminalStatus, taskDir };
  }

  // Free OMP Main path only (Default / free Expert chat — no Soft inject).
  // Soft scenario Graph is retired (#76); freePentestGraphResolution is the free-path SOT.
  // holdBrowserSandboxSeat is inside the try below so hold + cleanup share one scope.
  const graphResolved = freePentestGraphResolution(task);
  // Spec #278 S2: skill-like Graph L1 catalog in Free prompt (product ids only).
  let graphCatalogBlock = "";
  if (packRootForHard && pack.id === "pentest") {
    try {
      const l1 = await loadProductGraphL1Catalog(packRootForHard);
      graphCatalogBlock = formatGraphL1CatalogInjection(l1, { mode: "free" });
    } catch {
      graphCatalogBlock = "";
    }
  }
  const graphCtx = buildPentestGraphContext(graphResolved, { graphCatalogBlock });
  runtime.lifecycle.pentestGraph = graphCtx;

  const obsCounters = {
    toolCallCount: 0,
    activeTool: undefined as string | undefined,
    phase: "starting",
  };
  const obsCtx: ObservabilityContext = {
    platform: loggingPlatform,
    task,
    runtime,
    goals,
    usage,
    panel,
    startedAt,
    rolePackId: pack.id,
    counters: obsCounters,
  };

  let sessionRef: Node4AgentSession | undefined;
  // No session wall/max-time (OMP-default style). Only platform/user cancel aborts.
  runtime.lifecycle.abortSignal = signal;
  if (signal) {
    const onCancel = () => {
      void loggingPlatform
        .send({
          type: "status_update",
          conversation_id: task.conversationId,
          task_id: task.taskId,
          message: "harness abort: cancelled",
        })
        .catch(() => {});
      try {
        sessionRef?.abort();
      } catch {
        /* ignore */
      }
      // Spec #333 review: teardown only in `finally` (single lifecycle authority).
    };
    if (signal.aborted) onCancel();
    else signal.addEventListener("abort", onCancel, { once: true });
  }

  // Hook: work-burst start → panel timer opens (checkpoint.started_at).
  await loggingPlatform.send({
    type: "task_start",
    conversation_id: task.conversationId,
    task_id: task.taskId,
    target: task.target,
    role_pack: pack.id,
    role_source: roleResolved.source,
    started_at: startedAt,
    // Spec #278: Session actual mode for AgentRow / dual-rail settlement consumers.
    work_mode: "free",
    panel_agents: panel.list(),
    // Spec #455: cold reseed of same-Session continue (park miss / explicit flag).
    ...(task.sessionContinue
      ? { session_continue: true as const }
      : {}),
  });
  panel.setMainActivity({
    phase: chatOnly ? "chat" : "starting",
    detail: chatOnly ? "对话中，准备回复" : "任务启动中",
  });
  obsCounters.phase = chatOnly ? "chat" : "starting";

  const processFactIndex = await processFacts.list();
  // Graph hard: strip Main act tools; Free/soft keep full pack surface.
  const toolNames = applyMainActToolFilter(
    toolNamesForPack(pack),
    graphResolved.mainAct,
    graphResolved.mode,
  );
  const packForTools =
    toolNames.length !== pack.toolNames.length ? { ...pack, toolNames } : pack;
  const systemPrompt = buildSystemPrompt(task, packForTools, {
    goals,
    processFactIndex,
    workModeInjection: graphCtx.formatInjection(),
    eagerTodo: !chatOnly && !ledgerAssistSeat,
    eagerBooking: !chatOnly && !ledgerAssistSeat && pack.bookingMode === "finding",
    chatOnly,
    allowPostexOverride:
      graphResolved.mode === "graph" ? graphResolved.allowPostex : task.allowPostex,
  });
  // Chat-only: still register tools but prompt forbids using them until a target exists.
  const { session, segmentCounter } = await createBoundNode4Session({
    config,
    runtime,
    pack: packForTools,
    systemPrompt,
    thinkingLevel: chatOnly ? "low" : "medium",
    // Reset reseed: new pi-agent-core Agent with the id minted at Reset time.
    sessionId: reseedAgentSessionId,
  });
  sessionRef = session;
  // Mid-run user_steer (password hints, etc.) → pi steer/followUp on this session.
  const unregisterActiveSession = registerActiveSession({
    conversationId: task.conversationId,
    taskId: task.taskId,
    steer: (text) => session.steer(text),
    followUp: (text) => session.followUp(text),
  });

  // Panel / text stream / usage — tool_output already bridged in createBoundNode4Session.
  // Spec #353: stream health watch + idle abort → session.abort (same failure channel).
  const sessionObs = attachNode4SessionObservability({
    session,
    obsCtx,
    textStream,
    checkpointThrottle,
    // session-runner owns end-of-task textStream.dispose below.
    disposeTextStream: false,
    onIdleAbort: () => {
      try {
        session.abort();
      } catch {
        /* best-effort */
      }
    },
  });
  // Stamp pi Agent.sessionId on panel Main + checkpoint so FE collab copy sees it
  // on the same path as live panel_agents (not only participants snapshot).
  const piSid = String(session.sessionId || obsCtx.agentSessionId || "").trim();
  if (piSid) {
    obsCtx.agentSessionId = piSid;
    try {
      panel.setAgentSessionId(piSid);
    } catch {
      /* ignore */
    }
    await emitCheckpointUpdate(obsCtx, { status: "running" }).catch(() => {});
  }

  // Outer continues: product default OFF (settle on natural stop). Lab opt-in via env.
  // Discovery / multi-tool work stays in-loop (pi agent-loop). No session wall.
  const {
    maxContinues,
    maxEmptyStopStreak,
    maxPrematureStops,
    maxGoalContinues,
  } = resolveOuterContinueBudgets(process.env, { ledgerAssistSeat });
  const maxGoalLabel =
    maxGoalContinues == null || !Number.isFinite(maxGoalContinues) || maxGoalContinues < 0
      ? "∞"
      : String(maxGoalContinues);
  let continueCount = 0;
  let emptyStopStreak = 0;
  let bookingContinueUsed = false;
  let prematureStopCount = 0;
  let goalContinueCount = 0;
  let stopReason = "natural";
  const cancelled = () => Boolean(signal?.aborted);

  // Optional seed goal mode from structured task field (not free-text NLP),
  // else pack defaultGoalObjective when present (e.g. CTF maximize flags).
  // Never seed goals for chat-only (greeting) turns.
  const seedObjective = chatOnly
    ? ""
    : typeof (task as { goalObjective?: string }).goalObjective === "string"
      ? String((task as { goalObjective?: string }).goalObjective).trim()
      : pack.defaultGoalObjective?.trim() || "";
  if (seedObjective) {
    try {
      goals.create({ objective: seedObjective });
    } catch {
      // already has a goal
    }
  }

  const who = panelLabel;
  await loggingPlatform.send({
    type: "status_update",
    conversation_id: task.conversationId,
    task_id: task.taskId,
    message: chatOnly
      ? `${who} chat mode (no target yet) pack=${pack.id}`
      : `${who} starting pack=${pack.id} work_mode=${
          graphResolved.mode === "graph"
            ? `graph:${graphResolved.graphId}:${graphResolved.mainAct}`
            : "free"
        } tools=${toolNames.join(",")} goal_active=${goals.isActive()}`,
    agent_phase: chatOnly ? "chat" : "starting",
    status: "running",
    work_mode:
      graphResolved.mode === "graph"
        ? `graph:${graphResolved.graphId}:${graphResolved.mainAct}`
        : "free",
    llm_usage: usage.snapshot(),
  });

  // Initial checkpoint so right panel has structure even before first model turn.
  await emitCheckpointUpdate(obsCtx);
  checkpointThrottle.markEmitted();

  // L2 tooling health: observability only (taskDir + status_update). Never gates the loop.
  if (shouldEmitToolingHealth({ chatOnly, toolNames })) {
    try {
      await recordToolingHealthAtTaskStart({
        taskDir,
        platform: loggingPlatform,
        task,
      });
    } catch {
      // Best-effort: missing scanners must not abort session.prompt / settlement.
    }
  }

  // Spec #481 / #455: cold Free matches park-hit — user channel is utterance only.
  const userPrompt = String(task.instruction || "").trim() || "Hello";

  segmentCounter.tools = 0;
  runtime.lifecycle.toolsInLastSegment = 0;
  if (runtime.lifecycle.midRunTodo) resetMidRunTodoCycle(runtime.lifecycle.midRunTodo);

  const health = () => obsCtx.streamHealth;
  const usageSnap = () => usage.snapshot({ tool_calls: obsCounters.toolCallCount });

  /** Soft LLM failures (stopReason=error) → single surface → task_error. */
  const assertNoLlmTurnError = async () => {
    // Spec #353: idle abort may cancel the prompt without soft error messages.
    if (health()?.isIdleAbortRequested) {
      throw await surfaceLlmTurnFailure({
        platform: loggingPlatform,
        conversationId: task.conversationId,
        taskId: task.taskId,
        textStream,
        health: health(),
        error: idleTimeoutLlmTurnError(health()),
        llmUsage: usageSnap(),
      });
    }
    if (cancelled()) return;
    const errText = extractLlmTurnError(session.messages);
    if (!errText) {
      if (health() && health()!.state !== "terminal") {
        health()!.terminalSuccess();
      }
      return;
    }
    throw await surfaceLlmTurnFailure({
      platform: loggingPlatform,
      conversationId: task.conversationId,
      taskId: task.taskId,
      textStream,
      health: health(),
      providerMessage: errText,
      llmUsage: usageSnap(),
    });
  };

  /** Single prompt + soft-error assert (throws LlmTurnError → main task_error). */
  const promptAndAssert = async (
    promptText: string,
    channel: "user" | "harness" = "user",
    prefixHarness?: string,
  ) => {
    try {
      await session.prompt(promptText, {
        source: "interactive",
        channel,
        ...(prefixHarness ? { prefixHarness } : {}),
      });
    } catch (err) {
      // Spec #353: structured classes only (idle / incomplete / LlmTurnError).
      const mapped = mapPromptFailureToLlmTurnError(err, health());
      if (mapped) {
        throw await surfaceLlmTurnFailure({
          platform: loggingPlatform,
          conversationId: task.conversationId,
          taskId: task.taskId,
          textStream,
          health: health(),
          error: mapped,
          llmUsage: usageSnap(),
        });
      }
      if (!cancelled()) throw err;
      return;
    }
    await assertNoLlmTurnError();
  };

  let speechCursor = "";
  try {
    // Spec #334/#427: hold seat for lease heartbeat only while this try/finally owns the burst.
    if (seatForHold) holdBrowserSandboxSeat(seatForHold);

    if (!cancelled()) {
      const speech = selectCaseSpeechDelta(task.caseContext, {
        cursor: "",
        selfExpertId: task.expertId,
        selfExpertName: task.expertName,
        thisTurnText: userPrompt,
      });
      await promptAndAssert(
        userPrompt,
        "user",
        formatCaseSpeechHarness(speech.lines) || undefined,
      );
      speechCursor = speech.cursorAfter;
    }

    while (!cancelled()) {
      const toolsInLast = segmentCounter.tools;

      const actObsCount = runtime.lifecycle.recentObservations?.length || 0;
      const evidenceList = await runtime.evidence.list().catch(() => []);
      // Prefer act observations (book-time evidence model); fall back to Case evidence files.
      const probeCount = actObsCount || evidenceList.length;
      const bookedSoFar = await loadConfirmedFindings(runtime.findingsDir).catch(() => ({ count: 0 }));
      // Feed goal progress (stall telemetry) while accounting (active or budget-limited).
      if (goals.isAccounting()) {
        goals.noteSegmentProgress({
          bookedFindings: bookedSoFar.count,
          evidenceCount: probeCount,
          toolsInSegment: toolsInLast,
          goalContinueCount,
        });
      }

      // OMP: one-shot budget-limit steer when token_budget just flipped status.
      const budgetSteerGoal = goals.takePendingBudgetLimitSteer();
      if (budgetSteerGoal && !cancelled()) {
        await loggingPlatform.send({
          type: "status_update",
          conversation_id: task.conversationId,
          task_id: task.taskId,
          message: `goal budget-limited tokens=${budgetSteerGoal.tokensUsed}/${budgetSteerGoal.tokenBudget ?? "?"} — steer wrap-up (not complete)`,
          agent_phase: "goal_budget_limit",
          status: "running",
          llm_usage: usage.snapshot({ tool_calls: obsCounters.toolCallCount }),
        });
        segmentCounter.tools = 0;
        runtime.lifecycle.toolsInLastSegment = 0;
        try {
          await promptAndAssert(buildGoalBudgetLimitPrompt(budgetSteerGoal), "harness");
        } catch (err) {
          if (cancelled()) break;
          throw err;
        }
        continue;
      }

      const bookingSnap =
        pack.bookingMode === "finding"
          ? {
              evidenceCount: probeCount,
              bookedFindingCount: bookedSoFar.count,
              toolsInLastSegment: toolsInLast,
            }
          : undefined;
      // bookingGap: probes without findings (strong signal to allow one continue)
      const bookingGap =
        pack.bookingMode === "finding" && probeCount >= 2 && bookedSoFar.count === 0;
      // Soft open work (todos) for continue prompts; premature breadth no longer requires open todos.
      const openWorkRemaining = runtime.todo.openCount() > 0;

      // Pass previous emptyStopStreak only — evaluateContinueAfterSegment increments once.
      const decision = evaluateContinueAfterSegment({
        aborted: cancelled(),
        toolsInLastSegment: toolsInLast,
        previousEmptyStopStreak: emptyStopStreak,
        continueCount,
        maxContinues,
        maxEmptyStopStreak,
        bookingGap,
        bookingContinueUsed,
        prematureStopCount,
        maxPrematureStops,
        openWorkRemaining,
        goalModeActive: goals.isActive(),
        goalContinueCount,
        maxGoalContinues,
      });
      emptyStopStreak = decision.nextEmptyStopStreak;
      stopReason = normalizeProductStopReason({
        reason: decision.reason,
        continueCount,
        toolsInLastSegment: toolsInLast,
      });
      if (!decision.continue) break;

      if (decision.kind === "booking_gap") bookingContinueUsed = true;
      if (decision.kind === "premature") prematureStopCount += 1;
      if (decision.kind === "goal") {
        goalContinueCount += 1;
        goals.setGoalContinueCount(goalContinueCount);
      }
      continueCount = decision.nextContinueCount;
      segmentCounter.tools = 0;
      runtime.lifecycle.toolsInLastSegment = 0;
      // New outer cycle: OMP mid-run todo budget resets (mutations + nudge cap).
      if (runtime.lifecycle.midRunTodo) resetMidRunTodoCycle(runtime.lifecycle.midRunTodo);

      const todoErrors = runtime.lifecycle.pendingTodoErrorReminder?.slice();
      runtime.lifecycle.pendingTodoErrorReminder = undefined;
      const goalSnap = goals.formatForPrompt();
      const modeGoal = goals.getMode();
      const openTodoTitles = runtime.todo
        .snapshot()
        .flatMap((p) =>
          p.tasks
            .filter((t) => t.status === "pending" || t.status === "in_progress")
            .map((t) => t.content),
        );
      const openTodoCount = runtime.todo.openCount();
      // Soft NEW untested queue for stop/mid-run coverage honesty (#411).
      // Prefer is_new + not TESTED when inventory flag is on rows; else first-touch seen.
      let openNewUntestedSurfaceCount = 0;
      let openNewUntestedSurfaceSamples: string[] = [];
      if (runtime.surfaceSqlite) {
        try {
          const rows = await runtime.surfaceSqlite.all();
          const queue = selectNewUntestedSurfaces(rows, 12);
          openNewUntestedSurfaceCount = queue.count;
          openNewUntestedSurfaceSamples = queue.samples;
        } catch {
          // Soft path only — never fail continue on ledger read.
        }
      }
      const goalContinuationBody =
        decision.kind === "goal" && modeGoal
          ? buildGoalContinuationPrompt(modeGoal, { openTodoTitles, openTodoCount })
          : undefined;

      await loggingPlatform.send({
        type: "status_update",
        conversation_id: task.conversationId,
        task_id: task.taskId,
        message: `continue ${continueCount}/${maxContinues} (${decision.reason}) goal=${goalContinueCount}/${maxGoalLabel} premature=${prematureStopCount}/${maxPrematureStops} evidence=${evidenceList.length} findings=${bookedSoFar.count}`,
        agent_phase: "continue",
        status: "running",
        llm_usage: usage.snapshot({ tool_calls: obsCounters.toolCallCount }),
      });
      // Mid-run checkpoint on outer continues so tokens/tasks refresh even if throttle was idle.
      await emitCheckpointUpdate(obsCtx);
      checkpointThrottle.markEmitted();

      try {
        const continueKind =
          decision.kind === "booking_gap"
            ? "booking_gap"
            : decision.kind === "goal"
              ? "goal"
              : decision.kind === "premature"
                ? "premature"
                : "empty";
        await promptAndAssert(
          composeContinuePrompt({
            attempt: continueCount,
            max: maxContinues,
            openTodoCount,
            openTodoTitles,
            openNewUntestedSurfaceCount,
            openNewUntestedSurfaceSamples,
            todoErrors,
            booking: bookingSnap,
            goalSummary: goalSnap,
            kind: continueKind,
            prematureAttempt: prematureStopCount,
            prematureMax: maxPrematureStops,
            goalContinuationBody,
          }),
          "harness",
        );
      } catch (err) {
        if (cancelled()) break;
        throw err;
      }
    }

    if (cancelled()) {
      stopReason = abortReasonIsHandoff(signal) ? "handed_off" : "aborted";
    }
    // else keep stopReason from last decision (e.g. natural_stop_after_tools)

    const messages = Array.isArray((session as any).messages) ? [...(session as any).messages] : [];
    // Fallback: if subscribe never recorded usage (older pi / missed events), scan once.
    if (usage.snapshot().requests === 0) {
      for (const msg of messages) {
        if (msg && (msg as any).role === "assistant") {
          const before = usage.snapshot().total_tokens;
          if (usage.recordAssistantMessage(msg)) {
            const after = usage.snapshot().total_tokens;
            const delta = after - before;
            if (delta > 0 && goals.isAccounting()) goals.addTokensUsed(delta);
          }
        }
      }
    }

    // Spec #333: resource dispose is in `finally` only (single authority).

    const booked = await loadConfirmedFindings(runtime.findingsDir);
    const handedOff = stopReason === "handed_off";
    // Chat-only: completed only when a real reply happened (not LLM soft-error — those throw).
    // Authorized handoff supersede is a successful Default finish, not an abort.
    const harnessStatus = chatOnly
      ? cancelled() && !handedOff
        ? "incomplete"
        : "completed"
      : resolveHarnessTerminalStatus({
          bookedFindingCount: booked.count,
          aborted: cancelled() && !handedOff,
          stopReason,
        });
    const emitStatus = resolveTerminalTaskStatus({ harnessStatus });
    const endTime = new Date().toISOString();

    panel.setMainTerminal(
      cancelled() && !handedOff ? "aborted" : emitStatus === "completed" ? "completed" : "failed",
    );
    obsCounters.phase = "finished";

    const llmUsage = usage.snapshot({
      agent_count: panel.list().length,
      tool_calls: obsCounters.toolCallCount,
    });

    const summary =
      booked.count > 0
        ? `Harness settled ${emitStatus} with ${booked.count} booked finding(s). stop=${stopReason} role=${pack.id}`
        : `Harness settled ${emitStatus}. stop=${stopReason} role=${pack.id}`;

    // Spec #311: Free settle → Workset proposed (shared helper with parked continue).
    const settlePkg = await buildWorksetSettleEmitPackage({
      task,
      findingsDir: runtime.findingsDir,
      source: "free_settle",
      scanFindings: !chatOnly && !ledgerAssistSeat,
    });
    const attackSurfaceCandidates = settlePkg.attackSurfaceCandidates;
    const sideCandidates = settlePkg.nextScopeCandidates;
    const worksetCandidates = settlePkg.worksetCandidates;
    await writeAttackSurfaceCandidatesArtifact(taskDir, attackSurfaceCandidates);

    // Hook: work-burst end → panel timer closes (checkpoint.end_time then task_complete).
    await emitCheckpointUpdate(obsCtx, {
      terminal: true,
      status: emitStatus,
      endTime,
      attackSurfaceCandidates,
    });

    await loggingPlatform.send({
      type: "task_complete",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      status: emitStatus,
      summary,
      stop_reason: stopReason,
      continue_count: continueCount,
      booked_findings: booked.count,
      role_pack: pack.id,
      open_goals: goals.snapshot().openCount,
      llm_usage: llmUsage,
      started_at: startedAt,
      end_time: endTime,
      attack_surface_candidates: attackSurfaceCandidates,
      next_scope_candidates: sideCandidates,
      workset_candidates: worksetCandidates,
      workset_source: settlePkg.worksetSource,
      goal_mode: goals.isActive() || Boolean(task.goalObjective),
      goal_objective: task.goalObjective || undefined,
    });

    await writeFile(
      join(taskDir, "agent-summary.json"),
      JSON.stringify(
        {
          taskId: task.taskId,
          phase: "finished",
          terminalStatus: emitStatus,
          stopReason,
          continueCount,
          bookedFindings: booked.count,
          rolePack: pack.id,
          roleSource: roleResolved.source,
          openGoals: goals.snapshot().openCount,
          goals: goals.snapshot().goals,
          llm_usage: llmUsage,
          startedAt,
          endTime,
          attackSurfaceCandidates,
          nextScopeCandidates: sideCandidates,
          worksetCandidates,
        },
        null,
        2,
      ),
      "utf8",
    );

    await writeFile(join(taskDir, "goals-snapshot.json"), JSON.stringify(goals.snapshot(), null, 2), "utf8");

    await writePostRunInspectArtifacts({
      taskDir,
      taskId: task.taskId,
      terminalStatus: emitStatus,
      summary,
      messages,
      continueCount,
      stopReason,
      bookedFindingCount: booked.count,
    });

    return { terminalStatus: emitStatus, taskDir };
  } finally {
    // Spec #333/#427: idle pool only; sticky pen-sandbox survives work-burst end.
    await cleanupTaskResources().catch(() => {});
    // Tear down stream / active-session registration always.
    // Spec #283 I0.9: on user interrupt, park Free Main captain (do not dispose).
    try {
      unregisterActiveSession();
    } catch {
      /* ignore */
    }
    try {
      sessionObs.unsubscribe();
    } catch {
      /* ignore */
    }
    await textStream.dispose().catch(() => {});
    // Spec #283 I0.9 + #354: shared captain end policy (package settle/interrupt → park;
    // Session delete / Case close pending → dispose via applyCaptainEndDisposition).
    applyCaptainEndDisposition({
      decision: decideParkOnEnd({
        aborted: cancelled(),
        expertTransfer: abortReasonIsHandoff(signal),
      }),
      entry: {
        conversationId: task.conversationId,
        expertId: String(task.expertId || pack.id || ""),
        workMode: "free",
        taskId: task.taskId,
        session,
        todo: runtime.todo,
        accounts: task.accounts,
        runtime,
        speechCursor: speechCursor || undefined,
        dispose: () => {
          try {
            void Promise.resolve(session.dispose());
          } catch {
            /* ignore */
          }
        },
      },
    });
  }
}

function abortReasonIsHandoff(signal?: AbortSignal): boolean {
  if (!signal?.aborted) return false;
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  return reason === "authorized_handoff";
}

/**
 * True when this turn must not open an execution work-burst UX:
 * - built-in default seat (always chat/ledger assist), or
 * - expert dispatch with no authorized target/scope yet.
 */
export function isChatOnlyTask(task: TaskEnvelope, packId?: string): boolean {
  const pack = String(packId || task.engagement || task.role || "").toLowerCase().trim();
  if (pack === "default" || pack === "consult" || pack === "workspace") return true;
  const target = task.target && typeof task.target === "object" ? task.target : {};
  const value = String(
    (target as { value?: unknown }).value
      ?? (target as { url?: unknown }).url
      ?? (target as { host?: unknown }).host
      ?? "",
  ).trim();
  if (value) return false;
  const allow = task.scope && typeof task.scope === "object"
    ? (task.scope as { allow?: unknown }).allow
    : undefined;
  if (Array.isArray(allow)) {
    for (const item of allow) {
      if (String(item || "").trim()) return false;
    }
  }
  return true;
}

/** Built-in workspace seats: conversation + ledger/report tools, not recon execution. */
export function isLedgerAssistSeat(packId?: string): boolean {
  const pack = String(packId || "").toLowerCase().trim();
  return pack === "default" || pack === "consult" || pack === "workspace";
}

