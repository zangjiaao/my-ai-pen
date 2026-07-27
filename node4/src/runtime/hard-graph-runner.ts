/**
 * Hard Graph runner — outer orchestrator for Graph × Pi.
 * Owns stage order, retries, and fail-closed Feedback. Stage work is injected.
 */

import {
  normalizeSubagentResult,
  type SubagentStructuredResult,
} from "./subagent-result.js";
import type {
  HardGraphDefinition,
  HardGraphStageDef,
  HardGraphToolProfile,
} from "./hard-graph-definition.js";
import { applyHardGraphToolProfile } from "./hard-graph-definition.js";
import {
  accumulateStageFeedback,
  emptyHardProcessMetrics,
  type HardProcessMetrics,
} from "./hard-graph-feedback.js";
import { l1MaxStageRefine } from "./l1-critic.js";
import {
  formatL0RepairBrief,
  isBookingOnlyStage,
  isHonestyCannotAdvanceErrors,
} from "./l0-honesty-repair-brief.js";

export type HardGraphHandoff = {
  summary?: string;
  surfaces: SubagentStructuredResult["surfaces"];
  candidates: SubagentStructuredResult["candidates"];
  facts: SubagentStructuredResult["facts"];
  deadends: string[];
  notes?: string;
  completed_stages: string[];
};

export type StageExecutorInput = {
  stage: HardGraphStageDef;
  stageIndex: number;
  graphId: string;
  handoff: HardGraphHandoff;
  tools: string[];
  toolProfile: HardGraphToolProfile;
  /**
   * Spec #116 I0.6: 1-based stage attempt (max_retries + 1 attempts).
   * When attempt > 1, executor may reset non-success package attempt budgets.
   */
  stageAttempt?: number;
  /**
   * NC-Honesty-Advance: host fixed-template repair brief after a failed prior attempt
   * (machine signals only — not L1 prose).
   */
  l0RepairBrief?: string;
};

export type StageExecutorOutput = {
  structured?: unknown;
  summary?: string;
  /**
   * Real Agent Graph worker packages joined this stage (from
   * promoteStageSubagentPackagesToParent / host cache). Not a candidates>0 heuristic.
   */
  fanoutPackagesN?: number;
  /** Booking outcomes when the stage books or reports rejects (e.g. validate_book). */
  bookOutcomes?: { booked_n?: number; reject_hints_n?: number };
  /**
   * Absolute Finding Store booked count after stage (I1.4 process metrics).
   * Distinct from bookOutcomes.booked_n (local JSON findings delta).
   */
  findingsBookedN?: number;
  /**
   * Spec #125 / #130: captain-visible Store ids with status feedback_ok after host settlement.
   * Main confirms with finding(confirm, finding_id=…). Empty when zero confirmable rows.
   */
  feedbackOkIds?: string[];
  /**
   * Spec #139 D3 / NC-L1: Product-state L1 Critic result after L0 structure gate.
   * When decision=refine, runner treats stage attempt as failed_attempt (bounded).
   */
  l1?: { decision: "pass" | "refine"; gaps: string[] };
};

export type StageExecutor = (input: StageExecutorInput) => Promise<StageExecutorOutput>;

/**
 * Optional L1 refine accounting hook (Spec #139 NC-L1).
 * Runner owns budget: refine_n increments only when a refine is applied.
 */
export type L1BudgetHooks = {
  getRefineCount: (stageId: string) => number;
  recordRefine: (stageId: string, gaps: string[]) => void;
  maxRefine?: number;
};

/** Attempt-level outcome (emitted on stage_end). */
export type StageAttemptOutcome =
  | "passed"
  | "failed_attempt"
  | "blocked"
  | "aborted"
  | "skipped";

/** Final stage row in run result. */
export type StageFinalOutcome = "passed" | "blocked" | "aborted" | "skipped";

export type HardGraphStageRecord = {
  stageId: string;
  stageIndex: number;
  attempts: number;
  outcome: StageFinalOutcome;
  errors: string[];
  summary?: string;
};

