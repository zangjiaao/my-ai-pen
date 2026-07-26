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
  attachNode4SessionObservability,
  CheckpointThrottle,
  PlatformTextStream,
  createUsageLedgerFromEnv,
  emitCheckpointUpdate,
  type ObservabilityContext,
} from "./platform-observability.js";
import { PanelAgentTracker } from "./panel-agents.js";
import {
  normalizeSubagentResult,
  type SubagentStructuredResult,
} from "./subagent-result.js";
import {
  promoteChildSessionToParent,
  seedChildSessionFromParent,
} from "./subagent-session-seed.js";
import {
  evaluateHonestPartial,
  filterPackageTerminalsForStage,
  resetPackageAttemptsForStageRetry,
  shouldDisposeCaptainSessionOnInterrupt,
} from "./package-settlement-law.js";
import { FindingStore } from "./finding-store.js";
import { SubagentHost } from "./subagent.js";
import type { Node4AgentSession } from "./run-node4-agent.js";

export type HardGraphStageSessionFactory = (options: {
  stageId: string;
  tools: string[];
  systemPrompt: string;
  userPrompt: string;
  workDir: string;
  abortSignal?: AbortSignal;
}) => Promise<{ structured: unknown; summary?: string }>;

/**
 * Test inject: replace createBoundNode4Session but still run observability attach.
 * Fake sessions must implement subscribe / prompt / dispose.
 */
export type HardGraphBoundSessionFactory = (options: {
  config: Node4Config;
  runtime: ToolRuntime;
  pack: RolePack;
  systemPrompt: string;
  thinkingLevel?: string;
}) => Promise<{ session: Node4AgentSession }>;

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

