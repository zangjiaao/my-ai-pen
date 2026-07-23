/**
 * Pi-backed stage executor for Hard Graph (Graph × Pi).
 * Creates a light stage session, applies tool profile, returns structured result.
 *
 * For CI, `runStageSession` can be injected; production wires createAgentSession.
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
import type { TaskEnvelope } from "../types.js";
import { createNode4Extension } from "./extension.js";
import type { RolePack } from "../roles/types.js";
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

/**
 * Build a StageExecutor that uses pi createAgentSession (production).
 */
export function createPiHardGraphStageExecutor(options: {
  config: Node4Config;
  task: TaskEnvelope;
  taskDir: string;
  pack: RolePack;
  /** Optional inject for tests */
  sessionFactory?: HardGraphStageSessionFactory;
  abortSignal?: AbortSignal;
}): StageExecutor {
  const { config, task, taskDir, pack, sessionFactory, abortSignal } = options;

  return async (input: StageExecutorInput): Promise<StageExecutorOutput> => {
    const workDir = join(taskDir, "hard-graph", input.graphId, `stage-${input.stageIndex}-${input.stage.id}`);
    await mkdir(workDir, { recursive: true });
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

    // Production pi path (model wiring mirrors session-runner / subagent-session)
    const authStorage = AuthStorage.create(join(config.piAgentDir, "auth.json"));
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
              contextWindow: 8192,
              maxTokens: 2048,
            },
          ],
        });
      }
    }
    const model = modelRegistry.find(config.modelProvider, config.modelId);
    if (!model) {
      return {
        structured: {
          ok: false,
          summary: `hard-graph stage: model not available (${config.modelProvider}/${config.modelId})`,
          surfaces: [],
          candidates: [],
          deadends: ["model_unavailable"],
        },
      };
    }

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 1 },
    } as any);
    const segmentCounter = { tools: 0 };
    const runtimeStub = {
      task,
      workspaceDir: config.workspaceDir,
      taskDir: workDir,
      platform: { send: async () => {} },
      todo: { openCount: () => 0, snapshot: () => [] },
      evidence: { list: async () => [], add: async () => ({ id: "x" }) },
      findingsDir: join(taskDir, "findings"),
      goals: {
        isActive: () => false,
        isAccounting: () => false,
        formatForPrompt: () => "",
        create: () => {},
        noteSegmentProgress: () => {},
        takePendingBudgetLimitSteer: () => null,
        setGoalContinueCount: () => {},
        getMode: () => "off",
      },
      lifecycle: {},
    } as any;

    const packForStage = { ...pack, toolNames: input.tools };
    const resourceLoader = new DefaultResourceLoader({
      cwd: workDir,
      agentDir: config.piAgentDir,
      settingsManager,
      extensionFactories: [createNode4Extension(runtimeStub, segmentCounter, packForStage)],
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
        };
      }
      throw err;
    } finally {
      try {
        (session as unknown as { dispose?: () => void }).dispose?.();
      } catch {
        /* ignore */
      }
    }

    // Prefer result.json written by the agent
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
      return { structured, summary: structured.summary };
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
      };
    }
  };
}
