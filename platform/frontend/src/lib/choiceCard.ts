/**
 * Spec #312 / #313 / #450 — Unified Choice Card pure contracts.
 * Agent-authored options; no platform inventory expansion as primary UX.
 * #450: custom is a peer option (not a supplement); option cards use wizard chrome.
 */

export type ChoiceOption = {
  id: string;
  title: string;
  body: string;
  workset_item_ids?: string[];
  kind?: string;
};

export type ChoiceKind = "authorize" | "handoff" | "next_steps" | "confirm" | string;

export type ChoicePresentation = "approval_wizard" | "recommendation" | "flat";

export type WizardQuestion = {
  id: string;
  prompt: string;
  selection: "single" | "multi";
  options: ChoiceOption[];
  allow_custom: boolean;
};

export type WizardAnswer = {
  question_id: string;
  selected_option_ids: string[];
  custom_text?: string;
};

export type ChoiceCardPayload = {
  request_id?: string;
  kind?: ChoiceKind;
  presentation?: ChoicePresentation;
  selection?: "single" | "multi";
  preamble?: string;
  question?: string;
  proposed_action?: string;
  target?: string;
  risk_level?: string;
  allow_custom?: boolean;
  primary_option_id?: string;
  /** next_steps structured options; authorize may still carry legacy string[] */
  options?: ChoiceOption[] | string[];
  questions?: WizardQuestion[];
  [key: string]: unknown;
};

export type ValidateChoiceResult =
  | { ok: true; value: ChoiceCardPayload; mode: "authorize" | "next_steps" }
  | { ok: false; errors: string[] };

export type ConfirmTextExtras = {
  customText?: string | null;
  answers?: WizardAnswer[] | null;
  /** @deprecated Spec #450 — treated as customText. */
  supplement?: string | null;
};

/** Projected question id when wrapping flat next_steps options[] into one wizard question. */
export const PROJECTED_NEXT_STEPS_QUESTION_ID = "next_steps";
/** Projected yes/no question for authorize / handoff / confirm (existing 授权/取消 labels). */
export const PROJECTED_AUTHORIZE_QUESTION_ID = "authorize";
export const AUTHORIZE_OPTION_YES = "authorize";
export const AUTHORIZE_OPTION_NO = "cancel";

const NEXT_STEPS_MIN = 2;
const NEXT_STEPS_MAX = 5;
const WIZARD_MAX_QUESTIONS = 8;
const WIZARD_MAX_OPTIONS = 8;

function nonEmptyString(v: unknown): string {
  return String(v ?? "").trim();
}

function parseOptionRow(row: unknown, index: number, errors: string[], prefix: string): ChoiceOption | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    errors.push(`${prefix}[${index}] must be an object`);
    return null;
  }
  const r = row as Record<string, unknown>;
  const id = nonEmptyString(r.id);
  const title = nonEmptyString(r.title);
  const body = nonEmptyString(r.body);
  if (!id) errors.push(`${prefix}[${index}].id required`);
  if (!title) errors.push(`${prefix}[${index}].title required`);
  const workset_item_ids = Array.isArray(r.workset_item_ids)
    ? r.workset_item_ids.map((x) => String(x || "").trim()).filter(Boolean)
    : undefined;
  const opt: ChoiceOption = { id, title, body };
  if (workset_item_ids?.length) opt.workset_item_ids = workset_item_ids;
  if (nonEmptyString(r.kind)) opt.kind = nonEmptyString(r.kind);
  return id && title ? opt : null;
}

/** True when payload is an option/wizard card (not authorize two-button). */
export function isNextStepsChoice(content: Record<string, unknown> | null | undefined): boolean {
  if (!content || typeof content !== "object") return false;
  const kind = nonEmptyString(content.kind).toLowerCase();
  if (kind === "next_steps") return true;
  const presentation = nonEmptyString(content.presentation).toLowerCase();
  if (presentation === "approval_wizard") return true;
  const questions = content.questions;
  if (Array.isArray(questions) && questions.length > 0 && questions.every((q) => q && typeof q === "object")) {
    return true;
  }
  const opts = content.options;
  if (!Array.isArray(opts) || opts.length === 0) return false;
  // Structured option objects (not legacy ["authorize","cancel"] strings)
  return opts.every((o) => o && typeof o === "object" && !Array.isArray(o));
}

