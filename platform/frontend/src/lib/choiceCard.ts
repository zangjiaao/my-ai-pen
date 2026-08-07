/**
 * Spec #312 — Unified Choice Card pure contracts (S1–S3).
 * Agent-authored options; no platform inventory expansion as primary UX.
 */

export type ChoiceOption = {
  id: string;
  title: string;
  body: string;
  workset_item_ids?: string[];
  kind?: string;
};

export type ChoiceKind = "authorize" | "handoff" | "next_steps" | "confirm" | string;

export type ChoiceCardPayload = {
  request_id?: string;
  kind?: ChoiceKind;
  selection?: "single" | "multi";
  preamble?: string;
  question?: string;
  proposed_action?: string;
  target?: string;
  risk_level?: string;
  /** next_steps structured options; authorize may still carry legacy string[] */
  options?: ChoiceOption[] | string[];
  [key: string]: unknown;
};

export type ValidateChoiceResult =
  | { ok: true; value: ChoiceCardPayload; mode: "authorize" | "next_steps" }
  | { ok: false; errors: string[] };

const NEXT_STEPS_MIN = 2;
const NEXT_STEPS_MAX = 5;

function nonEmptyString(v: unknown): string {
  return String(v ?? "").trim();
}

/** True when payload is next_steps (kind or structured option objects). */
export function isNextStepsChoice(content: Record<string, unknown> | null | undefined): boolean {
  if (!content || typeof content !== "object") return false;
  const kind = nonEmptyString(content.kind).toLowerCase();
  if (kind === "next_steps") return true;
  const opts = content.options;
  if (!Array.isArray(opts) || opts.length === 0) return false;
  // Structured option objects (not legacy ["authorize","cancel"] strings)
  return opts.every((o) => o && typeof o === "object" && !Array.isArray(o));
}

/** S1 — Accept/reject next_steps shapes; authorize/handoff still valid without options[]. */
export function validateChoiceCardPayload(raw: unknown): ValidateChoiceResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["payload must be an object"] };
  }
  const o = raw as Record<string, unknown>;
  const kind = nonEmptyString(o.kind).toLowerCase() || "confirm";
  const isNext = kind === "next_steps" || isNextStepsChoice(o);

  if (!isNext) {
    // authorize / handoff / confirm / graph kinds: no options[] required
    const question = nonEmptyString(o.question);
    if (!question && !nonEmptyString(o.proposed_action) && !nonEmptyString(o.target)) {
      // still accept minimal authorize shell with request_id only (platform may fill)
      if (!nonEmptyString(o.request_id) && kind === "confirm") {
        return { ok: false, errors: ["authorize card needs question or request_id"] };
      }
    }
    return {
      ok: true,
      mode: "authorize",
      value: {
        ...o,
        kind: kind || "confirm",
        selection: o.selection === "multi" || o.selection === "single" ? o.selection : undefined,
      },
    };
  }

  const errors: string[] = [];
  const optsRaw = o.options;
  if (!Array.isArray(optsRaw)) {
    return { ok: false, errors: ["next_steps requires options array"] };
  }
  if (optsRaw.length < NEXT_STEPS_MIN || optsRaw.length > NEXT_STEPS_MAX) {
    errors.push(`next_steps options must be ${NEXT_STEPS_MIN}–${NEXT_STEPS_MAX} (got ${optsRaw.length})`);
  }

  const ids = new Set<string>();
  const options: ChoiceOption[] = [];
  for (let i = 0; i < optsRaw.length; i++) {
    const row = optsRaw[i];
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      errors.push(`options[${i}] must be an object`);
      continue;
    }
    const r = row as Record<string, unknown>;
    const id = nonEmptyString(r.id);
    const title = nonEmptyString(r.title);
    const body = nonEmptyString(r.body);
    if (!id) errors.push(`options[${i}].id required`);
    if (!title) errors.push(`options[${i}].title required`);
    if (!body) errors.push(`options[${i}].body required`);
    if (id) {
      if (ids.has(id)) errors.push(`duplicate option id: ${id}`);
      ids.add(id);
    }
    const workset_item_ids = Array.isArray(r.workset_item_ids)
      ? r.workset_item_ids.map((x) => String(x || "").trim()).filter(Boolean)
      : undefined;
    const opt: ChoiceOption = { id, title, body };
    if (workset_item_ids?.length) opt.workset_item_ids = workset_item_ids;
    if (nonEmptyString(r.kind)) opt.kind = nonEmptyString(r.kind);
    options.push(opt);
  }

  if (errors.length) return { ok: false, errors };

  // V1 FE is multi-select only (Spec #312 L4). Accept "single" on wire for forward-compat
  // but normalize product default to multi; ChoiceCard ignores single until implemented.
  const selection =
    o.selection === "single" || o.selection === "multi" ? o.selection : "multi";

  return {
    ok: true,
    mode: "next_steps",
    value: {
      ...o,
      kind: "next_steps",
      selection: selection === "single" ? "single" : "multi",
      options,
    },
  };
}

