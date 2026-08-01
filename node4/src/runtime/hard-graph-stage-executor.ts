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
import { formatAgentLanguageInjection } from "./agent-language.js";
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
  formatSkillL1CatalogInjection,
  loadSkillL1Catalog,
} from "./skill-l1-catalog.js";

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
/** Data-driven stage intent text (Spec #139 I5) — prefers stage.intent over stage id. */
export function stageIntentPromptLines(stage: {
  id: string;
  intent?: string;
}): string {
  const intent = String(stage.intent || stage.id || "").toLowerCase();
  if (intent === "surface") {
    return [
      "**Stage intent (surface — Spec #139 I5):** inventory + **bounded smoke** only.",
      "Bounded smoke = short characterize-or-deadend per observed surface (login form shape, param names, auth requirement) — not multi-class exploitation campaigns.",
      "Multi-class depth belongs in class_probe+ stages. Do not treat recon as full exploit.",
      "No candidates_min class quota; opportunistic smoke candidates may deposit but are not required for gate.",
      "Do not call finding(confirm) on this stage (tool profile forbids).",
    ].join(" ");
  }
  if (intent === "init") {
    return "Init: RoE + target understanding only; no live recon. Acknowledge priors loaded or honest empty-prior from host seed.";
  }
  if (intent === "book") {
    return "Book stage: confirm feedback_ok Store rows by finding_id only; leftover feedback_ok become explicit unbookable reasons.";
  }
  return "";
}

export function stageSystemPrompt(input: StageExecutorInput, task: TaskEnvelope): string {
  const toolList = input.tools.length ? input.tools.join(", ") : "(none)";
  const allowSubagent = input.tools.includes("subagent");
  const allowFinding = input.tools.includes("finding");
  const allowHypothesis = input.tools.includes("hypothesis");
  const hypMode = isHypothesisWorkModeOn(input.stage);
  const intentLines = stageIntentPromptLines(input.stage);
  // Typed StagePromptExtras (prior / hyp queue / skill L1) — no cast soup
  const priorSeed = input.priorSnapshot || "";
  const hypothesisBlock = input.hypothesisQueueInjection || "";
  const skillL1Block = input.skillL1CatalogInjection || "";
  return [
    "You are a **Hard Graph stage agent** (Graph × Pi).",
    `Graph: ${input.graphId}  Stage: ${input.stage.id} (index ${input.stageIndex})`,
    input.stage.success ? `Stage success criteria: ${input.stage.success}` : "",
    "You do NOT schedule other stages. Complete only this stage.",
    `Allowed tools for this stage: ${toolList}`,
    intentLines,
    "Briefly narrate progress in assistant text when useful (what you are checking next; what you observed). Do not invent surfaces, proof, or booked findings in prose.",
    "**Stage settlement is host-owned** (Spec #125): do **not** write result.json as the stage handoff or booking channel. Host projects stage outcome from Finding Store, package terminals, and surface ledger.",
    "Bookable candidates must land in **Finding Store** (package settlement auto-ingest, or finding(upsert) for serial Main work) with title, location, **severity** (critical|high|medium|low|info — no silent medium), proof_excerpt (verbatim tool stdout/body ≥24 chars), optional poc.",
    "Surfaces for recon: use **fact(op=surface, location=…)** (host ledger) or package workers — never stage result.json as handoff.",
    allowFinding
      ? "After L0 Feedback marks feedback_ok, Main books with finding(confirm, finding_id=…). Severity fills from Store when omitted; missing severity fails closed."
      : "This stage cannot finding(confirm). Deposit candidates via packages or fact/surfaces only.",
    "Do **not** create process-chore L2 todos (e.g. Write result.json, collect subagents, pure meta login prep).",
    hypMode && allowHypothesis
      ? [
          "Hypothesis work mode ON for this stage: maintain the host **hypothesis queue** (hypothesis tool) for active/confirmed/killed/deferred exploration.",
          "Main commits only; Sub packages return structured hypothesis_outcomes (proved|disproved|inconclusive).",
          "Bind package this_turn_goal / success_criteria to prove_if / disprove_if when applicable.",
          "Confirmed ≠ booked — never finding(confirm) from hypothesis id alone.",
        ].join(" ")
      : "",
    allowSubagent
      ? [
          "Agent Graph (preferred when multi-class or multi-surface work is justified): fan-out with **subagent** packages[] (skill/path-scoped workers).",
          "Prefer packages over one long serial monologue across all vulnerability classes or surfaces.",
          "Each formal package **must** pass plan_node_id (L2 attack-class anchor). No hard package quotas.",
          "Anti-micro-spawn: do not split trivial single-GET chores into packages.",
          "Workers return structured candidates/surfaces with severity + verbatim proof_excerpt; host settlement + Finding Store own Join — do not rephrase proof into a result.json ceremony.",
          "Discovery packages: already_done must include prior pathKey∩class; host hard-fails spawn on prior collision — use re-verify packages with prior Store ids for known holes.",
          "After packages start this stage: orchestrate + settle only (do not serial-erase package failure).",
          "No nested subagent inside workers. Stay in RoE/scope.",
          "Serial Main-only probing is allowed if packages are not justified (single surface / single class) — deposit Store/surfaces via host paths.",
        ].join(" ")
      : "",
    "Fail closed: do not invent surfaces or proof. Destructive actions default-deny unless RoE explicitly allows (record skipped_roe when denied).",
    "",
    // Same language policy as free OMP / subagent (#134 / #137).
    formatAgentLanguageInjection(task.agentLanguage),
    "",
    `Target: ${JSON.stringify(task.target)}`,
    `Scope: ${JSON.stringify(task.scope)}`,
    `Prior handoff stages: ${input.handoff.completed_stages.join(", ") || "(none)"}`,
    `Known surfaces: ${JSON.stringify(input.handoff.surfaces.slice(0, 20))}`,
    priorSeed,
    hypothesisBlock,
    skillL1Block,
  ]
    .filter(Boolean)
    .join("\n");
}

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
      : "Complete this stage only. Narrate briefly when useful; deposit surfaces via fact(op=surface) and candidates via finding(upsert) — do not use result.json as stage handoff; then stop.";
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
    const systemPrompt = stageSystemPrompt(promptInput, task);
    const userPrompt = stageUserPrompt(promptInput, task, {
      confirmableFeedbackOk: bookStage ? confirmableAtStart : undefined,
    });

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
        surfaceSummary: settleRuntime.surfaceLedger?.summary?.() as
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
