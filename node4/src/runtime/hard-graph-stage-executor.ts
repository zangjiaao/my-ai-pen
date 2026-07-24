/**
 * Core-only stage executor for Hard Graph (Graph × Pi).
 *
 * Builds a **real** child ToolRuntime (stores + parent platform) like subagent
 * sessions — no fake goals/evidence stubs. Agent Runtime via createBoundNode4Session.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Node4Config } from "../config.js";
import type { RolePack } from "../roles/types.js";
import type { TaskEnvelope, ToolRuntime } from "../types.js";
import { EvidenceStore } from "../stores/evidence.js";
import { GoalStore } from "../stores/goal.js";
import { ProcessFactStore } from "../stores/process-fact.js";
import { TodoStore } from "../stores/todo.js";
import type { StageExecutor, StageExecutorInput, StageExecutorOutput } from "./hard-graph-runner.js";
import { createBoundNode4Session } from "./run-node4-agent.js";
import {
  absorbStageResultIntoParent,
  seedStageLifecycleFromParent,
  type StageContinuitySeed,
} from "./hard-graph-continuity.js";
import {
  normalizeSubagentResult,
  type SubagentStructuredResult,
} from "./subagent-result.js";
import {
  promoteChildSessionToParent,
  seedChildSessionFromParent,
} from "./subagent-session-seed.js";
import { SubagentHost } from "./subagent.js";

export type HardGraphStageSessionFactory = (options: {
  stageId: string;
  tools: string[];
  systemPrompt: string;
  userPrompt: string;
  workDir: string;
  abortSignal?: AbortSignal;
}) => Promise<{ structured: unknown; summary?: string }>;

/**
 * Post-session handoff: Feedback reads stage workdir `result.json` only.
 * Missing/invalid → fail-closed structured result (does not invent surfaces).
 */
export async function loadStageResultJson(
  workDir: string,
  stageId: string,
): Promise<SubagentStructuredResult> {
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
    return structured;
  } catch {
    return normalizeSubagentResult({
      ok: false,
      summary: `stage ${stageId}: missing or invalid result.json`,
      surfaces: [],
      candidates: [],
      deadends: ["missing_result_json"],
    });
  }
}

function stageSystemPrompt(input: StageExecutorInput, task: TaskEnvelope): string {
  const toolList = input.tools.length ? input.tools.join(", ") : "(none)";
  return [
    "You are a **Hard Graph stage agent** (Graph × Pi).",
    `Graph: ${input.graphId}  Stage: ${input.stage.id} (index ${input.stageIndex})`,
    input.stage.success ? `Stage success criteria: ${input.stage.success}` : "",
    "You do NOT schedule other stages. Complete only this stage.",
    `Allowed tools for this stage: ${toolList}`,
    "When done, use the **write** tool to create **result.json** in the stage work dir (path: result.json) with fields:",
    "  ok, summary, surfaces[], candidates[], facts[], deadends[]",
    "Facts alone are not the stage handoff — Feedback reads result.json only.",
    "Bookable candidates MUST include: title, location (URL/path), proof_excerpt (verbatim tool stdout/body ≥24 chars), optional poc_hint.",
    "Without proof_excerpt the next stage cannot finding(confirm) — narrative notes alone are not bookable.",
    input.tools.includes("subagent")
      ? [
          "Agent Graph: when surfaces justify multi-class work, fan-out with subagent packages[] (skill/path-scoped workers).",
          "Workers return candidates[] with verbatim proof_excerpt; you Join into result.json candidates (do not rephrase proof).",
          "No nested subagent inside workers. Stay in RoE/scope. Prefer packages over one serial monologue across all classes.",
        ].join(" ")
      : "",
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
    "Complete this stage only. Use write to emit result.json, then stop.",
  ].join("\n");
}

/**
 * Hard Graph stage agent is runner-owned Main-like for that stage (not a nested subagent).
 * depth 0 so class_probe can fan-out packages; workers they spawn use depth 1 (nest ban).
 */
export function buildHardGraphStageChildRuntime(options: {
  parent: ToolRuntime;
  workDir: string;
  tools: string[];
  pack: RolePack;
  abortSignal?: AbortSignal;
}): { childRuntime: ToolRuntime; packForStage: RolePack } {
  const { parent, workDir, tools, pack, abortSignal } = options;
  const packForStage: RolePack = { ...pack, toolNames: tools };
  const processFacts = new ProcessFactStore(join(workDir, "facts"));
  const allowSubagent = tools.includes("subagent");
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
      // Stage captain = depth 0 (can spawn packages). Not parent+1 nest ban.
      subagentDepth: 0,
      abortSignal,
      subagentEvidenceCache: [],
    },
  };
  if (allowSubagent) {
    childRuntime.subagents = new SubagentHost({
      task: parent.task,
      taskDir: workDir,
      evidence: childRuntime.evidence,
      platform: parent.platform,
      goals: childRuntime.goals!,
    });
  }
  return { childRuntime, packForStage };
}

/** @deprecated use buildHardGraphStageChildRuntime */
const buildChildRuntime = buildHardGraphStageChildRuntime;

/**
 * Promote Agent Graph worker packages from the stage child into parent Product state.
 * Keys: hard-stage:<stageId>:<workerFragment> so siblings Join without wipe.
 */
