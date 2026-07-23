/**
 * Homogeneous OMP child session: same-pack act tools, no parent chat,
 * no nested subagent, no finding booking (Main books).
 *
 * OMP-style keep-alive: after a successful package the session may park in
 * SubagentIdlePool (keyed by pathKey) and be re-prompted on same-path re-dispatch
 * instead of runNode4Agent cold start.
 */

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import type { RolePack } from "../roles/types.js";
import { EvidenceStore } from "../stores/evidence.js";
import { GoalStore } from "../stores/goal.js";
import { ProcessFactStore } from "../stores/process-fact.js";
import { SkillStore } from "../stores/skill.js";
import { TodoStore } from "../stores/todo.js";
import type { TaskEnvelope, ToolRuntime } from "../types.js";
import { createNode4RuntimeBindings } from "./extension.js";
import { resolveNode4Model, runNode4Agent } from "./run-node4-agent.js";
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
import { pathKey } from "./subagent-booking.js";
import {
  getOrCreateIdlePool,
  type IdleSubagentHandle,
  type SubagentIdlePool,
} from "./subagent-idle-pool.js";

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
  /**
   * Exclusive warm handle from registry.tryResume (tool layer).
   * When set, re-prompt this session; do not cold-create.
   */
  warmHandle?: IdleSubagentHandle;
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

