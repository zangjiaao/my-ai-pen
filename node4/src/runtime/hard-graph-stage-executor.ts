/**
 * Core-only stage executor for Hard Graph (Graph × Pi).
 *
 * Builds a **real** child ToolRuntime (stores + parent platform) like subagent
 * sessions — no fake goals/evidence stubs. Agent Runtime via runNode4Agent.
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
import { createNode4RuntimeBindings } from "./extension.js";
import type { StageExecutor, StageExecutorInput, StageExecutorOutput } from "./hard-graph-runner.js";
import { resolveNode4Model, runNode4Agent } from "./run-node4-agent.js";
import {
  absorbStageResultIntoParent,
  seedStageLifecycleFromParent,
  type StageContinuitySeed,
} from "./hard-graph-continuity.js";
import { normalizeSubagentResult } from "./subagent-result.js";
import {
  promoteChildSessionToParent,
  seedChildSessionFromParent,
} from "./subagent-session-seed.js";

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

      const model = resolveNode4Model(config);
      const segmentCounter = { tools: 0 };
      const bindings = createNode4RuntimeBindings(childRuntime, segmentCounter, packForStage);
      const session = await runNode4Agent({
        systemPrompt,
        tools: bindings.tools,
        model,
        thinkingLevel: "low",
        beforeToolCall: bindings.beforeToolCall,
        afterToolCall: bindings.afterToolCall,
        onAgent: bindings.attachAgent,
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
        return await finalizeStage({
          structured,
          child: childRuntime,
          seed: continuitySeed,
        });
      } catch {
        return await finalizeStage({
          structured: failStructured(
            `stage ${input.stage.id}: missing or invalid result.json`,
            "missing_result_json",
          ),
          child: childRuntime,
          seed: continuitySeed,
        });
      }
    } finally {
      // Promote once even on throw (no absorb of garbage structured).
      await promoteSession();
    }
  };
}