function parseQuestions(
  raw: unknown,
  errors: string[],
  cardOptionIds: Set<string>,
): WizardQuestion[] {
  if (!Array.isArray(raw)) {
    errors.push("questions must be an array");
    return [];
  }
  if (raw.length < 1 || raw.length > WIZARD_MAX_QUESTIONS) {
    errors.push(`wizard questions must be 1–${WIZARD_MAX_QUESTIONS} (got ${raw.length})`);
  }
  const qids = new Set<string>();
  const questions: WizardQuestion[] = [];
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i];
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      errors.push(`questions[${i}] must be an object`);
      continue;
    }
    const r = row as Record<string, unknown>;
    const id = nonEmptyString(r.id) || `q${i}`;
    const prompt = nonEmptyString(r.prompt) || nonEmptyString(r.question);
    if (!nonEmptyString(r.id)) errors.push(`questions[${i}].id required`);
    if (!prompt) errors.push(`questions[${i}].prompt required`);
    if (id && qids.has(id)) errors.push(`duplicate question id: ${id}`);
    if (id) qids.add(id);
    const selection = r.selection === "multi" ? "multi" : "single";
    const allow_custom = r.allow_custom !== false;
    const optsRaw = r.options;
    const options: ChoiceOption[] = [];
    if (optsRaw == null) {
      // allowed when custom is on
    } else if (!Array.isArray(optsRaw)) {
      errors.push(`questions[${i}].options must be an array`);
    } else {
      if (optsRaw.length > WIZARD_MAX_OPTIONS) {
        errors.push(`questions[${i}] options must be 0–${WIZARD_MAX_OPTIONS}`);
      }
      for (let j = 0; j < optsRaw.length; j++) {
        const opt = parseOptionRow(optsRaw[j], j, errors, `questions[${i}].options`);
        if (!opt) continue;
        if (cardOptionIds.has(opt.id)) errors.push(`duplicate option id: ${opt.id}`);
        cardOptionIds.add(opt.id);
        options.push(opt);
      }
    }
    if (!options.length && !allow_custom) {
      errors.push(`questions[${i}] needs options or allow_custom`);
    }
    questions.push({ id, prompt, selection, options, allow_custom });
  }
  return questions;
}

/** S1 — Accept/reject next_steps / wizard / authorize shapes. */
export function validateChoiceCardPayload(raw: unknown): ValidateChoiceResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["payload must be an object"] };
  }
  const o = raw as Record<string, unknown>;
  const kind = nonEmptyString(o.kind).toLowerCase() || "confirm";
  const explicitPresentation = nonEmptyString(o.presentation).toLowerCase();
  const hasQuestions = Array.isArray(o.questions) && o.questions.length > 0;
  const isNext = kind === "next_steps" || isNextStepsChoice(o);

  if (!isNext && !hasQuestions && explicitPresentation !== "approval_wizard") {
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
  const cardOptionIds = new Set<string>();
  let questions: WizardQuestion[] | undefined;
  if (hasQuestions) {
    questions = parseQuestions(o.questions, errors, cardOptionIds);
  }

  const optsRaw = o.options;
  const hasStructuredOptions =
    Array.isArray(optsRaw) && optsRaw.length > 0 && optsRaw.every((row) => row && typeof row === "object" && !Array.isArray(row));

  const options: ChoiceOption[] = [];
  // Host questions own option ids; do not also require card-level options[].
  if (hasStructuredOptions && !questions?.length) {
    if (optsRaw.length < NEXT_STEPS_MIN || optsRaw.length > NEXT_STEPS_MAX) {
      errors.push(`next_steps options must be ${NEXT_STEPS_MIN}–${NEXT_STEPS_MAX} (got ${optsRaw.length})`);
    }
    for (let i = 0; i < optsRaw.length; i++) {
      const row = optsRaw[i] as Record<string, unknown>;
      const parsed = parseOptionRow(row, i, errors, "options");
      if (!parsed) continue;
      if (!nonEmptyString(row.body)) errors.push(`options[${i}].body required`);
      if (cardOptionIds.has(parsed.id)) errors.push(`duplicate option id: ${parsed.id}`);
      cardOptionIds.add(parsed.id);
      options.push(parsed);
    }
  } else if (!questions?.length && (kind === "next_steps" || explicitPresentation === "approval_wizard")) {
    errors.push("next_steps requires options array");
  }

  if (errors.length) return { ok: false, errors };

  const selection =
    o.selection === "single" || o.selection === "multi" ? o.selection : "single";
  const presentation: ChoicePresentation =
    explicitPresentation === "recommendation"
      ? "recommendation"
      : explicitPresentation === "flat"
        ? "flat"
        : "approval_wizard";

  const value: ChoiceCardPayload = {
    ...o,
    kind: kind === "next_steps" || hasStructuredOptions || questions?.length ? "next_steps" : kind,
    selection: selection === "multi" ? "multi" : "single",
    presentation,
  };
  if (options.length) value.options = options;
  if (questions?.length) value.questions = questions;
  if (o.allow_custom === false) value.allow_custom = false;

  return { ok: true, mode: "next_steps", value };
}