async function readResultFile(workDir: string): Promise<unknown | undefined> {
  try {
    const raw = await readFile(join(workDir, "result.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function clearResultFile(workDir: string): Promise<void> {
  try {
    await unlink(join(workDir, "result.json"));
  } catch {
    /* ok if missing */
  }
}

function resolvePathKey(handoff: SubagentHandoffFields): string {
  return pathKey(handoff.target) || String(handoff.target || "").trim().toLowerCase().slice(0, 180);
}

function sessionTimeoutMs(): number {
  return Math.min(
    Math.max(Number(process.env.NODE4_SUBAGENT_TIMEOUT_MS || 600_000) || 600_000, 30_000),
    1_800_000,
  );
}

type PromptRaceResult = {
  aborted: boolean;
  timedOut: boolean;
  error?: string;
};

async function raceSessionPrompt(
  session: IdleSubagentHandle["session"],
  userPrompt: string,
  abort: AbortSignal | undefined,
): Promise<PromptRaceResult> {
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    void Promise.resolve(session.abort?.()).catch(() => {});
  };
  if (abort) {
    if (abort.aborted) onAbort();
    else abort.addEventListener("abort", onAbort, { once: true });
  }

  const timeoutMs = sessionTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await Promise.race([
      session.prompt(userPrompt, { source: "interactive" }),
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          void Promise.resolve(session.abort?.()).catch(() => {});
          reject(new Error(`subagent LLM session timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    return { aborted, timedOut: false };
  } catch (err) {
    if (aborted) return { aborted: true, timedOut: false };
    const msg = err instanceof Error ? err.message : String(err);
    return { aborted, timedOut, error: msg };
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) abort.removeEventListener("abort", onAbort);
  }
}

async function collectStructuredResult(input: {
  workDir: string;
  handoff: SubagentHandoffFields;
  toolsUsed: number;
  aborted: boolean;
  promptError?: string;
}): Promise<{ structured: SubagentStructuredResult; salvaged: boolean }> {
  if (input.promptError && !input.aborted) {
    const existing = await readResultFile(input.workDir);
    const structured = normalizeSubagentResult(
      existing ?? {
        ok: false,
        summary: input.promptError,
        deadends: ["session_error"],
      },
      input.promptError,
    );
    if (!existing) {
      await writeFile(join(input.workDir, "result.json"), JSON.stringify(structured, null, 2), "utf8");
    }
    return { structured, salvaged: false };
  }

  let fileResult = await readResultFile(input.workDir);
  if (fileResult) {
    return {
      structured: normalizeSubagentResult(fileResult, input.handoff.this_turn_goal),
      salvaged: false,
    };
  }

  const structured = await salvageSubagentResult({
    workDir: input.workDir,
    handoff: input.handoff,
    toolsUsed: input.toolsUsed,
    aborted: input.aborted,
    fallbackSummary: input.aborted
      ? "subagent aborted"
      : input.toolsUsed > 0
        ? "subagent finished (no result.json)"
        : "subagent stopped without tools or result.json",
  });
  const salvaged = structured.candidates.length > 0;
  await writeFile(join(input.workDir, "result.json"), JSON.stringify(structured, null, 2), "utf8");
  return { structured, salvaged };
}

function buildUserPrompt(assignment: string, sessionSeeded: boolean, resume: boolean): string {
  const parts = [
    resume
      ? [
          "## Resume assignment (same worker — affinity follow-up only)",
          "You continue in an existing worker. Prior tool history may be in context.",
          "Hard boundaries for THIS package:",
          "- this_turn_goal is the ONLY objective; ignore prior candidates/deadends unless listed in already_done.",
          "- Do not re-probe orthogonal paths; stay on target.",
          "- Overwrite ./result.json for THIS package only (previous result.json is obsolete).",
          "- Prefer session cookies already present; re-login only on auth failure.",
          "",
        ].join("\n")
      : "",
    assignment,
    "",
    sessionSeeded
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
  ];
  return parts.filter(Boolean).join("\n");
}

async function ensureChildDirs(workDir: string): Promise<void> {
  await mkdir(workDir, { recursive: true });
  await mkdir(join(workDir, "facts"), { recursive: true });
  await mkdir(join(workDir, "evidence"), { recursive: true });
  await mkdir(join(workDir, "findings"), { recursive: true });
  await mkdir(join(workDir, "scripts"), { recursive: true });
  await mkdir(join(workDir, "tool-output"), { recursive: true });
  await mkdir(join(workDir, "pi-sessions"), { recursive: true });
}

/**
 * Run a same-pack child LLM session. Natural stop only (no outer continues).
 * Dry-run when NODE4_SUBAGENT_DRY=1 (no model call; writes empty structured result).
 *
 * Keep-alive: after success, park by agent_id. Warm resume only when
 * `resumeAgentId` is set and affinity (same pathKey) passes — never auto path grab.
 */
export async function runSubagentLlmSession(
  input: SubagentLlmSessionInput,
): Promise<SubagentLlmSessionOutput> {
  const { handoff, parent, subagentId } = input;
  const pk = resolvePathKey(handoff);
  const pool = getOrCreateIdlePool(parent.lifecycle);
  const abort = input.abortSignal || parent.lifecycle.abortSignal;

  // Warm path: tool layer already exclusive-took the handle (affinity-gated).
  if (input.warmHandle && pool) {
    return runWarmPackage({
      input,
      warm: input.warmHandle,
      pool,
      pathKey: pk || input.warmHandle.pathKey,
      agentId: input.warmHandle.agentId || subagentId,
      abort,
    });
  }

  return runColdPackage({
    input,
    pool,
    pathKey: pk,
    agentId: subagentId,
    abort,
    workDir: input.workDir,
  });
}

async function runWarmPackage(args: {
  input: SubagentLlmSessionInput;
  warm: IdleSubagentHandle;
  pool: SubagentIdlePool;
  pathKey: string;
  agentId: string;
  abort?: AbortSignal;
}): Promise<SubagentLlmSessionOutput> {
  const { input, warm, pool, pathKey: pk, agentId, abort } = args;
  const workDir = warm.workDir;
  await ensureChildDirs(workDir);
  await clearResultFile(workDir);

  // Refresh affinity labels on the handle for this package.
  warm.nodeType = input.nodeType || warm.nodeType;
  warm.skillId = input.skillId || warm.skillId;
  warm.pathKey = pk || warm.pathKey;
  warm.agentId = agentId;

  const sessionSeed = await seedChildSessionFromParent(input.parent.taskDir, workDir);
  const userPrompt = buildUserPrompt(input.assignment, sessionSeed.seeded, true);

  const toolsBefore = warm.segmentCounter.tools;
  const race = await raceSessionPrompt(warm.session, userPrompt, abort);
  const toolsUsed = Math.max(0, warm.segmentCounter.tools - toolsBefore);

  const { structured, salvaged } = await collectStructuredResult({
    workDir,
    handoff: input.handoff,
    toolsUsed: warm.segmentCounter.tools,
    aborted: race.aborted,
    promptError: race.error,
  });

  const sessionPromote = await promoteChildSessionToParent(workDir, input.parent.taskDir);
  const ok = structured.ok && !race.aborted && !race.timedOut;

  warm.packagesCompleted += 1;
  warm.lastUsedAt = Date.now();

  // OMP: finished + soft-failed stay interrogable (timeout/salvage OK). Parent abort → release.
  const shouldPark =
    Boolean(pool) && Boolean(pk) && Boolean(agentId) && !race.aborted;

  if (shouldPark) {
    pool.park(warm);
  } else {
    try {
      warm.clearAbort?.();
      await Promise.resolve(warm.session.dispose?.());
    } catch {
      /* ignore */
    }
  }

  const workerStatus = shouldPark ? "idle" : "released";
  return {
    ok,
    summary: structured.summary,
    structured,
    data: {
      kind: "llm_session",
      structured,
      handoff: input.handoff,
      node_type: input.nodeType,
      skill_id: input.skillId,
      agent_id: agentId,
      worker_status: workerStatus,
      tools: warm.segmentCounter.tools,
      tools_this_package: toolsUsed,
      workDir,
      session_seed: sessionSeed,
      session_promote: sessionPromote,
      salvaged,
      session_reuse: {
        hit: true,
        agent_id: agentId,
        path_key: pk,
        packages_completed: warm.packagesCompleted,
        parked: shouldPark,
        worker_status: workerStatus,
        timed_out: race.timedOut || undefined,
      },
      resume_hint: shouldPark
        ? {
            agent_id: agentId,
            path_key: pk,
            reason: "same_path_followup",
          }
        : undefined,
    },
  };
}

async function runColdPackage(args: {
  input: SubagentLlmSessionInput;
  pool: SubagentIdlePool | undefined;
  pathKey: string;
  agentId: string;
  abort?: AbortSignal;
  workDir: string;
}): Promise<SubagentLlmSessionOutput> {
  const { input, pool, pathKey: pk, agentId, abort, workDir } = args;
  const { assignment, handoff, parent, subagentId } = input;
  await ensureChildDirs(workDir);

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
      data: {
        kind: "llm_dry",
        structured,
        handoff,
        agent_id: agentId,
        session_seed: sessionSeed,
        session_reuse: {
          hit: false,
          agent_id: agentId,
          path_key: pk,
          dry: true,
        },
      },
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
      abortSignal: abort,
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

  const userPrompt = buildUserPrompt(assignment, sessionSeed.seeded, false);

  const model = resolveNode4Model(config);
  const segmentCounter = { tools: 0 };
  const bindings = createNode4RuntimeBindings(childRuntime, segmentCounter, pack);
  const session = await runNode4Agent({
    systemPrompt,
    tools: bindings.tools,
    model,
    thinkingLevel: "low",
    beforeToolCall: bindings.beforeToolCall,
    afterToolCall: bindings.afterToolCall,
    onAgent: bindings.attachAgent,
  });

  const race = await raceSessionPrompt(session, userPrompt, abort);

  const { structured, salvaged } = await collectStructuredResult({
    workDir,
    handoff,
    toolsUsed: segmentCounter.tools,
    aborted: race.aborted,
    promptError: race.error,
  });

  const sessionPromote = await promoteChildSessionToParent(workDir, parent.taskDir);
  const ok = structured.ok && !race.aborted && !race.timedOut;

  // OMP keep-alive: park success + soft-fail/timeout so same agent_id can resume.
  // Parent abort or missing identity → dispose immediately (release).
  const shouldPark =
    Boolean(pool) && Boolean(pk) && Boolean(agentId) && !race.aborted;

  if (shouldPark && pool) {
    const handle: IdleSubagentHandle = {
      agentId,
      pathKey: pk,
      nodeType: input.nodeType,
      skillId: input.skillId,
      session: session as IdleSubagentHandle["session"],
      workDir,
      segmentCounter,
      packagesCompleted: 1,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    pool.park(handle);
  } else {
    try {
      await Promise.resolve((session as any).dispose?.());
    } catch {
      /* ignore */
    }
  }

  const workerStatus = shouldPark ? "idle" : "released";
  return {
    ok,
    summary: structured.summary,
    structured,
    data: {
      kind: "llm_session",
      structured,
      handoff,
      node_type: input.nodeType,
      skill_id: input.skillId,
      agent_id: agentId,
      worker_status: workerStatus,
      tools: segmentCounter.tools,
      workDir,
      session_seed: sessionSeed,
      session_promote: sessionPromote,
      salvaged,
      session_reuse: {
        hit: false,
        agent_id: agentId,
        path_key: pk,
        packages_completed: 1,
        parked: shouldPark,
        worker_status: workerStatus,
        timed_out: race.timedOut || undefined,
      },
      resume_hint: shouldPark
        ? {
            agent_id: agentId,
            path_key: pk,
            reason: "same_path_followup",
          }
        : undefined,
    },
  };
}
