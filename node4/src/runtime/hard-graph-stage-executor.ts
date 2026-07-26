/**
 * Core-only stage executor for Hard Graph (Graph × Pi).
 *
 * Builds a **real** child ToolRuntime (stores + parent platform) like subagent
 * sessions — no fake goals/evidence stubs. Agent Runtime via createBoundNode4Session.
 */

import { mkdir } from "node:fs/promises";
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
import { resetPackageAttemptsForStageRetry } from "./package-settlement-law.js";
import { ensureProcessQuality } from "./package-honesty-host.js";
import { ingestPackageCandidatesToStore } from "./finding-store.js";
import {
  settleHostStage,
  writeHostSettlementAudit,
} from "./host-stage-settlement.js";
import { SubagentHost } from "./subagent.js";
import type { Node4AgentSession } from "./run-node4-agent.js";

/**
 * Deposit host-trusted surfaces/candidates into ledger + Finding Store.
 * Spec #125: never read agent workdir result.json; never deposit narrative.
 * Callers pass hostInject only from explicit test inject or host-owned paths.
 */
async function depositHostTrustedStructured(
  runtime: ToolRuntime,
  stageId: string,
  hostInject?: SubagentStructuredResult,
): Promise<void> {
  if (!hostInject) return;
  if (hostInject.surfaces.length && runtime.surfaceLedger) {
    await runtime.surfaceLedger.upsertFromRecon(hostInject.surfaces).catch(() => {});
  }
  if (hostInject.candidates.length) {
    const fstore = ensureProcessQuality(runtime.lifecycle).findingStore;
    ingestPackageCandidatesToStore(fstore, hostInject.candidates, {
      package_id: `stage:${stageId}`,
      stage_id: stageId,
      agent_id: "stage_main",
    });
  }
}

export type HardGraphStageSessionFactory = (options: {
  stageId: string;
  tools: string[];
  systemPrompt: string;
  userPrompt: string;
  workDir: string;
  abortSignal?: AbortSignal;
}) => Promise<{
  /** Session narrative only — never deposited into Store/ledger. */
  structured?: unknown;
  summary?: string;
  /**
   * Explicit host-trusted inject for tests. Surfaces/candidates are deposited.
   * Must never be loaded from agent workdir result.json.
   */
  hostInject?: unknown;
}>;

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

