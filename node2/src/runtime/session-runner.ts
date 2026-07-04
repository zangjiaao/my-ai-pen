import { mkdir } from "node:fs/promises";
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
import { CoverageStore } from "../stores/coverage.js";
import { EvidenceStore } from "../stores/evidence.js";
import { PlanStore } from "../stores/plan.js";
import { TrafficStore } from "../stores/traffic.js";
import type { PlatformMessage, PlatformSink, TaskEnvelope, ToolRuntime } from "../types.js";
import { PENTEST_TOOL_NAMES } from "../tools/index.js";
import { createPentestExtension } from "./pentest-extension.js";
import { buildSystemPrompt } from "./prompt.js";

const TEXT_STREAM_FLUSH_MS = 250;
const DEFAULT_COMPLETION_GATE_ROUNDS = 3;

export async function runPentestTask(
  config: Node2Config,
  platform: PlatformSink,
  task: TaskEnvelope,
  signal?: AbortSignal,
): Promise<void> {
  const taskDir = join(config.workspaceDir, task.taskId);
  await mkdir(taskDir, { recursive: true });

  const runtime: ToolRuntime = {
    task,
    workspaceDir: config.workspaceDir,
    platform,
    plan: new PlanStore(),
    coverage: new CoverageStore(),
    evidence: new EvidenceStore(join(taskDir, "evidence")),
    traffic: new TrafficStore(),
  };

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

  const resourceLoader = new DefaultResourceLoader({
    cwd: taskDir,
    agentDir: config.piAgentDir,
    settingsManager,
    extensionFactories: [createPentestExtension(runtime)],
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    systemPrompt: buildSystemPrompt(task),
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: taskDir,
    agentDir: config.piAgentDir,
    model,
    thinkingLevel: "medium",
    authStorage,
    modelRegistry,
    resourceLoader,
    tools: [...PENTEST_TOOL_NAMES],
    sessionManager: SessionManager.inMemory(taskDir),
    settingsManager,
  });

  const textStream = new PlatformTextStream(platform, task);
  try {
    const abortHandler = () => {
      void session.abort();
    };
    signal?.addEventListener("abort", abortHandler, { once: true });
    session.subscribe(async (event) => {
      await textStream.handle(event);
      await handleSessionEvent(platform, runtime, event);
    });
    runtime.plan.start();
    await platform.send({
      type: "status_update",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      phase: runtime.plan.currentPhase(),
      active_tool: "pi",
      status: "running",
      message: "Pi pentest runtime started",
      progress: runtime.plan.progress(),
    });
    await platform.send({
      type: "plan_tree_updated",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      reason: "runtime.start",
      phase: runtime.plan.currentPhase(),
      progress: runtime.plan.progress(),
      plan_tree: runtime.plan.snapshot(),
    });
    if (signal?.aborted) throw new Error("Task interrupted by user.");
    await session.prompt(task.instruction, { source: "interactive" });
    await textStream.flush();
    if (signal?.aborted) throw new Error("Task interrupted by user.");
    const gateRounds = completionGateRounds();
    let gatePassed = runtime.plan.audit().canComplete;
    for (let round = 0; !gatePassed && round < gateRounds; round += 1) {
      const gapPrompt = runtime.plan.gapPrompt();
      await platform.send({
        type: "completion_blocked",
        conversation_id: task.conversationId,
        task_id: task.taskId,
        round: round + 1,
        audit: runtime.plan.audit(),
        message: "Runtime completion gate found unresolved Plan Tree work items.",
      });
      await session.prompt(gapPrompt, { source: "interactive" });
      await textStream.flush();
      if (signal?.aborted) throw new Error("Task interrupted by user.");
      gatePassed = runtime.plan.audit().canComplete;
    }
    if (!gatePassed) {
      await platform.send({
        type: "checkpoint_update",
        conversation_id: task.conversationId,
        task_id: task.taskId,
        checkpoint: {
          ...runtime.plan.checkpoint(),
          runtime: "node2-pi",
          tool_names: PENTEST_TOOL_NAMES,
          coverage: await runtime.coverage.summary(),
          evidence: await runtime.evidence.list(),
        },
      });
      await platform.send({
        type: "task_incomplete",
        conversation_id: task.conversationId,
        task_id: task.taskId,
        status: "incomplete",
        audit: runtime.plan.audit(),
        summary: extractLastAssistantText(session.messages).slice(0, 4000) || runtime.plan.audit().summary,
      });
      await platform.send({
        type: "task_complete",
        conversation_id: task.conversationId,
        task_id: task.taskId,
        status: "incomplete",
        summary: runtime.plan.audit().summary,
      });
      return;
    }
    runtime.plan.complete();
    await platform.send({
      type: "checkpoint_update",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      checkpoint: {
        ...runtime.plan.checkpoint(),
        runtime: "node2-pi",
        tool_names: PENTEST_TOOL_NAMES,
        coverage: await runtime.coverage.summary(),
        evidence: await runtime.evidence.list(),
      },
    });
    await platform.send({
      type: "plan_tree_updated",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      reason: "runtime.complete",
      phase: runtime.plan.currentPhase(),
      progress: runtime.plan.progress(),
      plan_tree: runtime.plan.snapshot(),
    });
    await platform.send({
      type: "task_complete",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      status: "completed",
      summary: extractLastAssistantText(session.messages).slice(0, 4000) || "Task completed.",
    });
  } finally {
    await textStream.dispose();
    session.dispose();
  }
}

function completionGateRounds(): number {
  const raw = Number(process.env.NODE2_COMPLETION_GATE_ROUNDS || DEFAULT_COMPLETION_GATE_ROUNDS);
  if (!Number.isFinite(raw)) return DEFAULT_COMPLETION_GATE_ROUNDS;
  return Math.max(0, Math.min(Math.floor(raw), 8));
}

async function handleSessionEvent(platform: PlatformSink, runtime: ToolRuntime, event: any): Promise<void> {
  if (event.type === "turn_start") {
    await platform.send({
      type: "status_update",
      conversation_id: runtime.task.conversationId,
      task_id: runtime.task.taskId,
      phase: runtime.plan.currentPhase(),
      active_tool: "pi",
      status: "running",
      progress: runtime.plan.progress(),
    } as PlatformMessage);
  }
  if (event.type === "agent_end") {
    runtime.plan.setPhase("report");
    await platform.send({
      type: "plan_tree_updated",
      conversation_id: runtime.task.conversationId,
      task_id: runtime.task.taskId,
      reason: "agent.end",
      phase: runtime.plan.currentPhase(),
      progress: runtime.plan.progress(),
      plan_tree: runtime.plan.snapshot(),
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
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