export type HardGraphStageEvent =
  | {
      type: "stage_start";
      graphId: string;
      stageId: string;
      stageIndex: number;
      attempt: number;
    }
  | {
      type: "stage_end";
      graphId: string;
      stageId: string;
      stageIndex: number;
      attempt: number;
      /** failed_attempt = will retry; blocked = terminal for stage */
      outcome: StageAttemptOutcome;
      errors: string[];
      summary?: string;
      /** Spec #125: confirmable Store ids after host settlement (captain surface). */
      feedback_ok_ids?: string[];
    }
  | {
      type: "run_end";
      graphId: string;
      terminal: HardGraphTerminal;
    };

/** Single terminal vocabulary for Hard Graph runs. */
export type HardGraphTerminal = "completed" | "blocked" | "aborted";

export type HardGraphRunResult = {
  graphId: string;
  terminal: HardGraphTerminal;
  stages: HardGraphStageRecord[];
  handoff: HardGraphHandoff;
  /** Process Feedback metrics (structure / yield / coverage attempts) — no answer keys. */
  processMetrics?: HardProcessMetrics;
};

export type StageGateResult = { ok: true } | { ok: false; errors: string[] };

/**
 * Fail-closed Feedback: evaluate normalized structured result against stage.require.
 * Uses summaryProvided (not prose string-match) for summary gates.
 */