export function promoteStageSubagentPackagesToParent(
  parent: ToolRuntime,
  child: ToolRuntime,
  stageId: string,
): number {
  const packs = child.lifecycle?.subagentEvidenceCache || [];
  let n = 0;
  for (const pack of packs) {
    const cands = pack.candidates || [];
    if (!cands.length) continue;
    const rawId = String(pack.subagentId || `worker_${n}`);
    // Prefer short fragment after last path segment / sub_ prefix
    const fragment = rawId
      .replace(/^hard-stage:[^:]+:/, "")
      .replace(/^sub_/, "pkg_")
      .slice(0, 64);
    absorbStageResultIntoParent(parent, {
      stageId,
      workerId: fragment || `pkg_${n}`,
      structured: normalizeSubagentResult({
        ok: true,
        summary: pack.nodeType || stageId,
        candidates: cands,
        surfaces: [],
        deadends: [],
      }),
    });
    n += 1;
  }
  return n;
}

/**
 * StageExecutor: real child ToolRuntime + createBoundNode4Session (core-only Runtime).
 */
export function createHardGraphStageExecutor(options: {
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

    // A4: cookies from prior stages → this stage workDir (best-effort)
    await seedChildSessionFromParent(parentRuntime.taskDir, workDir).catch(() => ({
      seeded: false,
      detail: "seed failed",
    }));

    const systemPrompt = stageSystemPrompt(input, task);
    const userPrompt = stageUserPrompt(input, task);

    // Single session promote site (best-effort); absorb only on intentional returns.
    let sessionPromoted = false;
    const promoteSession = async () => {
      if (sessionPromoted) return;
      sessionPromoted = true;
      await promoteChildSessionToParent(workDir, parentRuntime.taskDir).catch(() => ({
        promoted: false,
        detail: "promote failed",
      }));
    };

    /**
     * A1 absorb (throws on failure) then A4 promote.
     * Absorb upserts by stageKey when candidates present (retry-safe).
     */
    const finalizeStage = async (opts: {
      structured: ReturnType<typeof normalizeSubagentResult>;
      child?: ToolRuntime;
      seed?: StageContinuitySeed;
      summaryOverride?: string;
    }): Promise<StageExecutorOutput> => {
      // Agent Graph Join first: worker packages from stage child → parent (distinct keys).
      if (opts.child) {
        promoteStageSubagentPackagesToParent(parentRuntime, opts.child, input.stage.id);
      }
      // Stage captain result.json candidates → parent pack hard-stage:<stageId>
      absorbStageResultIntoParent(parentRuntime, {
        stageId: input.stage.id,
        structured: opts.structured,
        child: opts.child,
        seed: opts.seed,
      });
      await promoteSession();
      return {
        structured: opts.structured,
        summary:
          opts.summaryOverride ??
          (opts.structured.summaryProvided ? opts.structured.summary : undefined),
      };
    };

    try {
      if (sessionFactory) {
        const out = await sessionFactory({
          stageId: input.stage.id,
          tools: input.tools,
          systemPrompt,
          userPrompt,
          workDir,
          abortSignal,
        });
        // Factory path: structured-only absorb (no child lifecycle). Documented for runner tests.
        const structured = normalizeSubagentResult(
          out.structured ?? {
            ok: false,
            summary: out.summary || `stage ${input.stage.id}: factory returned no structured`,
            surfaces: [],
            candidates: [],
            deadends: ["factory_no_structured"],
          },
        );
        return await finalizeStage({
          structured,
          summaryOverride:
            out.summary ?? (structured.summaryProvided ? structured.summary : undefined),
        });
      }

      const { childRuntime, packForStage } = buildChildRuntime({
        parent: parentRuntime,
        workDir,
        tools: input.tools,
        pack,
        abortSignal,
      });
      // A1: prior stage candidates + observations into book-capable stages
      const continuitySeed = seedStageLifecycleFromParent(parentRuntime, childRuntime);
      await childRuntime.processFacts?.ensureDir?.().catch(() => {});

      const failStructured = (summary: string, deadend: string) =>
        normalizeSubagentResult({
          ok: false,
          summary,
          surfaces: [],
          candidates: [],
          deadends: [deadend],
        });

      const { session } = await createBoundNode4Session({
        config,
        runtime: childRuntime,
        pack: packForStage,
        systemPrompt,
        thinkingLevel: "low",
      });

      try {
        if (abortSignal?.aborted) {
          return await finalizeStage({
            structured: failStructured("aborted before stage", "aborted"),
            child: childRuntime,
            seed: continuitySeed,
          });
        }
        if (abortSignal) {
          const onAbort = () => session.abort();
          abortSignal.addEventListener("abort", onAbort, { once: true });
          try {
            await session.prompt(userPrompt);
          } finally {
            abortSignal.removeEventListener("abort", onAbort);
          }
        } else {
          await session.prompt(userPrompt);
        }
      } catch (err) {
        if (abortSignal?.aborted) {
          return await finalizeStage({
            structured: failStructured("aborted", "aborted"),
            child: childRuntime,
            seed: continuitySeed,
          });
        }
        throw err;
      } finally {
        try {
          await Promise.resolve(session.dispose());
        } catch {
          /* ignore */
        }
      }

      const structured = await loadStageResultJson(workDir, input.stage.id);
      return await finalizeStage({
        structured,
        child: childRuntime,
        seed: continuitySeed,
      });
    } finally {
      // Promote once even on throw (no absorb of garbage structured).
      await promoteSession();
    }
  };
}
