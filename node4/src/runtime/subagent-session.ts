/**
 * Homogeneous OMP child session: same-pack act tools, no parent chat,
 * no nested subagent, no finding booking (Main books).
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
import { loadConfig } from "../config.js";
import type { RolePack } from "../roles/types.js";
import { EvidenceStore } from "../stores/evidence.js";
import { GoalStore } from "../stores/goal.js";
import { ProcessFactStore } from "../stores/process-fact.js";
import { SkillStore } from "../stores/skill.js";
import { TodoStore } from "../stores/todo.js";
import type { TaskEnvelope, ToolRuntime } from "../types.js";
import { createNode4Extension } from "./extension.js";
import {
  formatSubagentReturnContractPrompt,
  normalizeSubagentResult,
  type SubagentStructuredResult,
} from "./subagent-result.js";
import type { SubagentHandoffFields } from "./subagent-handoff.js";
import { salvageSubagentResult } from "./subagent-salvage.js";
import {
  promoteChildSessionToParent,
  seedChildSessionFromParent,
} from "./subagent-session-seed.js";

/** Act tools for child workers — no subagent, finding, goal, or platform ledger. */
export const SUBAGENT_CHILD_TOOL_NAMES = [
  "todo",
  "shell",
  "write",
  "edit",
  "read",
  "http",
  "session",
  "browser",
  "script",
  "fact",
  "skill",
] as const;

export type SubagentLlmSessionInput = {
  parent: ToolRuntime;
  subagentId: string;
  workDir: string;
  assignment: string;
  handoff: SubagentHandoffFields;
  /** Optional methodology skill id to inject (one body). */
  skillId?: string;
  /** Optional graph node type label for prompts. */
  nodeType?: string;
  /** Pack skill filter + skills root. */
  skillIds?: readonly string[];
  skillsRoot?: string;
  /** Abort from parent task. */
  abortSignal?: AbortSignal;
};

export type SubagentLlmSessionOutput = {
  ok: boolean;
  summary: string;
  structured: SubagentStructuredResult;
  data: unknown;
};

function childRolePack(parentPackId: string, skillIds?: readonly string[], skillsRoot?: string): RolePack {
  return {
    id: parentPackId || "pentest",
    label: "Subagent worker",
    missionLines: [
      "You are a **subagent work package** under a parent penetration-testing agent.",
      "You do NOT inherit parent chat. Follow only the handoff package and this mission.",
      "Execute this_turn_goal densely (shell/http/session/browser as needed). Stay in scope.",
      "Do not open unbounded scans of the entire estate — finish this single package.",
    ],
    workLines: [
      "Prefer act tools over long chat.",
      "Prefer session/http over browser unless DOM/JS interaction is required.",
      "If session cookies were seeded from parent, try them first — re-login only when auth fails.",
      "Write process facts with fact(upsert) when cognition is confirmed.",
      "When done or blocked, write ./result.json per the return contract, then stop (no tools). result.json is mandatory.",
      "Never call subagent. Never book product findings (no finding tool).",
    ],
    toolNames: [...SUBAGENT_CHILD_TOOL_NAMES],
    bookingMode: "none",
    settlementNote: "Child stops naturally after writing result.json; parent harness continues.",
    skillIds: skillIds?.length ? skillIds : undefined,
    skillsRoot,
  };
}

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
  if (key) (authStorage as any).setRuntimeApiKey?.(provider, key);
}