/** Exported for harness contract tests (#101). */
export function stageSystemPrompt(input: StageExecutorInput, task: TaskEnvelope): string {
  const toolList = input.tools.length ? input.tools.join(", ") : "(none)";
  const allowSubagent = input.tools.includes("subagent");
  return [
    "You are a **Hard Graph stage agent** (Graph × Pi).",
    `Graph: ${input.graphId}  Stage: ${input.stage.id} (index ${input.stageIndex})`,
    input.stage.success ? `Stage success criteria: ${input.stage.success}` : "",
    "You do NOT schedule other stages. Complete only this stage.",
    `Allowed tools for this stage: ${toolList}`,
    // Short progress narration (not fake findings) — workbench shows thinking/text streams.
    "Briefly narrate progress in assistant text when useful (what you are checking next; what you observed). Do not invent surfaces, proof, or booked findings in prose.",
    "When done, use the **write** tool to create **result.json** in the stage work dir (path: result.json) with fields:",
    "  ok, summary, surfaces[], candidates[], facts[], deadends[]",
    "Facts alone are not the stage handoff — Feedback reads result.json only.",
    "Bookable candidates MUST include: title, location (URL/path), proof_excerpt (verbatim tool stdout/body ≥24 chars), optional poc_hint.",
    "Without proof_excerpt the next stage cannot finding(confirm) — narrative notes alone are not bookable.",
    allowSubagent
      ? [
          "Agent Graph (preferred when multi-class or multi-surface work is justified): fan-out with **subagent** packages[] (skill/path-scoped workers).",
          "Prefer packages over one long serial monologue across all vulnerability classes or surfaces.",
          "Each formal package **must** pass plan_node_id (L2 attack-class anchor). No hard package quotas.",
          "Anti-micro-spawn: do not split trivial single-GET chores into packages.",
          "Workers return candidates[] with verbatim proof_excerpt; you Join into result.json candidates (do not rephrase proof).",
          "No nested subagent inside workers. Stay in RoE/scope.",
          "Serial Main-only probing is allowed if packages are not justified (single surface / single class) — do not invent package counts.",
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

/** Exported for harness contract tests (#101). */
export function stageUserPrompt(input: StageExecutorInput, task: TaskEnvelope): string {
  const allowSubagent = input.tools.includes("subagent");
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
    allowSubagent
      ? "Complete this stage only. Prefer subagent packages when multi-class work is justified; narrate briefly; write result.json; then stop."
      : "Complete this stage only. Narrate briefly when useful; use write to emit result.json; then stop.",
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
  // Resolve panel before host construction so package spawn can emit children.
  const sharedPanel =
    parent.lifecycle.hardGraphRun?.panel || parent.lifecycle.panelAgents;
  // Run-wide shared maps (must be same object on every stage child / retry)
  if (!parent.lifecycle.packageTerminals) parent.lifecycle.packageTerminals = {};
  if (!parent.lifecycle.packageTerminalAliasIndex) parent.lifecycle.packageTerminalAliasIndex = {};
  if (!parent.lifecycle.packageAttemptCounts) parent.lifecycle.packageAttemptCounts = {};
  if (!parent.lifecycle.findingStore) {
    parent.lifecycle.findingStore = new FindingStore();
  }
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
      hardGraphRun: parent.lifecycle.hardGraphRun,
      panelAgents: sharedPanel,
      // Spec #116: Store survives stages — share parent FindingStore (do not wipe)
      findingStore: parent.lifecycle.findingStore,
      packageTerminals: parent.lifecycle.packageTerminals,
      packageTerminalAliasIndex: parent.lifecycle.packageTerminalAliasIndex,
      // Spec #116 I0.1: attempt budget must not reset on new stage child / retry
      packageAttemptCounts: parent.lifecycle.packageAttemptCounts,
    },
  };
  if (allowSubagent) {
    childRuntime.subagents = new SubagentHost({
      task: parent.task,
      taskDir: workDir,
      evidence: childRuntime.evidence,
      platform: parent.platform,
      goals: childRuntime.goals!,
      // Share run-level panel tracker so Status collaboration tree sees workers.
      panelAgents: sharedPanel,
      // Package chips on L2 Tasks map from start/end events (not stage-finally panel scan).
      hardGraphPlan: () => parent.lifecycle.hardGraphRun?.plan,
      stageId: () => parent.lifecycle.hardGraphRun?.stageId,
    });
  }
  return { childRuntime, packForStage };
}

/** @deprecated use buildHardGraphStageChildRuntime */
const buildChildRuntime = buildHardGraphStageChildRuntime;

async function countJsonFindings(findingsDir: string): Promise<number> {
  try {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(findingsDir);
    return files.filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

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
  /** Structured-only shortcut (skips pi session + observability). For runner unit tests. */
  sessionFactory?: HardGraphStageSessionFactory;
  /**
   * Test inject: fake bound session that still goes through observability attach
   * (unlike sessionFactory, which skips the real stage path).
   */
  boundSessionFactory?: HardGraphBoundSessionFactory;
  abortSignal?: AbortSignal;
}): StageExecutor {
  const { config, parentRuntime, pack, sessionFactory, boundSessionFactory, abortSignal } = options;
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

    // Spec #116 I0.6: new stage attempt resets non-success package attempt budgets
    const stageAttempt = Math.max(1, Math.floor(input.stageAttempt || 1));
    if (stageAttempt > 1) {
      if (!parentRuntime.lifecycle.packageAttemptCounts) {
        parentRuntime.lifecycle.packageAttemptCounts = {};
      }
      if (!parentRuntime.lifecycle.packageTerminals) {
        parentRuntime.lifecycle.packageTerminals = {};
      }
      resetPackageAttemptsForStageRetry(
        parentRuntime.lifecycle.packageAttemptCounts,
        parentRuntime.lifecycle.packageTerminals,
        input.stage.id,
      );
    }

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
      let fanoutPackagesN = 0;
      if (opts.child) {
        fanoutPackagesN = promoteStageSubagentPackagesToParent(
          parentRuntime,
          opts.child,
          input.stage.id,
        );
      }
      // Spec #116 I0.2–3: honest partial for THIS STAGE only (not residual prior-stage terminals)
      let structuredOut = opts.structured;
      {
        const stageId = input.stage.id;
        const terminals =
          opts.child?.lifecycle.packageTerminals || parentRuntime.lifecycle.packageTerminals || {};
        const packages = filterPackageTerminalsForStage(terminals, stageId);
        if (packages.length) {
          const failedKeys = packages
            .filter((p) => p.terminal === "failed" || p.terminal === "never_started")
            .map((p) => p.package_key);
          const declared = new Set(
            [
              ...(structuredOut.deadends || []),
              ...((structuredOut as { failed_packages?: string[] }).failed_packages || []),
            ].map(String),
          );
          const declaredFailed = failedKeys.filter(
            (k) => declared.has(k) || [...declared].some((d) => d.includes(k) || k.includes(d)),
          );
          const honesty = evaluateHonestPartial({
            packages,
            declared_failed_keys: declaredFailed,
            claims_full_success: structuredOut.ok === true && failedKeys.length > 0,
          });
          if (honesty.undeclared_failures.length) {
            structuredOut = normalizeSubagentResult({
              ok: false,
              summary: structuredOut.summaryProvided
                ? `${structuredOut.summary} [silent partial undeclared fails]`
                : `silent partial: undeclared package failures: ${honesty.undeclared_failures.join(",")}`,
              surfaces: structuredOut.surfaces,
              candidates: structuredOut.candidates,
              facts: structuredOut.facts,
              deadends: [
                ...(structuredOut.deadends || []),
                ...honesty.undeclared_failures.map((k) => `undeclared_package_fail:${k}`),
              ],
            });
          }
        }
      }
      // Stage captain result.json candidates → parent pack hard-stage:<stageId>
      absorbStageResultIntoParent(parentRuntime, {
        stageId: input.stage.id,
        structured: structuredOut,
        child: opts.child,
        seed: opts.seed,
      });
      await promoteSession();
      const findingsAfter = await countJsonFindings(parentRuntime.findingsDir);
      const bookedDelta = Math.max(0, findingsAfter - findingsBefore);
      return {
        structured: structuredOut,
        summary:
          opts.summaryOverride ??
          (structuredOut.summaryProvided ? structuredOut.summary : undefined),
        fanoutPackagesN,
        bookOutcomes:
          bookedDelta > 0 || input.stage.id === "validate_book"
            ? { booked_n: bookedDelta, reject_hints_n: 0 }
            : undefined,
      };
    };

    // Snapshot findings count before stage for book_outcomes delta.
    const findingsBefore = await countJsonFindings(parentRuntime.findingsDir);

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

      // Mark current stage for todo → L2 merge and package chips.
      const graphRun = parentRuntime.lifecycle.hardGraphRun;
      if (graphRun) graphRun.stageId = input.stage.id;

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

      // Free-path observability parity: usage, thinking/text stream, checkpoints, panel.
      const panel =
        graphRun?.panel ||
        parentRuntime.lifecycle.panelAgents ||
        new PanelAgentTracker(
          `stage ${input.stage.id}`,
          (typeof task.expertName === "string" && task.expertName.trim()) || pack.id || "Expert",
        );
      if (graphRun) graphRun.panel = panel;
      parentRuntime.lifecycle.panelAgents = panel;
      childRuntime.lifecycle.panelAgents = panel;
      panel.setMainActivity({
        phase: "starting",
        detail: `Graph stage ${input.stage.id}`,
      });

      const stageUsage = createUsageLedgerFromEnv();
      const textStream = new PlatformTextStream(parentRuntime.platform, task);
      const checkpointThrottle = new CheckpointThrottle();
      const obsCounters = {
        toolCallCount: 0,
        activeTool: undefined as string | undefined,
        phase: `hard_graph:${input.stage.id}`,
      };
      const obsCtx: ObservabilityContext = {
        platform: parentRuntime.platform,
        task,
        runtime: childRuntime,
        goals: childRuntime.goals || new GoalStore(),
        usage: stageUsage,
        panel,
        startedAt: new Date().toISOString(),
        rolePackId: pack.id,
        counters: obsCounters,
      };

      const boundOpts = {
        config,
        runtime: childRuntime,
        pack: packForStage,
        systemPrompt,
        // Match free Expert non-chat default (not silent "low").
        thinkingLevel: "medium" as const,
      };
      const { session } = boundSessionFactory
        ? await boundSessionFactory(boundOpts)
        : await createBoundNode4Session(boundOpts);

      const sessionObs = attachNode4SessionObservability({
        session,
        obsCtx,
        textStream,
        checkpointThrottle,
      });

      // Initial checkpoint so Status has a live panel row for this stage.
      await emitCheckpointUpdate(obsCtx).catch(() => {});

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
        // Spec #116 I0.7: abort may cancel turn without throw — still fail-closed aborted.
        if (abortSignal?.aborted) {
          return await finalizeStage({
            structured: failStructured("aborted", "aborted"),
            child: childRuntime,
            seed: continuitySeed,
          });
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
        await sessionObs.dispose();
        // Merge stage usage into run-level ledger.
        graphRun?.usage.mergeSnapshot(
          stageUsage.snapshot({ tool_calls: obsCounters.toolCallCount }),
        );
        // Spec #116 I0.9: UI interrupt cancels turn only — captain session survives.
        // Park interrupted captain; dispose only on normal stage completion.
        const interrupted = Boolean(abortSignal?.aborted);
        if (interrupted && !shouldDisposeCaptainSessionOnInterrupt()) {
          if (!parentRuntime.lifecycle.parkedCaptainSessions) {
            parentRuntime.lifecycle.parkedCaptainSessions = {};
          }
          const prev = parentRuntime.lifecycle.parkedCaptainSessions[input.stage.id];
          if (prev && prev !== session) {
            try {
              await Promise.resolve(prev.dispose());
            } catch {
              /* ignore */
            }
          }
          parentRuntime.lifecycle.parkedCaptainSessions[input.stage.id] = session;
        } else {
          // Package chips are upserted on subagent start/end (SubagentHost), not a panel scan.
          try {
            await Promise.resolve(session.dispose());
          } catch {
            /* ignore */
          }
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