/** Parse structured options from card content (empty if authorize/legacy). */
export function parseChoiceOptions(content: Record<string, unknown> | null | undefined): ChoiceOption[] {
  if (!content) return [];
  const v = validateChoiceCardPayload(content);
  if (!v.ok || v.mode !== "next_steps") return [];
  return Array.isArray(v.value.options) ? (v.value.options as ChoiceOption[]) : [];
}

/** S2 — Union workset_item_ids + titles for “已选择” summary. */
export function expandSelectedOptions(
  card: Record<string, unknown> | null | undefined,
  selected_option_ids: string[] | null | undefined,
): { workset_item_ids: string[]; summary_titles: string[] } {
  const options = parseChoiceOptions(card || {});
  const want = new Set(
    (Array.isArray(selected_option_ids) ? selected_option_ids : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean),
  );
  const worksetIds: string[] = [];
  const seenWs = new Set<string>();
  const summary_titles: string[] = [];
  for (const opt of options) {
    if (!want.has(opt.id)) continue;
    summary_titles.push(opt.title || opt.id);
    for (const wid of opt.workset_item_ids || []) {
      const id = String(wid || "").trim();
      if (!id || seenWs.has(id)) continue;
      seenWs.add(id);
      worksetIds.push(id);
    }
  }
  return { workset_item_ids: worksetIds, summary_titles };
}

/** Visible short user summary for selected packages. */
export function formatSelectedSummary(summary_titles: string[]): string {
  const titles = summary_titles.map((t) => String(t || "").trim()).filter(Boolean);
  if (!titles.length) return "已选择";
  return `已选择：${titles.join("、")}`;
}

export type SoftGateBoundary = "stoppable" | "continue_empty" | string;

/**
 * S3 — Soft-gate when settle/continue should have offered next_steps but did not.
 * Pure predicate; host injects at most once per boundary (caller enforces cap).
 */
export function shouldSoftGateNextSteps(input: {
  boundary?: SoftGateBoundary | null;
  openWorksetCount?: number | null;
  openPriors?: boolean | null;
  hasLegalChoiceCard?: boolean | null;
  turnHadTools?: boolean | null;
}): boolean {
  const boundary = nonEmptyString(input.boundary).toLowerCase();
  const stoppable =
    boundary === "stoppable" ||
    boundary === "continue_empty" ||
    boundary === "settle" ||
    boundary === "case_assign";
  if (!stoppable) return false;
  if (input.hasLegalChoiceCard) return false;
  if (input.turnHadTools) return false;
  const openWs = Number(input.openWorksetCount || 0);
  const openPriors = Boolean(input.openPriors);
  if (openWs <= 0 && !openPriors) return false;
  return true;
}

/** Decision values that freeze a card (read-only). */
export type ChoiceDecision =
  | "authorize"
  | "cancel"
  | "answered"
  | "confirm_options";

export function isChoiceDecisionFinal(decision: string | null | undefined): boolean {
  const d = nonEmptyString(decision).toLowerCase();
  return d === "authorize" || d === "cancel" || d === "answered" || d === "confirm_options";
}
