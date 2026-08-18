/**
 * Core-only stage executor for Hard Graph (Graph × Pi).
 *
 * Builds a **real** child ToolRuntime (stores + parent platform) like subagent
 * sessions — no fake goals/evidence stubs. Agent Runtime via createBoundNode4Session.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ensurePiInstanceWorkspace,
  mintPiSessionId,
  resolvePiInstanceDir,
} from "./session-workspace.js";
import type { Node4Config } from "../config.js";
import type { RolePack } from "../roles/types.js";
import type { TaskEnvelope, ToolRuntime } from "../types.js";
import { EvidenceStore } from "../stores/evidence.js";
import { GoalStore } from "../stores/goal.js";
import { ProcessFactStore } from "../stores/process-fact.js";
import { TodoStore } from "../stores/todo.js";
import type { StageExecutor, StageExecutorInput, StageExecutorOutput } from "./hard-graph-runner.js";
import { createBoundNode4Session } from "./run-node4-agent.js";
import { registerActiveSession } from "./active-session-registry.js";
import {
  applyCaptainEndDisposition,
  decideParkOnEnd,
} from "./working-session-park.js";
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
import { formatPriorSnapshotInjection } from "./prior-seed.js";
import {
  buildL1InputFromProductState,
  runL1Critic,
} from "./l1-critic.js";
import { ensureGraphRunQuality } from "./graph-run-quality.js";
import {
  evaluateEmptyBookGate,
  formatEmptyBookRepairBrief,
  formatFeedbackOkCaptainSurface,
  isBookingOnlyStage,
  type ConfirmableFeedbackOkRow,
} from "./book-stage-completeness.js";
import {
  formatConfirmedNotSeededProjection,
  formatHypothesisQueueInjection,
  isHypothesisWorkModeOn,
} from "./hypothesis-store.js";
import {
  buildEngagementRouteSlicesFromProductState,
  buildRouteStructuredFromProcessFacts,
  parseExploitFailedFromStructured,
  parseNeedMoreSignalFromStructured,
  parseRouteChoiceKeyFromStructured,
} from "./engagement-graph-route.js";
import {
  formatSkillL1CatalogInjection,
  loadSkillL1Catalog,
} from "./skill-l1-catalog.js";
import { extractLlmTurnError, isLlmTurnError } from "./llm-turn-error.js";
import {
  idleTimeoutLlmTurnError,
  mapPromptFailureToLlmTurnError,
  surfaceLlmTurnFailure,
} from "./llm-turn-surface.js";
// Stage system-prompt layers live in the canonical prompt module (#393).
import {
  buildStagePromptLayers,
  stageIntentPromptLines,
  stageSystemPrompt,
} from "./prompt.js";

// Thin re-exports for test / harness import stability (#393).
export { buildStagePromptLayers, stageIntentPromptLines, stageSystemPrompt };

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
  if (hostInject.surfaces.length) {
    // Spec #371: SQLite working store is coverage SoT; legacy JSON only as test fallback.
    if (runtime.surfaceSqlite) {
      await runtime.surfaceSqlite.open().catch(() => {});
      await runtime.surfaceSqlite.upsertFromRecon(hostInject.surfaces).catch(() => {});
    } else if (runtime.surfaceLedger) {
      await runtime.surfaceLedger.upsertFromRecon(hostInject.surfaces).catch(() => {});
    }
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
export function stageUserPrompt(
  input: StageExecutorInput,
  task: TaskEnvelope,
  options?: {
    /** Host-owned confirmable Store rows for book stages (#161 / #192). */
    confirmableFeedbackOk?: ConfirmableFeedbackOkRow[];
  },
): string {
  const allowSubagent = input.tools.includes("subagent");
  const bookStage = isBookingOnlyStage(input.stage);
  const allowFinding = input.tools.includes("finding");
  const repair =
    typeof input.l0RepairBrief === "string" && input.l0RepairBrief.trim()
      ? ["", input.l0RepairBrief.trim(), ""]
      : [];
  const captain =
    bookStage && options?.confirmableFeedbackOk
      ? ["", formatFeedbackOkCaptainSurface(options.confirmableFeedbackOk), ""]
      : bookStage
        ? ["", formatFeedbackOkCaptainSurface([]), ""]
        : [];
  const confirmedNotSeeded = input.confirmedNotSeededInjection || "";
  const footer = bookStage
    ? "Complete this book stage only. Use finding(list) then finding(confirm, finding_id=…) for confirmable Store rows; do not invent ids; do not stop with zero confirms while feedback_ok remain; settle via host/Store (no result.json handoff). Book L0 consumes Store only — hypothesis queue is informational."
    : allowSubagent
      ? "Complete this stage only. Prefer subagent packages when multi-class work is justified; narrate briefly; settle via host/Store (no result.json handoff); then stop."
      : "Complete this stage only. Narrate briefly when useful; explore so Traffic settles into Surface; candidates via finding(upsert); surface(summary|list) for coverage — do not use result.json as stage handoff; then stop.";
  return [
    `### Hard Graph stage: ${input.stage.id}`,
    input.stage.success || "",
    ...repair,
    ...captain,
    confirmedNotSeeded,
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
    allowFinding && bookStage
      ? "Primary tools this stage: finding (list/confirm). Other deposit tools are secondary."
      : "",
    footer,
  ]
    .filter((x) => x !== undefined && x !== null)
    .join("\n");
}

