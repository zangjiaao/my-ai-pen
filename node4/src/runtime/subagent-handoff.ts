/**
 * Subagent handoff contract (CyberStrike A1/D3 adapted).
 * Pure validation — unit-testable without LLM or host spawn.
 *
 * Child packages do not inherit parent chat. The parent must supply a complete
 * handoff: target identity, scope, already-done summary, this-turn goal, and
 * success/evidence shape. Nested subagent-from-subagent is disallowed by default.
 */

export const HANDOFF_FIELD_KEYS = [
  "target",
  "scope",
  "already_done",
  "this_turn_goal",
  "success_criteria",
] as const;

export type HandoffFieldKey = (typeof HANDOFF_FIELD_KEYS)[number];

export type SubagentHandoffFields = {
  target: string;
  scope: string;
  already_done: string;
  this_turn_goal: string;
  success_criteria: string;
};

export type HandoffValidationOk = {
  ok: true;
  handoff: SubagentHandoffFields;
  /** Full text written for the child (assignment package). */
  packageText: string;
};

export type HandoffValidationErr = {
  ok: false;
  missing: HandoffFieldKey[];
  error: string;
};

export type HandoffValidation = HandoffValidationOk | HandoffValidationErr;

const MIN_FIELD_LEN = 2;

function clipField(raw: unknown, max = 4000): string {
  return String(raw ?? "")
    .trim()
    .slice(0, max);
}

/**
 * Validate structured handoff fields. All five keys are required and non-trivial.
 * Optional `assignment` is free-form notes appended after the structured package.
 */
export function validateSubagentHandoff(input: {
  target?: unknown;
  scope?: unknown;
  already_done?: unknown;
  this_turn_goal?: unknown;
  success_criteria?: unknown;
  assignment?: unknown;
}): HandoffValidation {
  const handoff: SubagentHandoffFields = {
    target: clipField(input.target, 800),
    scope: clipField(input.scope, 2000),
    already_done: clipField(input.already_done, 4000),
    this_turn_goal: clipField(input.this_turn_goal, 2000),
    success_criteria: clipField(input.success_criteria, 2000),
  };

  const missing: HandoffFieldKey[] = [];
  for (const key of HANDOFF_FIELD_KEYS) {
    if (handoff[key].length < MIN_FIELD_LEN) missing.push(key);
  }
  if (missing.length) {
    return {
      ok: false,
      missing,
      error:
        `error: subagent handoff incomplete — missing or empty: ${missing.join(", ")}. ` +
        "Required: target (URL|IP:Port|domain+path), scope (in-scope boundary), already_done, " +
        "this_turn_goal (single objective), success_criteria (evidence shape). " +
        "Child does not see parent chat; do not nest subagent from a child.",
    };
  }

  const notes = clipField(input.assignment, 8000);
  const packageText = formatHandoffPackage(handoff, notes);
  return { ok: true, handoff, packageText };
}

/** Markdown package the child receives (inspectable under subagents/<id>/assignment.md). */
export function formatHandoffPackage(handoff: SubagentHandoffFields, notes = ""): string {
  const lines = [
    "# Subagent handoff package",
    "",
    "## Target",
    handoff.target,
    "",
    "## Scope",
    handoff.scope,
    "",
    "## Already done (do not repeat equivalent work)",
    handoff.already_done,
    "",
    "## This-turn goal (single objective)",
    handoff.this_turn_goal,
    "",
    "## Success / evidence shape",
    handoff.success_criteria,
    "",
    "## Nested delegation",
    "Do **not** call subagent again from this child. Return structured evidence to the parent.",
  ];
  if (notes) {
    lines.push("", "## Parent notes", notes);
  }
  return lines.join("\n");
}

/**
 * Nest ban: depth 0 = top-level agent; depth >= 1 means we are already inside a child.
 * Default policy: reject any further subagent spawn.
 */
export function assertSubagentNestAllowed(depth: number | undefined | null): {
  ok: true;
} | {
  ok: false;
  error: string;
} {
  const d = Number(depth ?? 0);
  if (!Number.isFinite(d) || d < 1) return { ok: true };
  return {
    ok: false,
    error:
      "error: nested subagent is disallowed. Children must not spawn subagent; " +
      "return evidence to the parent. Exception only if platform/docs explicitly enable nesting.",
  };
}