export function evaluateStageGate(
  stage: HardGraphStageDef,
  structured: SubagentStructuredResult,
): StageGateResult {
  const require = stage.require ?? { summary: true };
  const errors: string[] = [];

  const wantSummary = require.summary !== false;
  if (wantSummary && !structured.summaryProvided) {
    errors.push("summary_required");
  }

  if (typeof require.surfaces_min === "number" && require.surfaces_min > 0) {
    if (structured.surfaces.length < require.surfaces_min) {
      errors.push(
        `surfaces_min:${require.surfaces_min}:got:${structured.surfaces.length}`,
      );
    }
  }

  if (typeof require.candidates_min === "number" && require.candidates_min > 0) {
    if (structured.candidates.length < require.candidates_min) {
      errors.push(
        `candidates_min:${require.candidates_min}:got:${structured.candidates.length}`,
      );
    }
  }

  if (structured.ok === false) {
    // NC-Honesty-Advance: keep generic code + honesty machine reasons from host deadends
    // so honesty cannot-advance is distinct from structure require misses.
    // failed_package is residual honest-partial signal — not a gate error code.
    errors.push("structured_ok_false");
    const seen = new Set<string>();
    for (const d of structured.deadends || []) {
      const s = String(d || "").trim();
      if (!s || seen.has(s)) continue;
      if (
        s.startsWith("illegal_l2_done:") ||
        s.startsWith("running_package:") ||
        s.startsWith("empty_book")
      ) {
        seen.add(s);
        errors.push(s);
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true };
}

function emptyHandoff(): HardGraphHandoff {
  return {
    surfaces: [],
    candidates: [],
    facts: [],
    deadends: [],
    completed_stages: [],
  };
}

function mergeHandoff(
  prev: HardGraphHandoff,
  structured: SubagentStructuredResult,
  stageId: string,
): HardGraphHandoff {
  const surfaceKey = new Set(prev.surfaces.map((s) => s.location));
  const surfaces = [...prev.surfaces];
  for (const s of structured.surfaces) {
    if (!surfaceKey.has(s.location)) {
      surfaceKey.add(s.location);
      surfaces.push(s);
    }
  }
  return {
    summary: structured.summaryProvided ? structured.summary : prev.summary,
    surfaces,
    candidates: [...prev.candidates, ...structured.candidates].slice(0, 80),
    facts: [...prev.facts, ...structured.facts].slice(0, 80),
    deadends: [...prev.deadends, ...structured.deadends].slice(0, 80),
    notes: structured.notes || prev.notes,
    completed_stages: [...prev.completed_stages, stageId],
  };
}

function runEndResult(
  graphId: string,
  terminal: HardGraphTerminal,
  stages: HardGraphStageRecord[],
  handoff: HardGraphHandoff,
  processMetrics?: HardProcessMetrics,
): HardGraphRunResult {
  return { graphId, terminal, stages, handoff, processMetrics };
}

/**
 * NC-Honesty-Advance: after honesty cannot-advance block, skip later probe stages
 * and run booking-only tail. Mutates `records`. Returns updated handoff / abort flag.
 */
async function runHonestyBlockedTail(input: {
  graph: HardGraphDefinition;
  blockedStageId: string;
  stageIndex: number;
  lastErrors: string[];
  records: HardGraphStageRecord[];
  handoff: HardGraphHandoff;
  availableTools: readonly string[];
  executeStage: StageExecutor;
  emit: (event: HardGraphStageEvent) => void | Promise<void>;
  abortSignal?: AbortSignal;
}): Promise<{ handoff: HardGraphHandoff; aborted: boolean }> {
  let handoff = input.handoff;
  const { graph, records, emit } = input;

  for (let j = input.stageIndex + 1; j < graph.stages.length; j++) {
    if (input.abortSignal?.aborted) {
      return { handoff, aborted: true };
    }
    const tail = graph.stages[j]!;
    if (!isBookingOnlyStage(tail)) {
      records.push({
        stageId: tail.id,
        stageIndex: j,
        attempts: 0,
        outcome: "skipped",
        errors: ["skipped_after_upstream_blocked"],
      });
      await emit({
        type: "stage_end",
        graphId: graph.id,
        stageId: tail.id,
        stageIndex: j,
        attempt: 0,
        outcome: "skipped",
        errors: ["skipped_after_upstream_blocked"],
      });
      continue;
    }

    const tailTools = applyHardGraphToolProfile(input.availableTools, tail.tools ?? {});
    await emit({
      type: "stage_start",
      graphId: graph.id,
      stageId: tail.id,
      stageIndex: j,
      attempt: 1,
    });
    let tailStructured: SubagentStructuredResult;
    let tailFeedbackOk: string[] | undefined;
    try {
      const out = await input.executeStage({
        stage: tail,
        stageIndex: j,
        graphId: graph.id,
        handoff,
        tools: tailTools,
        toolProfile: tail.tools ?? {},
        stageAttempt: 1,
        l0RepairBrief: formatL0RepairBrief({
          stageId: tail.id,
          failedAttempt: 0,
          mode: "booking_tail",
          errors: [
            `upstream_stage_blocked:${input.blockedStageId}`,
            ...input.lastErrors.slice(0, 12),
            "booking_only_tail: confirm remaining feedback_ok; do not open new probe packages",
          ],
        }),
      });
      tailStructured = normalizeSubagentResult(
        out.structured ?? { summary: out.summary, ok: true },
        out.summary || "",
      );
      tailFeedbackOk = Array.isArray(out.feedbackOkIds)
        ? out.feedbackOkIds.map((id) => String(id || "").trim()).filter(Boolean)
        : undefined;
    } catch (err) {
      tailStructured = normalizeSubagentResult(
        {
          ok: false,
          summary: err instanceof Error ? err.message : String(err),
          deadends: ["booking_tail_executor_threw"],
        },
        err instanceof Error ? err.message : "booking_tail_error",
      );
    }
    const tailGate = evaluateStageGate(tail, tailStructured);
    // Tail stage row may pass; run terminal stays blocked (process incomplete).
    const tailOutcome: StageFinalOutcome = tailGate.ok ? "passed" : "blocked";
    records.push({
      stageId: tail.id,
      stageIndex: j,
      attempts: 1,
      outcome: tailOutcome,
      errors: tailGate.ok ? [] : tailGate.errors,
      summary: tailStructured.summaryProvided ? tailStructured.summary : undefined,
    });
    if (tailGate.ok) {
      handoff = mergeHandoff(handoff, tailStructured, tail.id);
    }
    await emit({
      type: "stage_end",
      graphId: graph.id,
      stageId: tail.id,
      stageIndex: j,
      attempt: 1,
      outcome: tailGate.ok ? "passed" : "blocked",
      errors: tailGate.ok ? [] : tailGate.errors,
      summary: tailStructured.summaryProvided ? tailStructured.summary : undefined,
      ...(tailFeedbackOk?.length ? { feedback_ok_ids: tailFeedbackOk } : {}),
    });
  }

  return { handoff, aborted: false };
}

/**
 * Run Hard Graph stages in hard order. Cannot skip. Feedback is runner-owned.
 */
export async function runHardGraph(options: {
  graph: HardGraphDefinition;
  executeStage: StageExecutor;
  availableTools: readonly string[];
  initialHandoff?: HardGraphHandoff;
  onEvent?: (event: HardGraphStageEvent) => void | Promise<void>;
  abortSignal?: AbortSignal;
  /** Spec #139: L1 refine budget (default l1MaxStageRefine when omitted uses in-memory counter). */
  l1Budget?: L1BudgetHooks;
}): Promise<HardGraphRunResult> {
  const graph = options.graph;
  if (graph.discipline !== "hard" || !graph.stages.length) {
    throw new Error("runHardGraph requires a Hard Graph definition with stages");
  }

  let handoff = options.initialHandoff ?? emptyHandoff();
  const records: HardGraphStageRecord[] = [];
  let processMetrics = emptyHardProcessMetrics();
  const emit = async (e: HardGraphStageEvent) => {
    await options.onEvent?.(e);
  };
  // Default L1 budget: in-memory refine counts when caller does not wire graphQuality
  const localL1Counts = new Map<string, number>();
  const l1Budget: L1BudgetHooks = options.l1Budget || {
    getRefineCount: (stageId) => localL1Counts.get(stageId) || 0,
    recordRefine: (stageId) => {
      localL1Counts.set(stageId, (localL1Counts.get(stageId) || 0) + 1);
    },
    maxRefine: l1MaxStageRefine(),
  };
  const maxL1Refine =
    typeof l1Budget.maxRefine === "number" ? l1Budget.maxRefine : l1MaxStageRefine();

  for (let stageIndex = 0; stageIndex < graph.stages.length; stageIndex++) {
    if (options.abortSignal?.aborted) {
      const result = runEndResult(graph.id, "aborted", records, handoff, processMetrics);
      await emit({ type: "run_end", graphId: graph.id, terminal: "aborted" });
      return result;
    }

    const stage = graph.stages[stageIndex]!;
    const maxRetries = Math.max(0, stage.max_retries ?? 1);
    const maxAttempts = maxRetries + 1;
    const toolProfile = stage.tools ?? {};
    const tools = applyHardGraphToolProfile(options.availableTools, toolProfile);

    let passed = false;
    let lastErrors: string[] = [];
    let lastSummary: string | undefined;
    let attempts = 0;
    let lastStructured: SubagentStructuredResult | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      if (options.abortSignal?.aborted) break;

      await emit({
        type: "stage_start",
        graphId: graph.id,
        stageId: stage.id,
        stageIndex,
        attempt,
      });

      let structured: SubagentStructuredResult;
      let outFanoutN: number | undefined;
      let outBookOutcomes: { booked_n?: number; reject_hints_n?: number } | undefined;
      let outFindingsBookedN: number | undefined;
      let outFeedbackOkIds: string[] | undefined;
      let outL1: { decision: "pass" | "refine"; gaps: string[] } | undefined;
      try {
        // Honesty repair brief only when prior attempt failed L0 honesty cannot-advance.
        // Structure-only / L1 refine retries must not inject M1 honesty duties (review finding #1).
        // Empty-book (#161): separate fixed brief — not honesty M1.
        const emptyBookFail =
          attempt > 1 &&
          lastErrors.some((e) => String(e).startsWith("empty_book"));
        const l0RepairBrief = emptyBookFail
          ? [
              "### Host book-stage repair brief (empty book)",
              `stage_id: ${stage.id}`,
              `failed_attempt: ${attempt - 1}`,
              "error: empty_book_with_confirmable_feedback_ok",
              "Prior attempt booked 0 while confirmable feedback_ok remained.",
              "Required: finding(list) then finding(confirm, finding_id=…) for Store feedback_ok rows (host captain list in user prompt).",
              `prior_errors: ${lastErrors.slice(0, 8).join(" | ")}`,
            ].join("\n")
          : attempt > 1 && isHonestyCannotAdvanceErrors(lastErrors)
            ? formatL0RepairBrief({
                stageId: stage.id,
                failedAttempt: attempt - 1,
                errors: lastErrors,
              })
            : undefined;
        const out = await options.executeStage({
          stage,
          stageIndex,
          graphId: graph.id,
          handoff,
          tools,
          toolProfile,
          // Spec #116 I0.6: stage attempt number for independent package-budget reset
          stageAttempt: attempt,
          ...(l0RepairBrief ? { l0RepairBrief } : {}),
        });
        structured = normalizeSubagentResult(
          out.structured ?? { summary: out.summary, ok: true },
          out.summary || "",
        );
        outFanoutN = out.fanoutPackagesN;
        outBookOutcomes = out.bookOutcomes;
        outFindingsBookedN = out.findingsBookedN;
        outFeedbackOkIds = Array.isArray(out.feedbackOkIds)
          ? out.feedbackOkIds.map((id) => String(id || "").trim()).filter(Boolean)
          : undefined;
        outL1 = out.l1;
      } catch (err) {
        structured = normalizeSubagentResult(
          {
            ok: false,
            summary: err instanceof Error ? err.message : String(err),
            candidates: [],
            surfaces: [],
            facts: [],
            deadends: ["stage_executor_threw"],
          },
          err instanceof Error ? err.message : "stage_executor_error",
        );
      }

      lastStructured = structured;
      const gate = evaluateStageGate(stage, structured);
      lastSummary = structured.summaryProvided ? structured.summary : lastSummary;
      // Real package Join count from stage executor (0 if omitted — never invent from candidates).
      const fanoutPackagesN =
        typeof outFanoutN === "number" && Number.isFinite(outFanoutN)
          ? Math.max(0, Math.floor(outFanoutN))
          : 0;
      const bookOutcomes = outBookOutcomes;
      const findingsBookedN = outFindingsBookedN;
      const feedback_ok_ids = outFeedbackOkIds;

      // Spec #139 D3: L0 structure first; L1 only after L0 pass; L1 cannot clear L0 fail.
      // L1 refine budget is separate from stage max_retries (NC-L1 default max 1 refine).
      if (gate.ok) {
        const l1 = outL1;
        if (l1 && l1.decision === "refine") {
          const already = l1Budget.getRefineCount(stage.id);
          const l1Errors = (l1.gaps || []).map((g) => `l1_refine:${g}`).slice(0, 12);
          lastErrors = l1Errors.length ? l1Errors : ["l1_refine"];
          processMetrics = accumulateStageFeedback(processMetrics, {
            stageId: stage.id,
            structured,
            structureFailed: false,
            fanoutPackagesN,
            bookOutcomes,
            findingsBookedN,
            handoffSurfacesN: handoff.surfaces.length,
          });
          // Budget exhausted → block advance (do not burn another stage attempt as "refine")
          if (already >= maxL1Refine) {
            lastErrors = [
              ...lastErrors,
              `l1_budget_exhausted:refine_n=${already}:max=${maxL1Refine}`,
            ];
            await emit({
              type: "stage_end",
              graphId: graph.id,
              stageId: stage.id,
              stageIndex,
              attempt,
              outcome: "blocked",
              errors: lastErrors,
              summary: structured.summary,
              ...(feedback_ok_ids?.length ? { feedback_ok_ids } : {}),
            });
            break;
          }
          l1Budget.recordRefine(stage.id, l1.gaps || []);
          const isLast = attempt >= maxAttempts;
          await emit({
            type: "stage_end",
            graphId: graph.id,
            stageId: stage.id,
            stageIndex,
            attempt,
            outcome: isLast ? "blocked" : "failed_attempt",
            errors: lastErrors,
            summary: structured.summary,
            ...(feedback_ok_ids?.length ? { feedback_ok_ids } : {}),
          });
          if (isLast) {
            break;
          }
          continue;
        }
        handoff = mergeHandoff(handoff, structured, stage.id);
        processMetrics = accumulateStageFeedback(processMetrics, {
          stageId: stage.id,
          structured,
          structureFailed: false,
          fanoutPackagesN,
          bookOutcomes,
          findingsBookedN,
          handoffSurfacesN: handoff.surfaces.length,
        });
        passed = true;
        await emit({
          type: "stage_end",
          graphId: graph.id,
          stageId: stage.id,
          stageIndex,
          attempt,
          outcome: "passed",
          errors: [],
          summary: structured.summary,
          ...(feedback_ok_ids?.length ? { feedback_ok_ids } : {}),
        });
        break;
      }

      lastErrors = gate.errors;
      processMetrics = accumulateStageFeedback(processMetrics, {
        stageId: stage.id,
        structured,
        structureFailed: true,
        fanoutPackagesN,
        bookOutcomes,
        findingsBookedN,
        handoffSurfacesN: handoff.surfaces.length,
      });
      const isLast = attempt >= maxAttempts;
      await emit({
        type: "stage_end",
        graphId: graph.id,
        stageId: stage.id,
        stageIndex,
        attempt,
        outcome: isLast ? "blocked" : "failed_attempt",
        errors: gate.errors,
        summary: structured.summary,
        ...(feedback_ok_ids?.length ? { feedback_ok_ids } : {}),
      });
    }

    if (!passed) {
      const aborted = Boolean(options.abortSignal?.aborted);
      records.push({
        stageId: stage.id,
        stageIndex,
        attempts,
        outcome: aborted ? "aborted" : "blocked",
        errors: lastErrors,
        summary: lastSummary,
      });
      if (lastStructured) {
        processMetrics = accumulateStageFeedback(processMetrics, {
          stageId: stage.id,
          structured: lastStructured,
          structureFailed: true,
          handoffSurfacesN: handoff.surfaces.length,
        });
      }
      if (aborted) {
        const result = runEndResult(graph.id, "aborted", records, handoff, processMetrics);
        await emit({ type: "run_end", graphId: graph.id, terminal: "aborted" });
        return result;
      }

      // Structure / L1 budget block: fail-closed stop — no skip records, no booking tail.
      // Honesty cannot-advance only: skip later probes; run booking-only tail; stay blocked.
      if (isHonestyCannotAdvanceErrors(lastErrors)) {
        const tail = await runHonestyBlockedTail({
          graph,
          blockedStageId: stage.id,
          stageIndex,
          lastErrors,
          records,
          handoff,
          availableTools: options.availableTools,
          executeStage: options.executeStage,
          emit,
          abortSignal: options.abortSignal,
        });
        handoff = tail.handoff;
        if (tail.aborted) {
          const result = runEndResult(graph.id, "aborted", records, handoff, processMetrics);
          await emit({ type: "run_end", graphId: graph.id, terminal: "aborted" });
          return result;
        }
      }

      const result = runEndResult(graph.id, "blocked", records, handoff, processMetrics);
      await emit({ type: "run_end", graphId: graph.id, terminal: "blocked" });
      return result;
    }

    records.push({
      stageId: stage.id,
      stageIndex,
      attempts,
      outcome: "passed",
      errors: [],
      summary: lastSummary,
    });
  }

  const result = runEndResult(graph.id, "completed", records, handoff, processMetrics);
  await emit({ type: "run_end", graphId: graph.id, terminal: "completed" });
  return result;
}

/**
 * Map Hard Graph terminal → platform task_complete.status.
 * Platform expects completed | incomplete | blocked (not "failed" — that falls through to completed).
 */
export function hardGraphToHarnessStatus(
  terminal: HardGraphTerminal,
): "completed" | "incomplete" | "blocked" {
  if (terminal === "completed") return "completed";
  if (terminal === "aborted") return "incomplete";
  return "blocked";
}