async function readResultFile(workDir: string): Promise<unknown | undefined> {
  try {
    const raw = await readFile(join(workDir, "result.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Run a same-pack child LLM session. Natural stop only (no outer continues).
 * Dry-run when NODE4_SUBAGENT_DRY=1 (no model call; writes empty structured result).
 */
export async function runSubagentLlmSession(
  input: SubagentLlmSessionInput,
): Promise<SubagentLlmSessionOutput> {
  const { workDir, assignment, handoff, parent, subagentId } = input;
  await mkdir(workDir, { recursive: true });
  await mkdir(join(workDir, "facts"), { recursive: true });
  await mkdir(join(workDir, "evidence"), { recursive: true });
  await mkdir(join(workDir, "findings"), { recursive: true });
  await mkdir(join(workDir, "scripts"), { recursive: true });
  await mkdir(join(workDir, "tool-output"), { recursive: true });
  await mkdir(join(workDir, "pi-sessions"), { recursive: true });

  // Prefer parent session jars so packages need not re-login every time.
  const sessionSeed = await seedChildSessionFromParent(parent.taskDir, workDir);

  const dry =
    process.env.NODE4_SUBAGENT_DRY === "1" ||
    process.env.NODE4_SUBAGENT_DRY === "true";

  if (dry) {
    const structured = normalizeSubagentResult({
      ok: true,
      summary: `dry-run subagent ${subagentId}: ${handoff.this_turn_goal}`,
      candidates: [],
      facts: [],
      deadends: [],
      artifacts: [],
      notes: `NODE4_SUBAGENT_DRY=1 — no LLM child session; session_seed=${sessionSeed.seeded}`,
    });
    await writeFile(join(workDir, "result.json"), JSON.stringify(structured, null, 2), "utf8");
    return {
      ok: true,
      summary: structured.summary,
      structured,
      data: { kind: "llm_dry", structured, handoff, session_seed: sessionSeed },
    };
  }

  const config = loadConfig();
  const parentPackId = String(parent.rolePackId || "pentest");
  const pack = childRolePack(parentPackId, input.skillIds ?? parent.skillIds, input.skillsRoot);

  const childTask: TaskEnvelope = {
    ...parent.task,
    taskId: `${parent.task.taskId}/sub/${subagentId}`,
    instruction: handoff.this_turn_goal,
  };

  const processFacts = new ProcessFactStore(join(workDir, "facts"));
  await processFacts.ensureDir();
  // Reuse parent SkillStore when available
  const skillStore = parent.skills ?? (input.skillsRoot ? new SkillStore(input.skillsRoot) : undefined);

  let skillBody = "";
  if (input.skillId && skillStore) {
    try {
      const loaded = await skillStore.load(input.skillId);
      if ("body" in loaded && loaded.body) skillBody = loaded.body.slice(0, 12_000);
    } catch {
      /* optional */
    }
  }

  const childRuntime: ToolRuntime = {
    task: childTask,
    workspaceDir: parent.workspaceDir,
    taskDir: workDir,
    platform: parent.platform,
    platformApi: parent.platformApi,
    todo: new TodoStore(),
    evidence: new EvidenceStore(join(workDir, "evidence")),
    findingsDir: join(workDir, "findings"),
    goals: new GoalStore(),
    rolePackId: pack.id,
    skills: skillStore,
    skillIds: pack.skillIds,
    processFacts,
    lifecycle: {
      toolsInLastSegment: 0,
      recentObservations: [],
      subagentDepth: 1,
      abortSignal: input.abortSignal || parent.lifecycle.abortSignal,
    },
  };

  const nodeLabel = input.nodeType ? `node_type=${input.nodeType}` : "node_type=(free)";
  const systemPrompt = [
    ...pack.missionLines,
    "",
    ...pack.workLines,
    "",
    `Parent pack: ${parentPackId}. ${nodeLabel}.`,
    `Tools: ${pack.toolNames.join(", ")}.`,
    "",
    formatSubagentReturnContractPrompt(),
    "",
    skillBody
      ? `## Loaded skill (${input.skillId})\n${skillBody}`
      : input.skillId
        ? `## Skill\nRequested skill_id=${input.skillId} was not loaded; use skill tool if needed.`
        : "Load at most one skill via skill(op=load) if methodology helps.",
    "",
    `Target envelope: ${JSON.stringify(childTask.target)}`,
    `Scope envelope: ${JSON.stringify(childTask.scope)}`,
  ].join("\n");

  const userPrompt = [
    assignment,
    "",
    sessionSeed.seeded
      ? [
          "## Session seed",
          "Parent cookie jars were copied into this workDir (`session/`).",
          "Use session tools with the existing jar first; re-login only if requests return login page / 401 / unauthenticated.",
          "",
        ].join("\n")
      : "",
    formatSubagentReturnContractPrompt(),
    "",
    "Begin acting toward this_turn_goal. Prefer session/http over browser unless DOM/JS is required.",
    "Before you stop: write ./result.json with surfaces/candidates as required — this is mandatory.",
  ]
    .filter(Boolean)
    .join("\n");

  const authStorage = AuthStorage.create(join(config.piAgentDir, "auth.json"));
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
  if (!model) {
    const structured = normalizeSubagentResult({
      ok: false,
      summary: `subagent model not found: ${config.modelProvider}/${config.modelId}`,
      candidates: [],
      facts: [],
      deadends: ["model_unavailable"],
      artifacts: [],
    });
    await writeFile(join(workDir, "result.json"), JSON.stringify(structured, null, 2), "utf8");
    return { ok: false, summary: structured.summary, structured, data: { kind: "llm_error", structured } };
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
    extensionFactories: [createNode4Extension(childRuntime, segmentCounter, pack)],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    systemPrompt,
  });
  await resourceLoader.reload();

  const piSessionDir = join(workDir, "pi-sessions");
  const { session } = await createAgentSession({
    cwd: workDir,
    agentDir: config.piAgentDir,
    model,
    thinkingLevel: "low",
    authStorage,
    modelRegistry,
    resourceLoader,
    tools: [...pack.toolNames],
    sessionManager: SessionManager.create(workDir, piSessionDir),
    settingsManager,
  });

  const abort = input.abortSignal || parent.lifecycle.abortSignal;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    void Promise.resolve((session as any).abort?.()).catch(() => {});
  };
  if (abort) {
    if (abort.aborted) onAbort();
    else abort.addEventListener("abort", onAbort, { once: true });
  }

  const timeoutMs = Math.min(
    Math.max(Number(process.env.NODE4_SUBAGENT_TIMEOUT_MS || 600_000) || 600_000, 30_000),
    1_800_000,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      session.prompt(userPrompt, { source: "interactive" }),
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => {
          void Promise.resolve((session as any).abort?.()).catch(() => {});
          reject(new Error(`subagent LLM session timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    if (!aborted) {
      const msg = err instanceof Error ? err.message : String(err);
      const existing = await readResultFile(workDir);
      const structured = normalizeSubagentResult(
        existing ?? {
          ok: false,
          summary: msg,
          deadends: ["session_error"],
        },
        msg,
      );
      if (!existing) {
        await writeFile(join(workDir, "result.json"), JSON.stringify(structured, null, 2), "utf8");
      }
      return {
        ok: false,
        summary: structured.summary,
        structured,
        data: { kind: "llm_session", structured, handoff, error: msg, tools: segmentCounter.tools },
      };
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) abort.removeEventListener("abort", onAbort);
    try {
      await Promise.resolve((session as any).dispose?.());
    } catch {
      /* ignore */
    }
  }

  let fileResult = await readResultFile(workDir);
  let structured: SubagentStructuredResult;
  let salvaged = false;
  if (fileResult) {
    structured = normalizeSubagentResult(fileResult, handoff.this_turn_goal);
  } else {
    // Salvage tool-output/facts so Main can book or deadend without re-dispatch spam.
    structured = await salvageSubagentResult({
      workDir,
      handoff,
      toolsUsed: segmentCounter.tools,
      aborted,
      fallbackSummary: aborted
        ? "subagent aborted"
        : segmentCounter.tools > 0
          ? "subagent finished (no result.json)"
          : "subagent stopped without tools or result.json",
    });
    salvaged = structured.candidates.length > 0;
    await writeFile(join(workDir, "result.json"), JSON.stringify(structured, null, 2), "utf8");
  }

  // Graph hard: Main cannot use session tools — push child cookies up so later packages seed.
  const sessionPromote = await promoteChildSessionToParent(workDir, parent.taskDir);

  return {
    ok: structured.ok && !aborted,
    summary: structured.summary,
    structured,
    data: {
      kind: "llm_session",
      structured,
      handoff,
      node_type: input.nodeType,
      skill_id: input.skillId,
      tools: segmentCounter.tools,
      workDir,
      session_seed: sessionSeed,
      session_promote: sessionPromote,
      salvaged,
    },
  };
}