/** Exported for harness contract tests (#101 / #125). */
export function stageSystemPrompt(input: StageExecutorInput, task: TaskEnvelope): string {
  const toolList = input.tools.length ? input.tools.join(", ") : "(none)";
  const allowSubagent = input.tools.includes("subagent");
  return [
    "You are a **Hard Graph stage agent** (Graph × Pi).",
    `Graph: ${input.graphId}  Stage: ${input.stage.id} (index ${input.stageIndex})`,
    input.stage.success ? `Stage success criteria: ${input.stage.success}` : "",
    "You do NOT schedule other stages. Complete only this stage.",
    `Allowed tools for this stage: ${toolList}`,
    "Briefly narrate progress in assistant text when useful (what you are checking next; what you observed). Do not invent surfaces, proof, or booked findings in prose.",
    "**Stage settlement is host-owned** (Spec #125): do **not** write result.json as the stage handoff or booking channel. Host projects stage outcome from Finding Store, package terminals, and surface ledger.",
    "Bookable candidates must land in **Finding Store** (package settlement auto-ingest, or finding(upsert) for serial Main work) with title, location, proof_excerpt (verbatim tool stdout/body ≥24 chars), optional poc.",
    "Surfaces for recon: use **fact(op=surface, location=…)** (host ledger) or package workers — never stage result.json as handoff.",
    "After L0 Feedback marks feedback_ok, Main books with finding(confirm, finding_id=…). Without proof_excerpt candidates stay non-confirmable. Narrative alone is not bookable.",
    "Do **not** create process-chore L2 todos (e.g. Write result.json, collect subagents, pure meta login prep).",
    allowSubagent
      ? [
          "Agent Graph (preferred when multi-class or multi-surface work is justified): fan-out with **subagent** packages[] (skill/path-scoped workers).",
          "Prefer packages over one long serial monologue across all vulnerability classes or surfaces.",
          "Each formal package **must** pass plan_node_id (L2 attack-class anchor). No hard package quotas.",
          "Anti-micro-spawn: do not split trivial single-GET chores into packages.",
          "Workers return structured candidates/surfaces with verbatim proof_excerpt; host settlement + Finding Store own Join — do not rephrase proof into a result.json ceremony.",
          "After packages start this stage: orchestrate + settle only (do not serial-erase package failure).",
          "No nested subagent inside workers. Stay in RoE/scope.",
          "Serial Main-only probing is allowed if packages are not justified (single surface / single class) — deposit Store/surfaces via host paths.",
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

/** Exported for harness contract tests (#101 / #125). */
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
      ? "Complete this stage only. Prefer subagent packages when multi-class work is justified; narrate briefly; settle via host/Store (no result.json handoff); then stop."
      : "Complete this stage only. Narrate briefly when useful; deposit surfaces via fact(op=surface) and candidates via finding(upsert) — do not use result.json as stage handoff; then stop.",
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
  // Run-wide process quality (Store + honesty + attempt budgets) — share object
  const processQuality = ensureProcessQuality(parent.lifecycle);
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
      processQuality,
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
      const pq = ensureProcessQuality(parentRuntime.lifecycle);
      resetPackageAttemptsForStageRetry(
        pq.packageAttemptCounts,
        pq.packageTerminals,
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
     * Spec #125: host settlement is sole stage outcome projector.
     * narrative = session text only (never deposited).
     * hostInject = explicit host-trusted deposit for tests (never agent result.json).
     */
    const finalizeStage = async (opts: {
      narrative?: {
        summary?: string;
        facts?: SubagentStructuredResult["facts"];
        notes?: string;
        deadends?: string[];
      };
      /** Explicit host-trusted inject only — deposited to Store/ledger. Not narrative. */
      hostInject?: SubagentStructuredResult;
      child?: ToolRuntime;
      seed?: StageContinuitySeed;
      /** Stage workdir for optional settlement audit (not gate input). */
      workDir?: string;
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
      const settleRuntime = opts.child || parentRuntime;
      // Warm ledger once, then deposit hostInject, then re-warm for projection.
      await settleRuntime.surfaceLedger?.load?.().catch(() => {});
      if (opts.hostInject) {
        await depositHostTrustedStructured(settleRuntime, input.stage.id, opts.hostInject);
        if (settleRuntime !== parentRuntime) {
          await depositHostTrustedStructured(parentRuntime, input.stage.id, opts.hostInject);
        }
        await settleRuntime.surfaceLedger?.load?.().catch(() => {});
      }

      const settlement = settleHostStage({
        stageId: input.stage.id,
        runtime: settleRuntime,
        narrative: opts.narrative,
      });
      const structuredOut = settlement.structured;
      if (opts.workDir) {
        await writeHostSettlementAudit(opts.workDir, settlement);
      }
      // Host projection → parent continuity (Store/ledger-backed, not agent file).
      absorbStageResultIntoParent(parentRuntime, {
        stageId: input.stage.id,
        structured: structuredOut,
        child: opts.child,
        seed: opts.seed,
      });
      await promoteSession();
      const findingsAfter = await countJsonFindings(parentRuntime.findingsDir);
      const bookedDelta = Math.max(0, findingsAfter - findingsBefore);
      const storeBooked = ensureProcessQuality(parentRuntime.lifecycle).findingStore.counts()
        .booked_n;
      return {
        structured: structuredOut,
        summary: structuredOut.summaryProvided ? structuredOut.summary : undefined,
        fanoutPackagesN,
        bookOutcomes:
          bookedDelta > 0 || input.stage.id === "validate_book"
            ? { booked_n: bookedDelta, reject_hints_n: 0 }
            : undefined,
        findingsBookedN: storeBooked,
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
        // Narrative from factory session only; hostInject is explicit deposit (tests).
        // Never launder agent structured into Store/ledger.
        const narrativeBody = out.structured
          ? normalizeSubagentResult(out.structured)
          : undefined;
        const hostInject = out.hostInject
          ? normalizeSubagentResult(out.hostInject)
          : undefined;
        return await finalizeStage({
          narrative: narrativeBody
            ? {
                summary:
                  out.summary ??
                  (narrativeBody.summaryProvided ? narrativeBody.summary : undefined),
                facts: narrativeBody.facts,
                notes: narrativeBody.notes,
                deadends: narrativeBody.deadends,
              }
            : out.summary
              ? { summary: out.summary }
              : undefined,
          hostInject,
          workDir,
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

      const failNarrative = (summary: string, deadend: string) => ({
        summary,
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
            narrative: failNarrative("aborted before stage", "aborted"),
            child: childRuntime,
            seed: continuitySeed,
            workDir,
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
            narrative: failNarrative("aborted", "aborted"),
            child: childRuntime,
            seed: continuitySeed,
            workDir,
          });
        }
      } catch (err) {
        if (abortSignal?.aborted) {
          return await finalizeStage({
            narrative: failNarrative("aborted", "aborted"),
            child: childRuntime,
            seed: continuitySeed,
            workDir,
          });
        }
        throw err;
      } finally {
        await sessionObs.dispose();
        // Merge stage usage into run-level ledger.
        graphRun?.usage.mergeSnapshot(
          stageUsage.snapshot({ tool_calls: obsCounters.toolCallCount }),
        );
        // I0.9 durable captain continue (same session resume) is not implemented;
        // interrupt ends Graph run; Case continue is a new burst. Always dispose.
        try {
          await Promise.resolve(session.dispose());
        } catch {
          /* ignore */
        }
      }

      // Spec #125: never load agent result.json; host settlement projects gate input.
      // Narrative summary only from real process facts (not synthetic fillers).
      let narrativeSummary: string | undefined;
      try {
        const facts = await childRuntime.processFacts?.list?.();
        if (Array.isArray(facts) && facts.length) {
          narrativeSummary = facts
            .slice(0, 5)
            .map((f: { key?: string; summary?: string; fact_key?: string }) =>
              f.summary || f.fact_key || f.key || "",
            )
            .filter(Boolean)
            .join("; ")
            .slice(0, 500);
        }
      } catch {
        /* ignore */
      }
      return await finalizeStage({
        narrative: narrativeSummary ? { summary: narrativeSummary } : undefined,
        child: childRuntime,
        seed: continuitySeed,
        workDir,
      });
    } finally {
      // Promote once even on throw (no absorb of garbage structured).
      await promoteSession();
    }
  };
}
