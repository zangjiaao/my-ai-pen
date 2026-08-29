/**
 * Stage-advance Feedback after L0 pass and L1 not-refine.
 *
 * Host does **not** NLP the user instruction (no keyword tables).
 * Graph Feedback Agent declares a typed `stage_advance` token.
 * Missing vote → continue (do not HITL every stage).
 */

export type StageAdvance = "continue" | "pause" | "stop";

const ADVANCE_TOKENS = new Set<StageAdvance>(["continue", "pause", "stop"]);

/** First token only — never treat surrounding prose as a vote. */
export function parseStageAdvanceToken(raw: unknown): StageAdvance | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim().toLowerCase().split(/[\s:,;/|]+/)[0] || "";
  if (ADVANCE_TOKENS.has(t as StageAdvance)) return t as StageAdvance;
  return undefined;
}

function readAdvanceFields(o: Record<string, unknown>): StageAdvance | undefined {
  return (
    parseStageAdvanceToken(o.stage_advance) ?? parseStageAdvanceToken(o.stageAdvance)
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/**
 * Typed `stage_advance` only (top-level / nested data|structured|raw|gate|route).
 * Exact process-fact / structured-fact key `stage_advance` with enum summary.
 * Does **not** scrape notes, deadends, or the user instruction.
 */
export function parseStageAdvance(input: unknown): StageAdvance | undefined {
  if (input == null) return undefined;
  if (typeof input === "string") return parseStageAdvanceToken(input);
  if (!isPlainObject(input)) return undefined;

  const seen = new Set<unknown>();
  const objects: Record<string, unknown>[] = [];
  const push = (v: unknown) => {
    if (!isPlainObject(v) || seen.has(v)) return;
    seen.add(v);
    objects.push(v);
  };
  push(input);
  push(input.data);
  push(input.structured);
  push(input.raw);
  push(input.gate);
  push(input.route);
  if (isPlainObject(input.raw)) {
    push(input.raw.data);
    push(input.raw.structured);
    push(input.raw.gate);
    push(input.raw.route);
  }

  for (const o of objects) {
    const v = readAdvanceFields(o);
    if (v) return v;
  }

  const factLists: unknown[] = [input.facts];
  for (const o of objects) factLists.push(o.facts);
  for (const list of factLists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!isPlainObject(item)) continue;
      const key = String(item.key ?? item.fact_key ?? "").trim();
      const compact = key.toLowerCase().replace(/[-_/]/g, "");
      if (compact !== "stageadvance" && !compact.endsWith("stageadvance")) continue;
      const v = parseStageAdvanceToken(item.summary);
      if (v) return v;
    }
  }
  return undefined;
}

export type StageAdvanceEvalInput = {
  /** Feedback Agent (or test executor) typed vote. */
  vote?: unknown;
  /** @deprecated alias of vote */
  captainAdvance?: unknown;
  instruction?: string | null;
  hasNextStage: boolean;
};

/**
 * After L0 pass + L1 not-refine: whether the runner may open the next stage.
 * Missing vote → continue.
 */
export function evaluateStageAdvance(input: StageAdvanceEvalInput): StageAdvance {
  if (!input.hasNextStage) return "continue";
  const raw = input.vote ?? input.captainAdvance;
  const vote = parseStageAdvance(raw) ?? parseStageAdvanceToken(raw);
  if (vote) return vote;
  return "continue";
}

export type StageAdvanceDecisionCardInput = {
  conversationId: string;
  taskId?: string;
  graphId: string;
  stageId: string;
  nextStageId: string;
  captainSummary?: string;
  expertId?: string;
  expertName?: string;
  requestId: string;
};

/**
 * Host pause card: stage ids from the graph definition + optional captain summary.
 * Not a keyword paraphrase of the user instruction.
 */
export function buildStageAdvanceDecisionPayload(
  input: StageAdvanceDecisionCardInput,
): Record<string, unknown> {
  const summary = String(input.captainSummary || "").trim().slice(0, 500);
  const payload: Record<string, unknown> = {
    type: "request_decision",
    conversation_id: input.conversationId,
    request_id: input.requestId,
    kind: "next_steps",
    selection: "single",
    presentation: "approval_wizard",
    graph_id: input.graphId,
    question: `${input.stageId} passed Feedback. Enter ${input.nextStageId}?`,
    options: [
      {
        id: "advance_continue",
        title: input.nextStageId,
        body: summary || input.nextStageId,
      },
      {
        id: "advance_stop",
        title: input.stageId,
        body: input.stageId,
      },
    ],
  };
  if (input.taskId) payload.task_id = input.taskId;
  if (summary) payload.preamble = summary;
  if (input.expertId) payload.expert_id = input.expertId;
  if (input.expertName) payload.expert_name = input.expertName;
  return payload;
}