export function resolveChoicePresentation(
  content: Record<string, unknown> | null | undefined,
): ChoicePresentation | "authorize" {
  if (!content) return "authorize";
  const explicit = nonEmptyString(content.presentation).toLowerCase();
  if (explicit === "approval_wizard" || explicit === "recommendation" || explicit === "flat") {
    return explicit;
  }
  if (isNextStepsChoice(content)) return "approval_wizard";
  return "authorize";
}

function projectedAuthorizeQuestion(content: ChoiceCardPayload): WizardQuestion {
  const kind = nonEmptyString(content.kind).toLowerCase();
  const base =
    nonEmptyString(content.question) ||
    (kind === "handoff" ? "需要授权移交" : "需要授权");
  const labels = Array.isArray(content.host_labels)
    ? content.host_labels.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  const prompt = labels.length
    ? `${base}\n将纳入本 Case Scope：\n${labels.map((h) => `- ${h}`).join("\n")}`
    : base;
  return {
    id: PROJECTED_AUTHORIZE_QUESTION_ID,
    prompt,
    selection: "single",
    allow_custom: content.allow_custom !== false,
    options: [
      { id: AUTHORIZE_OPTION_YES, title: "授权", body: "" },
      { id: AUTHORIZE_OPTION_NO, title: "取消", body: "" },
    ],
  };
}

/** Project host questions, wrap next_steps options[], or authorize as yes/no + custom. */
export function parseWizardQuestions(
  content: Record<string, unknown> | null | undefined,
): WizardQuestion[] {
  if (!content) return [];
  const v = validateChoiceCardPayload(content);
  if (!v.ok) return [];
  if (v.mode === "next_steps") {
    const host = v.value.questions;
    if (Array.isArray(host) && host.length) return host;
    const options = Array.isArray(v.value.options) ? (v.value.options as ChoiceOption[]) : [];
    if (!options.length) return [];
    const prompt =
      nonEmptyString(v.value.question) ||
      nonEmptyString(v.value.preamble) ||
      "下一步工作包";
    const selection = v.value.selection === "multi" ? "multi" : "single";
    const allow_custom = v.value.allow_custom !== false;
    return [
      {
        id: PROJECTED_NEXT_STEPS_QUESTION_ID,
        prompt,
        selection,
        options,
        allow_custom,
      },
    ];
  }
  return [projectedAuthorizeQuestion(v.value)];
}

/** Map wizard submit on an authorize-family card to the Session decision token.
 * Custom text is direction only — it does not authorize bound asset_ids.
 */
export function mapAuthorizeDecision(
  selected_option_ids?: string[] | null,
  custom_text?: string | null,
): "authorize" | "cancel" | "answered" | null {
  const ids = (Array.isArray(selected_option_ids) ? selected_option_ids : [])
    .map((id) => String(id || "").trim().toLowerCase())
    .filter(Boolean);
  if (ids.includes(AUTHORIZE_OPTION_NO) || ids.includes("deny") || ids.includes("reject")) {
    return "cancel";
  }
  if (ids.includes(AUTHORIZE_OPTION_YES) || ids.includes("yes")) {
    return "authorize";
  }
  if (nonEmptyString(custom_text)) return "answered";
  return null;
}

