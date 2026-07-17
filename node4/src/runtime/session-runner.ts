import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Node4Config } from "../config.js";
import { node4Root } from "../config.js";
import { resolveRolePack } from "../roles/index.js";
import { EvidenceStore } from "../stores/evidence.js";
import { GoalStore } from "../stores/goal.js";
import { SkillStore } from "../stores/skill.js";
import { TodoStore } from "../stores/todo.js";
import type { PlatformSink, TaskEnvelope, ToolRuntime } from "../types.js";
import { toolNamesForPack } from "../tools/index.js";
import { loadConfirmedFindings } from "../tools/finding.js";
import { createNode4Extension } from "./extension.js";
import { resolveTerminalTaskStatus } from "./harness-settlement.js";
import {
  composeContinuePrompt,
  resolveHarnessTerminalStatus,
  evaluateContinueAfterSegment,
} from "./loop-policy.js";
import { buildSystemPrompt } from "./prompt.js";
import { writePostRunInspectArtifacts } from "./session-inspect.js";
import { eagerBookingInjection } from "./booking-harness.js";
import { SubagentHost } from "./subagent.js";
import { eagerTodoInjection, resetMidRunTodoCycle, createMidRunTodoTracker } from "./todo-harness.js";
import { formatRoeInjection, resolveEngagementRoe } from "./engagement-roe.js";
import { formatCaseContextInjection } from "./case-context.js";
import { buildGoalContinuationPrompt } from "../stores/goal.js";
import { PanelAgentTracker } from "./panel-agents.js";
import {
  CheckpointThrottle,
  createUsageLedgerFromEnv,
  emitCheckpointUpdate,
  handleNode4SessionEvent,
  PlatformTextStream,
  type ObservabilityContext,
} from "./platform-observability.js";

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
  const startedAt = new Date().toISOString();
  /**
   * Chat-only turn: built-in default seat, or expert without authorized target/scope.
   * OMP work bursts must NOT auto-start — respond conversationally (and use ledger tools for default).
   */
  const chatOnly = isChatOnlyTask(task, pack.id);

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

  const goals = new GoalStore();
  const panelLabel =
    (typeof task.expertName === "string" && task.expertName.trim()) ||
    (pack.id && pack.id !== "runtime" ? pack.id : "Expert");
  const panel = new PanelAgentTracker(task.instruction || "Authorized security task", panelLabel);
  const usage = createUsageLedgerFromEnv();
  const textStream = new PlatformTextStream(loggingPlatform, task);
  const checkpointThrottle = new CheckpointThrottle();
  // Pack-scoped skills under experts/<id>/skills (catalog or install copy)
  // Pack-scoped skills only when an expert is installed (bare runtime has none)
  const skillsDir = (pack as { skillsRoot?: string }).skillsRoot;
  const skills = skillsDir ? new SkillStore(skillsDir) : undefined;

  const runtime: ToolRuntime = {
    task,
    workspaceDir: config.workspaceDir,
    taskDir,
    platform: loggingPlatform,
    platformApi: config.nodeToken
      ? { baseUrl: config.platformHttpUrl, nodeToken: config.nodeToken }
      : undefined,
    todo: new TodoStore(),
    evidence: new EvidenceStore(join(taskDir, "evidence")),
    findingsDir: join(taskDir, "findings"),
    goals,
    rolePackId: pack.id,
    skills,
    skillIds: pack.skillIds?.length ? pack.skillIds : undefined,
    lifecycle: {
      toolsInLastSegment: 0,
      panelAgents: panel,
      midRunTodo: createMidRunTodoTracker(),
    },
  };
  runtime.subagents = new SubagentHost({
    task,
    taskDir,
    evidence: runtime.evidence,
    platform: loggingPlatform,
    goals,
    panelAgents: panel,
  });

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

  let sessionRef: { abort?: () => Promise<void>; subscribe?: (fn: (e: any) => void) => void } = {};
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
      void Promise.resolve(sessionRef.abort?.()).catch(() => {});
    };
    if (signal.aborted) onCancel();
    else signal.addEventListener("abort", onCancel, { once: true });
  }

  await loggingPlatform.send({
    type: "task_start",
    conversation_id: task.conversationId,
    task_id: task.taskId,
    target: task.target,
    role_pack: pack.id,
    role_source: roleResolved.source,
  });

  const authStorage = AuthStorage.create(join(config.piAgentDir, "auth.json"));
  setRuntimeApiKey(authStorage, config.modelProvider);
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  if (config.llmBaseUrl) {
    // Built-in providers: override base URL only. Unknown providers (e.g. vast
    // llama.cpp): register the model id from env so OpenAI-compatible endpoints work.
    const known = modelRegistry.find(config.modelProvider, config.modelId);
    if (known) {
      modelRegistry.registerProvider(config.modelProvider, { baseUrl: config.llmBaseUrl });
    } else {
      const apiKey =
        process.env.LLM_API_KEY ||
        process.env.OPENAI_API_KEY ||
        process.env.DEEPSEEK_API_KEY ||
        "sk-no-key";
      const contextWindow = Math.max(1024, Number(process.env.LLM_CONTEXT_WINDOW || 8192) || 8192);
      const maxTokens = Math.max(256, Number(process.env.LLM_MAX_TOKENS || 2048) || 2048);
      modelRegistry.registerProvider(config.modelProvider, {
        baseUrl: config.llmBaseUrl,
        api: (process.env.LLM_API as any) || "openai-completions",
        apiKey,
        models: [
          {
            id: config.modelId,
            name: config.modelId,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow,
            maxTokens,
          },
        ],
      });
    }
  }
  const model = modelRegistry.find(config.modelProvider, config.modelId);
  if (!model) throw new Error(`model not found: ${config.modelProvider}/${config.modelId}`);

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 2 },
  });

  const segmentCounter = { tools: 0 };
  const systemPrompt = buildSystemPrompt(task, pack, { goals });
  const resourceLoader = new DefaultResourceLoader({
    cwd: taskDir,
    agentDir: config.piAgentDir,
    settingsManager,
    extensionFactories: [createNode4Extension(runtime, segmentCounter, pack)],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    systemPrompt,
  });
  await resourceLoader.reload();

  const piSessionDir = join(taskDir, "pi-sessions");
  await mkdir(piSessionDir, { recursive: true });
  const toolNames = toolNamesForPack(pack);
  const { session } = await createAgentSession({
    cwd: taskDir,
    agentDir: config.piAgentDir,
    model,
    // Greetings/chat: light thinking. Full engagements: medium for denser reasoning.
    thinkingLevel: chatOnly ? "low" : "medium",
    authStorage,
    modelRegistry,
    resourceLoader,
    // Chat-only: still register tools but prompt forbids using them until a target exists.
    tools: [...toolNames],
    sessionManager: SessionManager.create(taskDir, piSessionDir),
    settingsManager,
  });
  sessionRef = session as any;

  // Platform observability: text stream, llm_usage, throttled checkpoints.
  // Fire-and-forget so Pi token streaming is not blocked by platform WS/DB latency.
  if (typeof (session as any).subscribe === "function") {
    (session as any).subscribe((event: any) => {
      void handleNode4SessionEvent(obsCtx, textStream, checkpointThrottle, event).catch(() => {
        // Never let observability break the agent loop.
      });
    });
  }

  // Continues: empty + booking-gap + OMP goal-continuation + rare premature.
  // Discovery is in-loop (pi agent-loop). No session wall.
  // Chat-only turns: no outer continues (single conversational response).
  const maxContinues = chatOnly ? 0 : Math.max(0, Number(process.env.NODE4_MAX_CONTINUES ?? 16));
  const maxEmptyStopStreak = chatOnly ? 0 : Math.max(0, Number(process.env.NODE4_MAX_EMPTY_STOPS ?? 1));
  const maxPrematureStops = chatOnly ? 0 : Math.max(0, Number(process.env.NODE4_MAX_PREMATURE_STOPS ?? 3));
  // Allow enough goal pushes to cover multi-level CTF tails without empty thrash.
  const maxGoalContinues = chatOnly ? 0 : Math.max(0, Number(process.env.NODE4_MAX_GOAL_CONTINUES ?? 16));
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
      : `${who} starting pack=${pack.id} tools=${toolNames.join(",")} goal_active=${goals.isActive()}`,
    agent_phase: chatOnly ? "chat" : "starting",
    status: "running",
    llm_usage: usage.snapshot(),
  });

  // Initial checkpoint so right panel has structure even before first model turn.
  await emitCheckpointUpdate(obsCtx);
  checkpointThrottle.markEmitted();

  const roe = resolveEngagementRoe({
    engagementTemplate: task.engagementTemplate,
    engagement: task.engagement || task.role,
    allowPostex: task.allowPostex,
  });
  const userPrompt = chatOnly
    ? [
        `You are the product expert persona for pack «${pack.id}» (${pack.label}).`,
        "This turn is **conversation only** — the user has not provided an authorized target yet.",
        "Do NOT start recon, todo maps, goal mode, port scans, crawling, or finding booking.",
        "Do NOT invent a target. Do NOT call shell/http/browser/session/script tools unless the user already gave a concrete authorized host/URL in this message.",
        "Respond briefly in the user's language: greet if needed, confirm you are ready, and ask for:",
        "1) authorized target URL/IP, 2) scope allow/deny, 3) any accounts or constraints.",
        "When they provide a target later, a new work burst will run full OMP harness. This turn: chat only, then stop (no tools).",
        "",
        formatCaseContextInjection(task.caseContext),
        "",
        "### User message",
        task.instruction || "Hello",
      ]
        .filter(Boolean)
        .join("\n")
    : [
        eagerTodoInjection({ forced: true }),
        "",
        pack.bookingMode === "finding" ? eagerBookingInjection() : "",
        "",
        goals.formatForPrompt(),
        "",
        formatRoeInjection(roe),
        "",
        formatCaseContextInjection(task.caseContext),
        "",
        `Role pack: ${pack.id}. OMP essence: keep tool-calling in-loop; shell-first multi-step + multi-call same turn; http is single-probe only.`,
        "Long multi-challenge work: call goal(op=create, objective=...) early so the harness can auto-continue (OMP goal mode) until full clearance — complete only with remaining_unsolved=0 after real audit (partial wins are not done).",
        pack.bookingMode === "finding"
          ? "Book via finding(confirm) with proof= quoted from tool output. When truly stuck after dense shell work, stop with no tools — no finish tool; harness settles."
          : "This pack does not book findings. When finished, simply stop — harness settles.",
        `Target: ${JSON.stringify(task.target)}`,
        `Scope: ${JSON.stringify(task.scope)}`,
        task.accounts !== undefined ? `Accounts: ${JSON.stringify(task.accounts)}` : "",
        "### Your message this turn",
        task.instruction,
      ]
        .filter(Boolean)
        .join("\n");

  segmentCounter.tools = 0;
  runtime.lifecycle.toolsInLastSegment = 0;
  if (runtime.lifecycle.midRunTodo) resetMidRunTodoCycle(runtime.lifecycle.midRunTodo);

  if (!cancelled()) {
    try {
      await session.prompt(userPrompt, { source: "interactive" });
    } catch (err) {
      if (!cancelled()) throw err;
    }
  }

  while (!cancelled()) {
    const toolsInLast = segmentCounter.tools;

    const actObsCount = runtime.lifecycle.recentObservations?.length || 0;
    const evidenceList = await runtime.evidence.list().catch(() => []);
    // Prefer act observations (book-time evidence model); fall back to Case evidence files.
    const probeCount = actObsCount || evidenceList.length;
    const bookedSoFar = await loadConfirmedFindings(runtime.findingsDir).catch(() => ({ count: 0 }));
    // Feed goal complete-gates (stall / progress) before deciding continue.
    if (goals.isActive()) {
      goals.noteSegmentProgress({
        bookedFindings: bookedSoFar.count,
        evidenceCount: probeCount,
        toolsInSegment: toolsInLast,
        goalContinueCount,
      });
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
    // Soft open work (todos only) for premature; goal mode is separate OMP path.
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
    stopReason = decision.reason;
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
    const goalContinuationBody =
      decision.kind === "goal" && modeGoal ? buildGoalContinuationPrompt(modeGoal) : undefined;
    const openTodoTitles = runtime.todo
      .snapshot()
      .flatMap((p) => p.tasks.filter((t) => t.status === "pending" || t.status === "in_progress").map((t) => t.content));

    await loggingPlatform.send({
      type: "status_update",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      message: `continue ${continueCount}/${maxContinues} (${decision.reason}) goal=${goalContinueCount}/${maxGoalContinues} premature=${prematureStopCount}/${maxPrematureStops} evidence=${evidenceList.length} findings=${bookedSoFar.count}`,
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
      await session.prompt(
        composeContinuePrompt({
          attempt: continueCount,
          max: maxContinues,
          openTodoCount: runtime.todo.openCount(),
          openTodoTitles,
          todoErrors,
          booking: bookingSnap,
          goalSummary: goalSnap,
          kind: continueKind,
          prematureAttempt: prematureStopCount,
          prematureMax: maxPrematureStops,
          goalContinuationBody,
        }),
        { source: "interactive" },
      );
    } catch (err) {
      if (cancelled()) break;
      throw err;
    }
  }

  if (cancelled()) stopReason = "aborted";
  // else keep stopReason from last decision (e.g. natural_stop_after_tools)

  await textStream.dispose().catch(() => {});

  const messages = Array.isArray((session as any).messages) ? [...(session as any).messages] : [];
  // Fallback: if subscribe never recorded usage (older pi / missed events), scan once.
  if (usage.snapshot().requests === 0) {
    for (const msg of messages) {
      if (msg && (msg as any).role === "assistant") {
        const before = usage.snapshot().total_tokens;
        if (usage.recordAssistantMessage(msg)) {
          const after = usage.snapshot().total_tokens;
          const delta = after - before;
          if (delta > 0 && goals.isActive()) goals.addTokensUsed(delta);
        }
      }
    }
  }

  try {
    session.dispose?.();
  } catch {
    // ignore
  }

  const booked = await loadConfirmedFindings(runtime.findingsDir);
  const harnessStatus = chatOnly
    ? // Pure chat turn: never surface as incomplete/failed engagement.
      (cancelled() ? "incomplete" : "completed")
    : resolveHarnessTerminalStatus({
        bookedFindingCount: booked.count,
        aborted: cancelled(),
        stopReason,
      });
  const emitStatus = resolveTerminalTaskStatus({ harnessStatus });
  const endTime = new Date().toISOString();

  panel.setMainTerminal(cancelled() ? "aborted" : emitStatus === "completed" ? "completed" : "failed");
  obsCounters.phase = "finished";

  const llmUsage = usage.snapshot({
    agent_count: panel.list().length,
    tool_calls: obsCounters.toolCallCount,
  });

  const summary =
    booked.count > 0
      ? `Harness settled ${emitStatus} with ${booked.count} booked finding(s). stop=${stopReason} role=${pack.id}`
      : `Harness settled ${emitStatus}. stop=${stopReason} role=${pack.id}`;

  // Terminal checkpoint before task_complete so UI has final tokens + plan.
  await emitCheckpointUpdate(obsCtx, {
    terminal: true,
    status: emitStatus,
    endTime,
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

function setRuntimeApiKey(authStorage: AuthStorage, provider: string): void {
  // Prefer provider-native keys so a leftover LLM_API_KEY (e.g. ollama cloud)
  // cannot steal DeepSeek/OpenAI credentials.
  const p = String(provider || "").trim().toLowerCase();
  let key = "";
  if (p === "deepseek") {
    key = process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY || "";
  } else if (p === "openai") {
    key = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || "";
  } else if (p === "anthropic") {
    key = process.env.ANTHROPIC_API_KEY || process.env.LLM_API_KEY || "";
  } else {
    key =
      process.env.LLM_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.DEEPSEEK_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      "";
  }
  if (key) (authStorage as any).setRuntimeApiKey?.(provider, key);
}
