/**
 * Pi-backed stage executor for Hard Graph (Graph × Pi).
 *
 * Builds a **real** child ToolRuntime (stores + parent platform) like subagent
 * sessions — no fake goals/evidence stubs. Model/session boot follows the same
 * pattern as runSubagentLlmSession.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import type { RolePack } from "../roles/types.js";
import type { TaskEnvelope, ToolRuntime } from "../types.js";
import { EvidenceStore } from "../stores/evidence.js";
import { GoalStore } from "../stores/goal.js";
import { ProcessFactStore } from "../stores/process-fact.js";
import { TodoStore } from "../stores/todo.js";
import { createNode4Extension } from "./extension.js";
import type { StageExecutor, StageExecutorInput, StageExecutorOutput } from "./hard-graph-runner.js";
import { normalizeSubagentResult } from "./subagent-result.js";

export type HardGraphStageSessionFactory = (options: {
  stageId: string;
  tools: string[];
  systemPrompt: string;
  userPrompt: string;
  workDir: string;
  abortSignal?: AbortSignal;
}) => Promise<{ structured: unknown; summary?: string }>;

function setRuntimeApiKey(authStorage: AuthStorage, provider: string): void {
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
  if (key) (authStorage as { setRuntimeApiKey?: (p: string, k: string) => void }).setRuntimeApiKey?.(provider, key);
}

function stageSystemPrompt(input: StageExecutorInput, task: TaskEnvelope): string {
  return [
    "You are a **Hard Graph stage agent** (Graph × Pi).",
    `Graph: ${input.graphId}  Stage: ${input.stage.id} (index ${input.stageIndex})`,
    input.stage.success ? `Stage success criteria: ${input.stage.success}` : "",
    "You do NOT schedule other stages. Complete only this stage.",
    "When done, write structured JSON to result.json in the stage work dir with fields:",
    "  ok, summary, surfaces[], candidates[], facts[], deadends[]",
    "Fail closed: do not invent surfaces or proof.",
    `Target: ${JSON.stringify(task.target)}`,
    `Scope: ${JSON.stringify(task.scope)}`,
    `Prior handoff stages: ${input.handoff.completed_stages.join(", ") || "(none)"}`,
    `Known surfaces: ${JSON.stringify(input.handoff.surfaces.slice(0, 20))}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function stageUserPrompt(input: StageExecutorInput, task: TaskEnvelope): string {
  return [
    `### Hard Graph stage: ${input.stage.id}`,
    input.stage.success || "",
    "",
    "### Handoff snapshot",
    JSON.stringify(
      {
        summary: input.handoff.summary,
        surfaces: input.handoff.surfaces.slice(0, 40),
        candidates: input.handoff.candidates.slice(0, 20),
        deadends: input.handoff.deadends.slice(0, 20),
      },
      null,
      2,
    ),
    "",
    "### Task instruction",
    task.instruction || "",
    "",
    "Complete this stage only. Write result.json then stop.",
  ].join("\n");
}

async function resolveModel(config: Node4Config, authStorage: AuthStorage) {
  setRuntimeApiKey(authStorage, config.modelProvider);
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  if (config.llmBaseUrl) {
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
        api: (process.env.LLM_API as "openai-completions") || "openai-completions",
        apiKey,
        models: [
          {
            id: config.modelId,
            name: config.modelId,
            reasoning: false,
            input: ["text" as const],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow,
            maxTokens,
          },
        ],
      });
    }
  }
  return {
    modelRegistry,
    model: modelRegistry.find(config.modelProvider, config.modelId),
  };
}

function buildChildRuntime(options: {
  parent: ToolRuntime;
  workDir: string;
  tools: string[];
  pack: RolePack;
  abortSignal?: AbortSignal;
}): { childRuntime: ToolRuntime; packForStage: RolePack } {
  const { parent, workDir, tools, pack, abortSignal } = options;
  const packForStage: RolePack = { ...pack, toolNames: tools };
  const processFacts = new ProcessFactStore(join(workDir, "facts"));
  const childRuntime: ToolRuntime = {
    task: parent.task,
    workspaceDir: parent.workspaceDir,
    taskDir: workDir,
    platform: parent.platform,
    platformApi: parent.platformApi,
    todo: new TodoStore(),
    evidence: new EvidenceStore(join(workDir, "evidence")),
    findingsDir: parent.findingsDir,
    goals: new GoalStore(),
    rolePackId: pack.id,
    skills: parent.skills,
    skillIds: pack.skillIds,
    processFacts,
    surfaceLedger: parent.surfaceLedger,
    lifecycle: {
      toolsInLastSegment: 0,
      recentObservations: [],
      subagentDepth: (parent.lifecycle?.subagentDepth ?? 0) + 1,
      abortSignal,
    },
  };
  return { childRuntime, packForStage };
}

/**
 * Build a StageExecutor that uses pi createAgentSession with a real child ToolRuntime.
 */