/** Parse structured options from card content (empty if authorize/legacy). */
export function parseChoiceOptions(content: Record<string, unknown> | null | undefined): ChoiceOption[] {
  if (!content) return [];
  const v = validateChoiceCardPayload(content);
  if (!v.ok || v.mode !== "next_steps") return [];
  const fromQuestions = Array.isArray(v.value.questions)
    ? v.value.questions.flatMap((q) => q.options || [])
    : [];
  if (fromQuestions.length) return fromQuestions;
  return Array.isArray(v.value.options) ? (v.value.options as ChoiceOption[]) : [];
}

/** S2 — Union workset_item_ids + titles for “已选择” summary. */
export function expandSelectedOptions(
  card: Record<string, unknown> | null | undefined,
  selected_option_ids: string[] | null | undefined,
): {
  workset_item_ids: string[];
  summary_titles: string[];
  selected_options: ChoiceOption[];
} {
  const options = parseChoiceOptions(card || {});
  const want = new Set(
    (Array.isArray(selected_option_ids) ? selected_option_ids : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean),
  );
  const worksetIds: string[] = [];
  const seenWs = new Set<string>();
  const summary_titles: string[] = [];
  const selected_options: ChoiceOption[] = [];
  for (const opt of options) {
    if (!want.has(opt.id)) continue;
    summary_titles.push(opt.title || opt.id);
    selected_options.push(opt);
    for (const wid of opt.workset_item_ids || []) {
      const id = String(wid || "").trim();
      if (!id || seenWs.has(id)) continue;
      seenWs.add(id);
      worksetIds.push(id);
    }
  }
  return { workset_item_ids: worksetIds, summary_titles, selected_options };
}

/** Visible short user summary for selected packages. */
export function formatSelectedSummary(summary_titles: string[]): string {
  const titles = summary_titles.map((t) => String(t || "").trim()).filter(Boolean);
  if (!titles.length) return "已选择";
  return `已选择：${titles.join("、")}`;
}

export function isQuestionAnswerValid(input: {
  selection: "single" | "multi";
  allow_custom: boolean;
  selected_option_ids?: string[] | null;
  custom_text?: string | null;
}): boolean {
  const selected = (Array.isArray(input.selected_option_ids) ? input.selected_option_ids : [])
    .map((id) => String(id || "").trim())
    .filter(Boolean);
  const custom = input.allow_custom ? nonEmptyString(input.custom_text) : "";
  if (input.selection === "single") {
    if (custom) return selected.length === 0;
    return selected.length === 1;
  }
  return selected.length > 0 || Boolean(custom);
}

export function parseWizardAnswers(raw: unknown): WizardAnswer[] {
  if (!Array.isArray(raw)) return [];
  const out: WizardAnswer[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    const question_id = nonEmptyString(r.question_id);
    if (!question_id) continue;
    const selected_option_ids = Array.isArray(r.selected_option_ids)
      ? r.selected_option_ids.map((x) => String(x || "").trim()).filter(Boolean)
      : [];
    const custom_text = nonEmptyString(r.custom_text) || undefined;
    const ans: WizardAnswer = { question_id, selected_option_ids };
    if (custom_text) ans.custom_text = custom_text;
    out.push(ans);
  }
  return out;
}

export type ReduceChoiceDecisionResult =
  | {
      ok: true;
      selected_option_ids: string[];
      answers: WizardAnswer[];
      custom_text?: string;
    }
  | { ok: false; errors: string[] };

