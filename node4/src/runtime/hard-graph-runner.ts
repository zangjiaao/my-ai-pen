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
};

export type StageExecutorOutput = {
  structured?: unknown;
  summary?: string;
};

export type StageExecutor = (input: StageExecutorInput) => Promise<StageExecutorOutput>;

/** Attempt-level outcome (emitted on stage_end). */
export type StageAttemptOutcome = "passed" | "failed_attempt" | "blocked" | "aborted";

/** Final stage row in run result. */
export type StageFinalOutcome = "passed" | "blocked" | "aborted";

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
    errors.push("structured_ok_false");
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
): HardGraphRunResult {
  return { graphId, terminal, stages, handoff };
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
}): Promise<HardGraphRunResult> {
  const graph = options.graph;
  if (graph.discipline !== "hard" || !graph.stages.length) {
    throw new Error("runHardGraph requires a Hard Graph definition with stages");
  }

  let handoff = options.initialHandoff ?? emptyHandoff();
  const records: HardGraphStageRecord[] = [];
  const emit = async (e: HardGraphStageEvent) => {
    await options.onEvent?.(e);
  };

  for (let stageIndex = 0; stageIndex < graph.stages.length; stageIndex++) {
    if (options.abortSignal?.aborted) {
      const result = runEndResult(graph.id, "aborted", records, handoff);
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
      try {
        const out = await options.executeStage({
          stage,
          stageIndex,
          graphId: graph.id,
          handoff,
          tools,
          toolProfile,
        });
        structured = normalizeSubagentResult(
          out.structured ?? { summary: out.summary, ok: true },
          out.summary || "",
        );
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

      const gate = evaluateStageGate(stage, structured);
      lastSummary = structured.summaryProvided ? structured.summary : lastSummary;

      if (gate.ok) {
        handoff = mergeHandoff(handoff, structured, stage.id);
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
        });
        break;
      }

      lastErrors = gate.errors;
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
      const terminal: HardGraphTerminal = aborted ? "aborted" : "blocked";
      const result = runEndResult(graph.id, terminal, records, handoff);
      await emit({ type: "run_end", graphId: graph.id, terminal });
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

  const result = runEndResult(graph.id, "completed", records, handoff);
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
