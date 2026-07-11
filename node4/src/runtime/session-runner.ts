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
import { createNode4Extension } from "./extension.js";
import { finishScanSettlesTask, resolveTerminalTaskStatus } from "./finish-settlement.js";
import { buildSystemPrompt } from "./prompt.js";

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
    lifecycle: {},
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

  const resourceLoader = new DefaultResourceLoader({
    cwd: taskDir,
    agentDir: config.piAgentDir,
    settingsManager,
    extensionFactories: [createNode4Extension(runtime)],
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

  let toolTurns = 0;
  let maxTurnsReached = false;
  const onTool = () => {
    toolTurns += 1;
    if (toolTurns >= config.mainMaxTurns) maxTurnsReached = true;
  };
  // Count via event file growth is awkward; wrap platform already logs tools.
  // Use session subscribe if available — fall back to turn limit via wall clock.
  const started = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
  }, config.mainMaxMs);

  try {
    await loggingPlatform.send({
      type: "status_update",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      message: "Node4 agent starting",
    });

    const userPrompt = [
      "Run the authorized security task using the Node4 simple loop (todo → http/script → finding → finish_scan).",
      `Target: ${JSON.stringify(task.target)}`,
      `Scope: ${JSON.stringify(task.scope)}`,
      task.instruction,
    ].join("\n");

    // Soft turn budget: prompt once; agent stops via finish or max wall clock.
    if (!signal?.aborted && !timedOut) {
      await session.prompt(userPrompt, { source: "interactive" });
    }

    // If agent never finished but we still have time and no finish, one nudge.
    if (!runtime.lifecycle.finishScan && !timedOut && !signal?.aborted) {
      await session.prompt(
        "If the engagement outcome is settled, call finish_scan now (completed with findings or incomplete with gaps). Open todo does not block completed.",
        { source: "interactive" },
      );
    }
  } finally {
    clearTimeout(timer);
    try {
      session.dispose?.();
    } catch {
      // ignore
    }
  }

  void onTool;
  void started;
  void maxTurnsReached;

  const finish = runtime.lifecycle.finishScan;
  const settlement = finishScanSettlesTask(finish);
  const terminalStatus = resolveTerminalTaskStatus({
    gateCanComplete: settlement.canComplete,
    finishStatus: finish?.status,
  });

  // If no finish_scan, settle incomplete (not demote completed — there is none).
  const finalStatus =
    finish?.status === "completed"
      ? "completed"
      : finish?.status === "blocked"
        ? "blocked"
        : finish?.status === "incomplete"
          ? "incomplete"
          : timedOut || signal?.aborted
            ? "incomplete"
            : terminalStatus;

  const summary =
    finish?.summary ||
    (timedOut ? "Stopped on wall-clock budget without finish_scan." : "Task ended without finish_scan.");

  // Authoritative: never demote accepted completed.
  const emitStatus = finish?.status === "completed" ? "completed" : finalStatus;

  await loggingPlatform.send({
    type: "task_complete",
    conversation_id: task.conversationId,
    task_id: task.taskId,
    status: emitStatus,
    summary,
  });

  await writeFile(
    join(taskDir, "agent-summary.json"),
    JSON.stringify(
      {
        taskId: task.taskId,
        phase: "finished",
        terminalStatus: emitStatus,
        finishScan: finish || null,
        toolTurns,
        timedOut,
        settlement,
      },
      null,
      2,
    ),
    "utf8",
  );

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
