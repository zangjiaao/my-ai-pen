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
import { resolveRolePack } from "../roles/index.js";
import { EvidenceStore } from "../stores/evidence.js";
import { GoalStore } from "../stores/goal.js";
import { TodoStore } from "../stores/todo.js";
import type { PlatformSink, TaskEnvelope, ToolRuntime } from "../types.js";
import { toolNamesForPack } from "../tools/index.js";
import { loadConfirmedFindings } from "../tools/finding.js";
import { createNode4Extension } from "./extension.js";
import { resolveTerminalTaskStatus } from "./harness-settlement.js";
import {
  composeContinuePrompt,
  nextEmptyStopStreak,
  resolveHarnessTerminalStatus,
  evaluateContinueAfterSegment,
} from "./loop-policy.js";
import { buildSystemPrompt } from "./prompt.js";
import { writePostRunInspectArtifacts } from "./session-inspect.js";
import { eagerBookingInjection } from "./booking-harness.js";
import { SubagentHost } from "./subagent.js";
import { eagerTodoInjection } from "./todo-harness.js";

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

  const eventsPath = join(taskDir, "events.jsonl");
  await writeFile(eventsPath, "", "utf8");
  const loggingPlatform: PlatformSink = {
    async send(message) {
      await appendFile(eventsPath, `${JSON.stringify({ ts: new Date().toISOString(), ...message })}\n`, "utf8");
      await platform.send(message);
    },
  };

  const goals = new GoalStore();
  const runtime: ToolRuntime = {
    task,
    workspaceDir: config.workspaceDir,
    taskDir,
    platform: loggingPlatform,
    todo: new TodoStore(),
    evidence: new EvidenceStore(join(taskDir, "evidence")),
    findingsDir: join(taskDir, "findings"),
    goals,
    rolePackId: pack.id,
    lifecycle: { toolsInLastSegment: 0 },
  };
  runtime.subagents = new SubagentHost({
    task,
    taskDir,
    evidence: runtime.evidence,
    platform: loggingPlatform,
    goals,
  });

  let sessionRef: { abort?: () => Promise<void> } = {};
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
    modelRegistry.registerProvider(config.modelProvider, { baseUrl: config.llmBaseUrl });
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
    thinkingLevel: "medium",
    authStorage,
    modelRegistry,
    resourceLoader,
    tools: [...toolNames],
    sessionManager: SessionManager.create(taskDir, piSessionDir),
    settingsManager,
  });
  sessionRef = session as any;

  // Continues: rare recovery (empty + one booking-gap + open-work premature).
  // Discovery is in-loop (pi agent-loop). No session wall.
  const maxContinues = Math.max(0, Number(process.env.NODE4_MAX_CONTINUES ?? 8));
  const maxEmptyStopStreak = Math.max(0, Number(process.env.NODE4_MAX_EMPTY_STOPS ?? 1));
  const maxPrematureStops = Math.max(0, Number(process.env.NODE4_MAX_PREMATURE_STOPS ?? 3));
  let continueCount = 0;
  let emptyStopStreak = 0;
  let bookingContinueUsed = false;
  let prematureStopCount = 0;
  let stopReason = "natural";
  const cancelled = () => Boolean(signal?.aborted);

  await loggingPlatform.send({
    type: "status_update",
    conversation_id: task.conversationId,
    task_id: task.taskId,
    message: `Node4 starting role_pack=${pack.id} tools=${toolNames.join(",")} (in-loop density; no session wall)`,
  });

  const userPrompt = [
    eagerTodoInjection({ forced: true }),
    "",
    pack.bookingMode === "finding" ? eagerBookingInjection() : "",
    "",
    goals.formatForPrompt(),
    "",
    `Role pack: ${pack.id}. OMP essence: keep tool-calling in-loop; shell-first multi-step + multi-call same turn; http is single-probe only.`,
    pack.bookingMode === "finding"
      ? "Book via finding(confirm)+evidence_ids (batch after a shell burst). When truly stuck after dense shell work, stop with no tools — no finish tool; harness settles."
      : "This pack does not book findings. When finished, simply stop — harness settles.",
    `Target: ${JSON.stringify(task.target)}`,
    `Scope: ${JSON.stringify(task.scope)}`,
    task.instruction,
  ]
    .filter(Boolean)
    .join("\n");

  segmentCounter.tools = 0;
  runtime.lifecycle.toolsInLastSegment = 0;

  if (!cancelled()) {
    try {
      await session.prompt(userPrompt, { source: "interactive" });
    } catch (err) {
      if (!cancelled()) throw err;
    }
  }

  while (!cancelled()) {
    const toolsInLast = segmentCounter.tools;

    const evidenceList = await runtime.evidence.list().catch(() => []);
    const bookedSoFar = await loadConfirmedFindings(runtime.findingsDir).catch(() => ({ count: 0 }));
    const bookingSnap =
      pack.bookingMode === "finding"
        ? {
            evidenceCount: evidenceList.length,
            bookedFindingCount: bookedSoFar.count,
            toolsInLastSegment: toolsInLast,
          }
        : undefined;
    // bookingGap: has evidence but zero findings (strong signal to allow one continue)
    const bookingGap =
      pack.bookingMode === "finding" && evidenceList.length >= 2 && bookedSoFar.count === 0;
    // Open work: further premature pushes after first recovery (generic, not lab-specific).
    const openWorkRemaining = runtime.todo.openCount() > 0 || goals.snapshot().openCount > 0;

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
    });
    emptyStopStreak = decision.nextEmptyStopStreak;
    stopReason = decision.reason;
    if (!decision.continue) break;

    if (decision.kind === "booking_gap") bookingContinueUsed = true;
    if (decision.kind === "premature") prematureStopCount += 1;
    continueCount = decision.nextContinueCount;
    segmentCounter.tools = 0;
    runtime.lifecycle.toolsInLastSegment = 0;

    const todoErrors = runtime.lifecycle.pendingTodoErrorReminder?.slice();
    runtime.lifecycle.pendingTodoErrorReminder = undefined;
    const goalSnap = goals.formatForPrompt();

    await loggingPlatform.send({
      type: "status_update",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      message: `continue ${continueCount}/${maxContinues} (${decision.reason}) premature=${prematureStopCount}/${maxPrematureStops} evidence=${evidenceList.length} findings=${bookedSoFar.count}`,
    });
    try {
      const continueKind =
        decision.kind === "booking_gap"
          ? "booking_gap"
          : decision.kind === "premature"
            ? "premature"
            : "empty";
      await session.prompt(
        composeContinuePrompt({
          attempt: continueCount,
          max: maxContinues,
          openTodoCount: runtime.todo.openCount(),
          todoErrors,
          booking: bookingSnap,
          goalSummary: goalSnap,
          kind: continueKind,
          prematureAttempt: prematureStopCount,
          prematureMax: maxPrematureStops,
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

  const messages = Array.isArray((session as any).messages) ? [...(session as any).messages] : [];
  try {
    session.dispose?.();
  } catch {
    // ignore
  }

  const booked = await loadConfirmedFindings(runtime.findingsDir);
  const harnessStatus = resolveHarnessTerminalStatus({
    bookedFindingCount: booked.count,
    aborted: cancelled(),
    stopReason,
  });
  const emitStatus = resolveTerminalTaskStatus({ harnessStatus });

  const summary =
    booked.count > 0
      ? `Harness settled ${emitStatus} with ${booked.count} booked finding(s). stop=${stopReason} role=${pack.id}`
      : `Harness settled ${emitStatus}. stop=${stopReason} role=${pack.id}`;

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

function setRuntimeApiKey(authStorage: AuthStorage, provider: string): void {
  const key =
    process.env.LLM_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    "";
  if (key) (authStorage as any).setRuntimeApiKey?.(provider, key);
}