export function createPiHardGraphStageExecutor(options: {
  config: Node4Config;
  /** Parent Expert task runtime (platform, findingsDir, skills, …). */
  parentRuntime: ToolRuntime;
  pack: RolePack;
  sessionFactory?: HardGraphStageSessionFactory;
  abortSignal?: AbortSignal;
}): StageExecutor {
  const { config, parentRuntime, pack, sessionFactory, abortSignal } = options;
  const task = parentRuntime.task;

  return async (input: StageExecutorInput): Promise<StageExecutorOutput> => {
    const workDir = join(
      parentRuntime.taskDir,
      "hard-graph",
      input.graphId,
      `stage-${input.stageIndex}-${input.stage.id}`,
    );
    await mkdir(workDir, { recursive: true });
    await mkdir(join(workDir, "evidence"), { recursive: true });
    await mkdir(join(workDir, "facts"), { recursive: true });
    await mkdir(join(workDir, "pi-sessions"), { recursive: true });

    const systemPrompt = stageSystemPrompt(input, task);
    const userPrompt = stageUserPrompt(input, task);

    if (sessionFactory) {
      const out = await sessionFactory({
        stageId: input.stage.id,
        tools: input.tools,
        systemPrompt,
        userPrompt,
        workDir,
        abortSignal,
      });
      return { structured: out.structured, summary: out.summary };
    }

    const { childRuntime, packForStage } = buildChildRuntime({
      parent: parentRuntime,
      workDir,
      tools: input.tools,
      pack,
      abortSignal,
    });
    await childRuntime.processFacts?.ensureDir?.().catch(() => {});

    const authStorage = AuthStorage.create(join(config.piAgentDir, "auth.json"));
    const { modelRegistry, model } = await resolveModel(config, authStorage);
    if (!model) {
      return {
        structured: {
          ok: false,
          summary: `hard-graph stage: model not available (${config.modelProvider}/${config.modelId})`,
          surfaces: [],
          candidates: [],
          deadends: ["model_unavailable"],
        },
        summary: `hard-graph stage: model not available (${config.modelProvider}/${config.modelId})`,
      };
    }

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 1 },
    });
    const segmentCounter = { tools: 0 };
    const resourceLoader = new DefaultResourceLoader({
      cwd: workDir,
      agentDir: config.piAgentDir,
      settingsManager,
      extensionFactories: [createNode4Extension(childRuntime, segmentCounter, packForStage)],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      systemPrompt,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: workDir,
      agentDir: config.piAgentDir,
      model,
      thinkingLevel: "low",
      authStorage,
      modelRegistry,
      resourceLoader,
      tools: [...input.tools],
      sessionManager: SessionManager.create(workDir, join(workDir, "pi-sessions")),
      settingsManager,
    });

    try {
      if (abortSignal?.aborted) {
        return {
          structured: {
            ok: false,
            summary: "aborted before stage",
            surfaces: [],
            candidates: [],
            deadends: ["aborted"],
          },
          summary: "aborted before stage",
        };
      }
      await session.prompt(userPrompt, { source: "interactive" });
    } catch (err) {
      if (abortSignal?.aborted) {
        return {
          structured: {
            ok: false,
            summary: "aborted",
            surfaces: [],
            candidates: [],
            deadends: ["aborted"],
          },
          summary: "aborted",
        };
      }
      throw err;
    } finally {
      try {
        await Promise.resolve((session as { dispose?: () => void | Promise<void> }).dispose?.());
      } catch {
        /* ignore */
      }
    }

    const resultPath = join(workDir, "result.json");
    try {
      const raw = await readFile(resultPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const structured = normalizeSubagentResult(parsed);
      await writeFile(
        join(workDir, "normalized-result.json"),
        JSON.stringify(structured, null, 2),
        "utf8",
      );
      return { structured, summary: structured.summaryProvided ? structured.summary : undefined };
    } catch {
      return {
        structured: {
          ok: false,
          summary: `stage ${input.stage.id}: missing or invalid result.json`,
          surfaces: [],
          candidates: [],
          facts: [],
          deadends: ["missing_result_json"],
        },
        summary: `stage ${input.stage.id}: missing or invalid result.json`,
      };
    }
  };
}
