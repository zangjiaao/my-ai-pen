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
import { EvidenceStore } from "../stores/evidence.js";
import { TodoStore } from "../stores/todo.js";
import type { PlatformSink, TaskEnvelope, ToolRuntime } from "../types.js";
import { NODE4_TOOL_NAMES } from "../tools/index.js";
import { loadConfirmedFindings } from "../tools/finding.js";
import { createNode4Extension } from "./extension.js";
import { resolveTerminalTaskStatus } from "./finish-settlement.js";
import {
  emptyStopContinuePrompt,
  nextEmptyStopStreak,
  resolveHarnessTerminalStatus,
  shouldContinueAfterNaturalStop,
} from "./loop-policy.js";
import { buildSystemPrompt } from "./prompt.js";
import { writePostRunInspectArtifacts } from "./session-inspect.js";

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

  const eventsPath = join(taskDir, "events.jsonl");
  await writeFile(eventsPath, "", "utf8");
  const loggingPlatform: PlatformSink = {
    async send(message) {
      await appendFile(eventsPath, `${JSON.stringify({ ts: new Date().toISOString(), ...message })}\n`, "utf8");
      await platform.send(message);
    },
  };

  const runtime: ToolRuntime = {
    task,
    workspaceDir: config.workspaceDir,
    taskDir,
    platform: loggingPlatform,
    todo: new TodoStore(),
    evidence: new EvidenceStore(join(taskDir, "evidence")),
    findingsDir: join(taskDir, "findings"),
    lifecycle: { toolsInLastSegment: 0 },
  };

  await loggingPlatform.send({
    type: "task_start",
    conversation_id: task.conversationId,
    task_id: task.taskId,
    target: task.target,
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
  const resourceLoader = new DefaultResourceLoader({
    cwd: taskDir,
    agentDir: config.piAgentDir,
    settingsManager,
    extensionFactories: [createNode4Extension(runtime, segmentCounter)],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    systemPrompt: buildSystemPrompt(task),
  });
  await resourceLoader.reload();

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
    tools: [...NODE4_TOOL_NAMES],
    sessionManager: SessionManager.create(taskDir, piSessionDir),
    settingsManager,
  });

  const maxContinues = Math.max(1, Number(process.env.NODE4_MAX_CONTINUES || 8));
  const maxEmptyStopStreak = Math.max(1, Number(process.env.NODE4_MAX_EMPTY_STOPS || 3));
  let continueCount = 0;
  let emptyStopStreak = 0;
  let stopReason = "natural";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
  }, config.mainMaxMs);

  try {
    await loggingPlatform.send({
      type: "status_update",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      message: "Node4 agent starting (OMP-class continue loop)",
    });

    const userPrompt = [
      "Run the authorized penetration test with high tool density (shell/write/edit/http).",
      "Book proven issues only via finding+evidence_ids. status/finish_scan does not end the task.",
      `Target: ${JSON.stringify(task.target)}`,
      `Scope: ${JSON.stringify(task.scope)}`,
      task.instruction,
    ].join("\n");

    // First segment
    segmentCounter.tools = 0;
    runtime.lifecycle.toolsInLastSegment = 0;
    if (!signal?.aborted && !timedOut) {
      await session.prompt(userPrompt, { source: "interactive" });
    }

    // Continue after natural stops (empty or premature) until caps/budget.
    while (!signal?.aborted && !timedOut) {
      const toolsInLast = segmentCounter.tools;
      emptyStopStreak = nextEmptyStopStreak(toolsInLast, emptyStopStreak);
      const decision = shouldContinueAfterNaturalStop({
        timedOut,
        aborted: Boolean(signal?.aborted),
        toolsInLastSegment: toolsInLast,
        emptyStopStreak,
        continueCount,
        maxContinues,
        maxEmptyStopStreak,
        agentBlocked: Boolean(runtime.lifecycle.agentBlocked),
      });
      stopReason = decision.reason;
      if (!decision.continue) break;

      continueCount = decision.nextContinueCount;
      segmentCounter.tools = 0;
      runtime.lifecycle.toolsInLastSegment = 0;
      await loggingPlatform.send({
        type: "status_update",
        conversation_id: task.conversationId,
        task_id: task.taskId,
        message: `continue ${continueCount}/${maxContinues} (${decision.reason})`,
      });
      await session.prompt(emptyStopContinuePrompt(continueCount, maxContinues), { source: "interactive" });
    }
    if (timedOut) stopReason = "wall_budget";
    if (signal?.aborted) stopReason = "aborted";
  } finally {
    clearTimeout(timer);
  }

  // Snapshot messages before dispose for inspectability.
  const messages = Array.isArray((session as any).messages) ? [...(session as any).messages] : [];
  try {
    session.dispose?.();
  } catch {
    // ignore
  }

  const booked = await loadConfirmedFindings(runtime.findingsDir);
  const harnessStatus = resolveHarnessTerminalStatus({
    agentBlocked: Boolean(runtime.lifecycle.agentBlocked),
    bookedFindingCount: booked.count,
    timedOut,
    aborted: Boolean(signal?.aborted),
    stopReason,
  });
  // Never honor agent finish as completed driver.
  const emitStatus = resolveTerminalTaskStatus({ harnessStatus });

  const summary =
    runtime.lifecycle.lastStatusNote?.summary ||
    runtime.lifecycle.finishScan?.summary ||
    (booked.count > 0
      ? `Harness settled ${emitStatus} with ${booked.count} booked finding(s). stop=${stopReason}`
      : `Harness settled ${emitStatus}. stop=${stopReason}`);

  await loggingPlatform.send({
    type: "task_complete",
    conversation_id: task.conversationId,
    task_id: task.taskId,
    status: emitStatus,
    summary,
    stop_reason: stopReason,
    continue_count: continueCount,
    booked_findings: booked.count,
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
        lastStatusNote: runtime.lifecycle.lastStatusNote || null,
        // Explicit: agent finish does not settle
        agentFinishNonTerminal: true,
        timedOut,
      },
      null,
      2,
    ),
    "utf8",
  );

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