/** Re-export for tests / runner repair brief. */
export { formatEmptyBookRepairBrief, isBookingOnlyStage };

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
    caseDir: parent.caseDir,
    sessionDir: parent.sessionDir,
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
    surfaceSqlite: parent.surfaceSqlite,
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
      skillBodyFingerprints:
        parent.lifecycle.skillBodyFingerprints ||
        (parent.lifecycle.skillBodyFingerprints = {}),
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
    const expertId = String(task.expertId || pack.id || "").trim();
    const stageSid = mintPiSessionId();
    const workDir =
      parentRuntime.workspaceDir && task.conversationId && expertId
        ? resolvePiInstanceDir(
            parentRuntime.workspaceDir,
            task.conversationId,
            expertId,
            stageSid,
          )
        : join(
            parentRuntime.taskDir,
            "hard-graph",
            input.graphId,
            `stage-${input.stageIndex}-${input.stage.id}`,
          );
    await ensurePiInstanceWorkspace(workDir);
    await mkdir(join(workDir, "evidence"), { recursive: true });

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
    await seedChildSessionFromParent(parentRuntime.sessionDir || parentRuntime.taskDir, workDir).catch(() => ({
      seeded: false,
      detail: "seed failed",
    }));

    const gq = ensureGraphRunQuality(parentRuntime.lifecycle.hardGraphRun);
    const priorSnapshot = gq?.priorSeed
      ? formatPriorSnapshotInjection(gq.priorSeed)
      : "";
    // Spec #274: stage flag + Main tool gate on hardGraphRun
    const hypMode = isHypothesisWorkModeOn(input.stage);
    if (parentRuntime.lifecycle.hardGraphRun) {
      parentRuntime.lifecycle.hardGraphRun.stageId = input.stage.id;
      parentRuntime.lifecycle.hardGraphRun.hypothesisWorkMode = hypMode;
    }
    const pqForStage = ensureProcessQuality(parentRuntime.lifecycle);
    const hypothesisQueueInjection = hypMode
      ? formatHypothesisQueueInjection(pqForStage.hypothesisStore)
      : "";
    // Wave 2: host L1 skill catalog when skill is on the tool surface (orthogonal to hyp mode)
    let skillL1CatalogInjection = "";
    if (input.tools.includes("skill") && parentRuntime.skills) {
      const l1 = await loadSkillL1Catalog(parentRuntime.skills, pack.skillIds);
      skillL1CatalogInjection = formatSkillL1CatalogInjection(l1);
    }
    const bookStage = isBookingOnlyStage(input.stage);
    const pqForBook = pqForStage;
    const confirmableAtStart: ConfirmableFeedbackOkRow[] = bookStage
      ? pqForBook.findingStore
          .snapshot()
          .filter((r) => r.status === "feedback_ok")
          .map((r) => ({
            id: r.id,
            title: r.title,
            severity: r.severity,
          }))
      : [];
    const storeBookedBefore = bookStage ? pqForBook.findingStore.counts().booked_n : 0;
    const confirmedNotSeededInjection = bookStage
      ? formatConfirmedNotSeededProjection(pqForBook.hypothesisStore, pqForBook.findingStore)
      : "";
    // Typed StagePromptExtras on StageExecutorInput (no cast)
    const promptInput: StageExecutorInput = {
      ...input,
      priorSnapshot,
      hypothesisQueueInjection,
      skillL1CatalogInjection,
      confirmedNotSeededInjection,
    };
    const systemPrompt = stageSystemPrompt(promptInput, task, pack);
    const userPrompt = stageUserPrompt(promptInput, task, {
      confirmableFeedbackOk: bookStage ? confirmableAtStart : undefined,
    });

    // Single session promote site (best-effort); absorb only on intentional returns.
    let sessionPromoted = false;
    const promoteSession = async () => {
      if (sessionPromoted) return;
      sessionPromoted = true;
      await promoteChildSessionToParent(workDir, parentRuntime.sessionDir || parentRuntime.taskDir).catch(() => ({
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
      /**
       * Spec #285 G2/G3: original stage structured payload for typed route signals only
       * (route_choice_key / choice_key / exploit_failed / need_more_signal).
       * Passed as raw to S4 — never scraped from free-text facts/deadends/notes.
       */
      routeStructured?: unknown;
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
      // Warm surface working store, then deposit hostInject, then re-read for projection (#371 SQLite).
      await settleRuntime.surfaceSqlite?.open?.().catch(() => {});
      await settleRuntime.surfaceLedger?.load?.().catch(() => {});
      if (opts.hostInject) {
        await depositHostTrustedStructured(settleRuntime, input.stage.id, opts.hostInject);
        if (settleRuntime !== parentRuntime) {
          await depositHostTrustedStructured(parentRuntime, input.stage.id, opts.hostInject);
        }
        await settleRuntime.surfaceSqlite?.open?.().catch(() => {});
        await settleRuntime.surfaceLedger?.load?.().catch(() => {});
      }

      const settlement = await settleHostStage({
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
      const pq = ensureProcessQuality(parentRuntime.lifecycle);
      const storeBooked = pq.findingStore.counts().booked_n;
      const storeBookedDelta = bookStage
        ? Math.max(0, storeBooked - storeBookedBefore)
        : bookedDelta;
      // Spec #125 / #130: captain machine surface for confirmable Store ids.
      const feedbackOkIds = settlement.feedback_ok_ids;

      // Spec #139 D3 / NC-L1: build Product-state critic input; l0Passed = honesty only.
      // Runner owns structure gate + L1 refine budget application (refine_n).
      const gqState = ensureGraphRunQuality(parentRuntime.lifecycle.hardGraphRun);
      const honestyFlags: string[] = [];
      if (settlement.honesty) {
        if (!settlement.honesty.ok) honestyFlags.push("package_honesty");
        if (settlement.honesty.silent_partial) honestyFlags.push("silent_partial");
      }
      const l0HonestyOk = Boolean(settlement.honesty?.ok);

      // #161 / #193 hybrid empty-book: fail-closed before unbookable accounting / L1
      const emptyBook = evaluateEmptyBookGate({
        isBookStage: bookStage,
        confirmableFeedbackOkAtStart: confirmableAtStart.length,
        storeBookedDelta,
      });
      let structuredFinal = structuredOut;
      if (!emptyBook.ok) {
        structuredFinal = normalizeSubagentResult(
          {
            ok: false,
            summary: structuredOut.summaryProvided
              ? structuredOut.summary
              : `empty_book: ${confirmableAtStart.length} feedback_ok unconfirmed`,
            surfaces: structuredOut.surfaces,
            candidates: structuredOut.candidates,
            facts: structuredOut.facts,
            deadends: [
              ...(structuredOut.deadends || []),
              emptyBook.error,
              `confirmable_feedback_ok_at_start:${confirmableAtStart.length}`,
              `store_booked_delta:${storeBookedDelta}`,
            ],
          },
          structuredOut.summaryProvided
            ? structuredOut.summary
            : `empty_book: ${confirmableAtStart.length} feedback_ok unconfirmed`,
        );
      }

      const l1Input = buildL1InputFromProductState({
        stageId: input.stage.id,
        stageSummary: structuredFinal.summaryProvided ? structuredFinal.summary : undefined,
        store: pq.findingStore,
        fanoutPackagesN,
        honestyFlags,
        surfaceSummary: ((await settleRuntime.surfaceSqlite?.summary?.()) ??
          settleRuntime.surfaceLedger?.summary?.()) as
          | { total?: number; open?: number; probed?: number; booked?: number }
          | undefined,
      });
      // NC-Honesty-Advance / NC-L1: L1 only after stage L0 honesty pass; never polish L0-fail brief.
      // Empty-book fail is structure L0 — still skip L1 when honesty failed; when honesty ok but empty book, skip L1 polish of fail.
      let l1Payload: { decision: "pass" | "refine"; gaps: string[] } | undefined;
      if (l0HonestyOk && emptyBook.ok) {
        const l1Out = await runL1Critic({ l0Passed: true, input: l1Input });
        l1Payload = { decision: l1Out.decision, gaps: l1Out.gaps };
        if (gqState) {
          const prev = gqState.l1ByStage[input.stage.id] || { refine_n: 0 };
          prev.last = { decision: l1Out.decision, gaps: l1Out.gaps };
          gqState.l1ByStage[input.stage.id] = prev;
        }
      } else if (gqState) {
        const prev = gqState.l1ByStage[input.stage.id] || { refine_n: 0 };
        prev.last = {
          decision: "skipped_l0_fail",
          gaps: emptyBook.ok ? honestyFlags : [emptyBook.error, ...honestyFlags],
        };
        gqState.l1ByStage[input.stage.id] = prev;
      }

      // Unbookable accounting only on successful book path (not empty-book fail — keep feedback_ok for retry)
      if (input.stage.unbookable_on_exit && gqState && emptyBook.ok) {
        for (const r of pq.findingStore.snapshot()) {
          if (r.status !== "feedback_ok") continue;
          if (gqState.unbookable.some((u) => u.finding_id === r.id)) continue;
          gqState.unbookable.push({
            finding_id: r.id,
            reason: "feedback_ok_not_confirmed_at_validate_book",
          });
        }
      }

      const unbookableN = gqState?.unbookable?.length || 0;

      // Spec #285 S4: Product-state route projection from hypothesis queue + Finding Store + surfaces.
      // Full snapshot each settle (not sticky). Gate choice from structured Main output only.
      const surfaceSummary =
        ((await settleRuntime.surfaceSqlite?.summary?.()) ??
          settleRuntime.surfaceLedger?.summary?.()) as
          | { total?: number; open?: number; probed?: number; booked?: number }
          | undefined;
      const surfacesFromLedger =
        typeof surfaceSummary?.total === "number"
          ? surfaceSummary.total
          : typeof surfaceSummary?.open === "number" &&
              typeof surfaceSummary?.probed === "number"
            ? (surfaceSummary.open || 0) + (surfaceSummary.probed || 0)
            : structuredFinal.surfaces?.length || 0;
      // G2/G3 typed route bag: merge session structured + process-fact Product deposit + settlement raw.
      // First non-empty signal wins per field. Never invent from free-text deadends/notes prose.
      let processFactRoute: Record<string, unknown> | null = null;
      try {
        const factStore = opts.child?.processFacts || parentRuntime.processFacts;
        const index = factStore?.list ? await factStore.list() : [];
        processFactRoute = buildRouteStructuredFromProcessFacts(index);
      } catch {
        processFactRoute = null;
      }
      const routeMerged: Record<string, unknown> = {};
      for (const c of [opts.routeStructured, processFactRoute, structuredFinal.raw]) {
        if (c == null) continue;
        const bag = { raw: c };
        const choice = parseRouteChoiceKeyFromStructured(bag);
        if (choice && routeMerged.route_choice_key == null) {
          routeMerged.route_choice_key = choice;
        }
        if (
          parseExploitFailedFromStructured(bag) &&
          routeMerged.exploit_failed == null
        ) {
          routeMerged.exploit_failed = true;
        }
        if (
          parseNeedMoreSignalFromStructured(bag) &&
          routeMerged.need_more_signal == null
        ) {
          routeMerged.need_more_signal = true;
        }
      }
      const routeRaw =
        Object.keys(routeMerged).length > 0 ? routeMerged : structuredFinal.raw;
      const routeSlices = buildEngagementRouteSlicesFromProductState({
        stageId: input.stage.id,
        hypotheses: pq.hypothesisStore.snapshot().map((r) => ({
          status: r.status,
          signal: r.signal,
          prove_if: r.prove_if,
          disprove_if: r.disprove_if,
          statement: r.statement,
        })),
        findings: pq.findingStore.snapshot().map((r) => ({
          status: r.status,
          title: r.title,
        })),
        surfaces_n: Math.max(
          surfacesFromLedger,
          structuredFinal.surfaces?.length || 0,
          input.handoff?.surfaces?.length || 0,
        ),
        structured: {
          // facts/deadends/notes retained for non-routing consumers; S4 parsers ignore them
          facts: structuredFinal.facts,
          deadends: structuredFinal.deadends,
          notes: structuredFinal.notes,
          raw: routeRaw,
        },
      });

      return {
        structured: structuredFinal,
        summary: structuredFinal.summaryProvided ? structuredFinal.summary : undefined,
        fanoutPackagesN,
        bookOutcomes:
          storeBookedDelta > 0 ||
          bookedDelta > 0 ||
          input.stage.unbookable_on_exit ||
          input.stage.id === "validate_book"
            ? {
                booked_n: storeBookedDelta > 0 ? storeBookedDelta : bookedDelta,
                reject_hints_n: unbookableN,
              }
            : undefined,
        findingsBookedN: storeBooked,
        ...(feedbackOkIds.length ? { feedbackOkIds } : {}),
        ...(l1Payload ? { l1: l1Payload } : {}),
        routeProjection: routeSlices.routeProjection,
        ...(routeSlices.routeChoiceKey
          ? { routeChoiceKey: routeSlices.routeChoiceKey }
          : {}),
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
        // routeStructured keeps typed G2/G3 routing fields (choice_key / exploit_failed / …).
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
          routeStructured: out.structured,
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
        sessionId: stageSid,
      };
      const { session } = boundSessionFactory
        ? await boundSessionFactory(boundOpts)
        : await createBoundNode4Session(boundOpts);

      // Collab copy: bind pi Agent.sessionId onto shared panel Main.
      const piSid = String(session.sessionId || "").trim();
      if (piSid) {
        obsCtx.agentSessionId = piSid;
        try {
          panel.setAgentSessionId(piSid);
        } catch {
          /* ignore */
        }
      }

      // Mid-run user_steer → current Graph Main stage (replace on stage switch).
      // Do not register subagent package sessions for conversation-level steer.
      const unregisterActiveSession = registerActiveSession({
        conversationId: task.conversationId,
        taskId: task.taskId,
        steer: (text) => session.steer(text),
        followUp: (text) => session.followUp(text),
      });

      // Spec #353: stream health + idle abort for Graph Main stage (same rules as Free).
      const sessionObs = attachNode4SessionObservability({
        session,
        obsCtx,
        textStream,
        checkpointThrottle,
        onIdleAbort: () => {
          try {
            session.abort();
          } catch {
            /* best-effort */
          }
        },
      });

      // Initial checkpoint so Status has a live panel row for this stage (+ session_id).
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
        // Spec #353: idle abort is fail-closed LlmTurnError (not user cancel).
        if (obsCtx.streamHealth?.isIdleAbortRequested) {
          throw await surfaceLlmTurnFailure({
            platform: parentRuntime.platform,
            conversationId: task.conversationId,
            taskId: task.taskId,
            textStream,
            health: obsCtx.streamHealth,
            error: idleTimeoutLlmTurnError(obsCtx.streamHealth),
          });
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
        // Soft LLM failure (403 etc.): single surface — not silent empty settle.
        const llmErr = extractLlmTurnError(session.messages);
        if (llmErr) {
          throw await surfaceLlmTurnFailure({
            platform: parentRuntime.platform,
            conversationId: task.conversationId,
            taskId: task.taskId,
            textStream,
            health: obsCtx.streamHealth,
            providerMessage: llmErr,
          });
        }
        if (obsCtx.streamHealth && obsCtx.streamHealth.state !== "terminal") {
          obsCtx.streamHealth.terminalSuccess();
        }
      } catch (err) {
        // Already surfaced in try-body (idle/soft LLM) — rethrow without double publish.
        if (isLlmTurnError(err) && err.diagnosis) throw err;
        // Spec #353: structured map only (idle / incomplete / LlmTurnError).
        const mapped = mapPromptFailureToLlmTurnError(err, obsCtx.streamHealth);
        if (mapped) {
          throw await surfaceLlmTurnFailure({
            platform: parentRuntime.platform,
            conversationId: task.conversationId,
            taskId: task.taskId,
            textStream,
            health: obsCtx.streamHealth,
            error: mapped,
          });
        }
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
        try {
          unregisterActiveSession();
        } catch {
          /* ignore */
        }
        await sessionObs.dispose();
        // Merge stage usage into run-level ledger.
        graphRun?.usage.mergeSnapshot(
          stageUsage.snapshot({ tool_calls: obsCounters.toolCallCount }),
        );
        // Spec #283 I0.9 + #354: interrupt/stage settle → park; Case/Session dispose pending → dispose.
        // #282 mode wire remains: incomplete continue → Hard path; attach uses park when present.
        // Spec #354 L4: park Session-owned Todo/TaskMap on parentRuntime (Graph plan lives there).
        // Stage child TodoStore is stage-local tool scratch; Session continuity uses parent.
        applyCaptainEndDisposition({
          decision: decideParkOnEnd({
            aborted: Boolean(abortSignal?.aborted),
          }),
          entry: {
            conversationId: task.conversationId,
            expertId: String(task.expertId || pack.id || ""),
            workMode: "graph",
            graphId:
              String(input.graphId || task.graphId || task.engagementTemplate || "") ||
              undefined,
            stageId: input.stage.id,
            taskId: task.taskId,
            session,
            todo: parentRuntime.todo,
            accounts: task.accounts,
            runtime: parentRuntime,
            dispose: () => {
              try {
                void Promise.resolve(session.dispose());
              } catch {
                /* ignore */
              }
            },
          },
        });
      }

      // Spec #125: never load agent result.json; host settlement projects gate input.
      // Narrative summary only from real process facts (not synthetic fillers).
      // Spec #285 G3: typed Gate/retry flags via exact process-fact keys (fact tool deposit),
      // not free-text scrape — finalizeStage maps whitelist keys → routeStructured bag.
      let narrativeSummary: string | undefined;
      let routeFromFacts: Record<string, unknown> | null = null;
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
          routeFromFacts = buildRouteStructuredFromProcessFacts(facts);
        }
      } catch {
        /* ignore */
      }
      return await finalizeStage({
        narrative: narrativeSummary ? { summary: narrativeSummary } : undefined,
        // Explicit Product deposit for live pi path (same S4 parsers as sessionFactory)
        ...(routeFromFacts ? { routeStructured: routeFromFacts } : {}),
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
