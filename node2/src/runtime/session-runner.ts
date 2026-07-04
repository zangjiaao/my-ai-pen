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
import { TrafficStore } from "../stores/traffic.js";
import type { PlatformMessage, PlatformSink, TaskEnvelope, ToolRuntime } from "../types.js";
import { PENTEST_TOOL_NAMES } from "../tools/index.js";
import { createPentestExtension } from "./pentest-extension.js";
import { buildSystemPrompt } from "./prompt.js";

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

  try {
    const abortHandler = () => {
      void session.abort();
    };
    signal?.addEventListener("abort", abortHandler, { once: true });
    session.subscribe((event) => {
      void forwardSessionEvent(platform, task, event);
    });
    await platform.send({
      type: "status_update",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      phase: "running",
      active_tool: "pi",
      status: "running",
      message: "Pi pentest runtime started",
    });
    if (signal?.aborted) throw new Error("Task interrupted by user.");
    await session.prompt(task.instruction, { source: "interactive" });
    if (signal?.aborted) throw new Error("Task interrupted by user.");
    await platform.send({
      type: "checkpoint_update",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      checkpoint: {
        runtime: "node2-pi",
        tool_names: PENTEST_TOOL_NAMES,
        coverage: await runtime.coverage.summary(),
        evidence: await runtime.evidence.list(),
      },
    });
    await platform.send({
      type: "task_complete",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      status: "completed",
      summary: extractLastAssistantText(session.messages).slice(0, 4000) || "Task completed.",
    });
  } finally {
    session.dispose();
  }
}

async function forwardSessionEvent(platform: PlatformSink, task: TaskEnvelope, event: any): Promise<void> {
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
    const delta = String(event.assistantMessageEvent.delta || "");
    if (!delta) return;
    await platform.send({
      type: "text",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      content: { text: delta },
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