/** S2 — wizard / next_steps answers → normalized confirm payload. */
export function reduceChoiceDecision(
  card: Record<string, unknown> | null | undefined,
  input: {
    selected_option_ids?: string[] | null;
    custom_text?: string | null;
    answers?: WizardAnswer[] | null;
  },
): ReduceChoiceDecisionResult {
  const questions = parseWizardQuestions(card || {});
  if (!questions.length) {
    return { ok: false, errors: ["no wizard questions"] };
  }
  const byId = new Map<string, WizardAnswer>();
  for (const ans of input.answers || []) {
    if (ans?.question_id) byId.set(ans.question_id, ans);
  }
  const errors: string[] = [];
  const answers: WizardAnswer[] = [];
  const union: string[] = [];
  const seen = new Set<string>();
  for (const q of questions) {
    let ans = byId.get(q.id);
    if (!ans && questions.length === 1) {
      ans = {
        question_id: q.id,
        selected_option_ids: Array.isArray(input.selected_option_ids)
          ? input.selected_option_ids.map((x) => String(x || "").trim()).filter(Boolean)
          : [],
        custom_text: nonEmptyString(input.custom_text) || undefined,
      };
    }
    const selected = (ans?.selected_option_ids || []).filter(Boolean);
    const legal = new Set(q.options.map((o) => o.id));
    const filtered = selected.filter((id) => legal.has(id));
    const custom = q.allow_custom ? nonEmptyString(ans?.custom_text) : "";
    if (q.selection === "single" && custom) {
      filtered.length = 0;
    }
    if (
      !isQuestionAnswerValid({
        selection: q.selection,
        allow_custom: q.allow_custom,
        selected_option_ids: filtered,
        custom_text: custom,
      })
    ) {
      errors.push(`question ${q.id} needs an option or custom answer`);
      continue;
    }
    const row: WizardAnswer = { question_id: q.id, selected_option_ids: filtered };
    if (custom) row.custom_text = custom;
    answers.push(row);
    for (const id of filtered) {
      if (seen.has(id)) continue;
      seen.add(id);
      union.push(id);
    }
  }
  if (errors.length) return { ok: false, errors };
  const custom_text =
    answers.length === 1 ? answers[0].custom_text : nonEmptyString(input.custom_text) || undefined;
  const result: ReduceChoiceDecisionResult = {
    ok: true,
    selected_option_ids: union,
    answers,
  };
  if (custom_text) result.custom_text = custom_text;
  return result;
}

function formatCustomLine(text: string): string {
  return `- 自定义：${text}`;
}

/**
 * Spec #313 / #450 S3 — full confirm text for Session demand.
 * Option title/body + custom as a peer answer (never 「补充：」).
 */
export function buildConfirmOptionsText(
  card: Record<string, unknown> | null | undefined,
  selected_option_ids: string[] | null | undefined,
  extras?: string | null | ConfirmTextExtras,
): string {
  const extraObj: ConfirmTextExtras =
    extras && typeof extras === "object" ? extras : { customText: extras == null ? undefined : String(extras) };
  const answers = Array.isArray(extraObj.answers) ? extraObj.answers : [];
  const questions = parseWizardQuestions(card || {});
  const fallbackCustom = nonEmptyString(extraObj.customText) || nonEmptyString(extraObj.supplement);

  if (answers.length && questions.length) {
    const byId = new Map(answers.map((a) => [a.question_id, a]));
    const parts: string[] = [];
    const multi = questions.length > 1;
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const ans = byId.get(q.id);
      const lines: string[] = [];
      if (multi) lines.push(`${i + 1}. ${q.prompt}`);
      else lines.push("已选择：");
      const ids = ans?.selected_option_ids || [];
      const optById = new Map(q.options.map((o) => [o.id, o]));
      for (const id of ids) {
        const opt = optById.get(id);
        if (!opt) continue;
        const title = String(opt.title || opt.id || "").trim();
        const body = String(opt.body || "").trim();
        lines.push(body ? `- ${title}：${body}` : `- ${title}`);
      }
      const custom = nonEmptyString(ans?.custom_text);
      if (custom) lines.push(formatCustomLine(custom));
      parts.push(lines.join("\n"));
    }
    return parts.join("\n").trim();
  }

  const expanded = expandSelectedOptions(card, selected_option_ids);
  const parts: string[] = [];
  if (expanded.selected_options.length) {
    const lines = ["已选择："];
    for (const opt of expanded.selected_options) {
      const title = String(opt.title || opt.id || "").trim();
      const body = String(opt.body || "").trim();
      lines.push(body ? `- ${title}：${body}` : `- ${title}`);
    }
    if (fallbackCustom) lines.push(formatCustomLine(fallbackCustom));
    parts.push(lines.join("\n"));
  } else if (fallbackCustom) {
    parts.push(["已选择：", formatCustomLine(fallbackCustom)].join("\n"));
  } else {
    parts.push(formatSelectedSummary(expanded.summary_titles));
  }
  return parts.join("\n").trim();
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

/** Frozen-card footer. `answered` is dialogue-continue, not a selection. */
export function choiceCardHistoryFooter(decision: string | null | undefined): string {
  const d = nonEmptyString(decision).toLowerCase();
  if (d === "confirm_options" || d === "authorize") return "已选择";
  if (d === "cancel") return "已取消";
  if (d === "answered") return "已通过对话继续";
  return "";
}
