/**
 * Spec #312 / #313 S1–S3 pure contracts.
 */
import assert from "node:assert/strict";
import {
  AUTHORIZE_OPTION_NO,
  AUTHORIZE_OPTION_YES,
  buildConfirmOptionsText,
  expandSelectedOptions,
  formatSelectedSummary,
  isChoiceDecisionFinal,
  isNextStepsChoice,
  isQuestionAnswerValid,
  mapAuthorizeDecision,
  parseChoiceOptions,
  parseWizardQuestions,
  PROJECTED_AUTHORIZE_QUESTION_ID,
  PROJECTED_NEXT_STEPS_QUESTION_ID,
  reduceChoiceDecision,
  resolveChoicePresentation,
  shouldSoftGateNextSteps,
  validateChoiceCardPayload,
} from "./choiceCard.ts";

// --- S1 validate ---

const authOk = validateChoiceCardPayload({
  request_id: "r1",
  kind: "handoff",
  question: "移交渗透？",
  proposed_action: "scope markdown",
});
assert.equal(authOk.ok, true);
if (authOk.ok) assert.equal(authOk.mode, "authorize");

const authNoOptions = validateChoiceCardPayload({
  request_id: "r2",
  kind: "confirm",
  question: "Authorize scan?",
});
assert.equal(authNoOptions.ok, true);

const authQuestions = parseWizardQuestions({
  request_id: "r1",
  kind: "handoff",
  question: "移交渗透？",
  proposed_action: "scope markdown",
});
assert.equal(authQuestions.length, 1);
assert.equal(authQuestions[0].id, PROJECTED_AUTHORIZE_QUESTION_ID);
assert.equal(authQuestions[0].selection, "single");
assert.equal(authQuestions[0].allow_custom, true);
assert.deepEqual(
  authQuestions[0].options.map((o) => o.id),
  [AUTHORIZE_OPTION_YES, AUTHORIZE_OPTION_NO],
);
assert.equal(mapAuthorizeDecision(["authorize"]), "authorize");
assert.equal(mapAuthorizeDecision(["cancel"]), "cancel");
assert.equal(mapAuthorizeDecision([], "先扫 login"), "authorize");
assert.equal(mapAuthorizeDecision([]), null);
const authReduced = reduceChoiceDecision(
  { kind: "confirm", question: "Authorize scan?" },
  { custom_text: "同意，限制在 lab" },
);
assert.equal(authReduced.ok, true);
if (authReduced.ok) {
  assert.deepEqual(authReduced.selected_option_ids, []);
  assert.equal(authReduced.custom_text, "同意，限制在 lab");
}

const nextTooFew = validateChoiceCardPayload({
  kind: "next_steps",
  options: [{ id: "a", title: "A", body: "why A" }],
});
assert.equal(nextTooFew.ok, false);

const nextMissingBody = validateChoiceCardPayload({
  kind: "next_steps",
  options: [
    { id: "a", title: "A", body: "ok" },
    { id: "b", title: "B", body: "" },
  ],
});
assert.equal(nextMissingBody.ok, false);

const nextDup = validateChoiceCardPayload({
  kind: "next_steps",
  options: [
    { id: "a", title: "A", body: "body a" },
    { id: "a", title: "A2", body: "body a2" },
  ],
});
assert.equal(nextDup.ok, false);

const nextOk = validateChoiceCardPayload({
  request_id: "r3",
  kind: "next_steps",
  options: [
    { id: "deepen", title: "加深 surface", body: "why deepen", workset_item_ids: ["w1", "w2"] },
    { id: "oos", title: "扩主机", body: "needs Scope", workset_item_ids: ["h1"] },
    { id: "report", title: "出报告", body: "no workset bind" },
  ],
});
assert.equal(nextOk.ok, true);
if (nextOk.ok) {
  assert.equal(nextOk.mode, "next_steps");
  // Spec #313 L8: product default single-select
  assert.equal(nextOk.value.selection, "single");
}

const nextMulti = validateChoiceCardPayload({
  kind: "next_steps",
  selection: "multi",
  options: [
    { id: "a", title: "A", body: "ba" },
    { id: "b", title: "B", body: "bb" },
  ],
});
assert.equal(nextMulti.ok, true);
if (nextMulti.ok) assert.equal(nextMulti.value.selection, "multi");

// Infer next_steps from structured options without kind
const inferred = validateChoiceCardPayload({
  options: [
    { id: "x", title: "X", body: "bx" },
    { id: "y", title: "Y", body: "by" },
  ],
});
assert.equal(inferred.ok, true);
if (inferred.ok) assert.equal(inferred.mode, "next_steps");

// Spec #450 L10: Node stamps presentation=approval_wizard on options-only next_steps.
const wizardFlat = validateChoiceCardPayload({
  kind: "next_steps",
  presentation: "approval_wizard",
  options: [
    { id: "a", title: "A", body: "why A" },
    { id: "b", title: "B", body: "why B" },
  ],
});
assert.equal(wizardFlat.ok, true);
if (wizardFlat.ok) {
  assert.equal(wizardFlat.mode, "next_steps");
  assert.equal(wizardFlat.value.presentation, "approval_wizard");
  const projectedFromStamp = parseWizardQuestions(wizardFlat.value);
  assert.equal(projectedFromStamp.length, 1);
  assert.equal(projectedFromStamp[0].id, PROJECTED_NEXT_STEPS_QUESTION_ID);
  assert.deepEqual(
    projectedFromStamp[0].options.map((o) => o.id),
    ["a", "b"],
  );
}
assert.equal(
  validateChoiceCardPayload({ kind: "next_steps", presentation: "approval_wizard" }).ok,
  false,
);

// Legacy authorize options string[] still authorize mode
assert.equal(isNextStepsChoice({ options: ["authorize", "cancel"] }), false);
assert.equal(
  isNextStepsChoice({
    kind: "next_steps",
    options: [
      { id: "a", title: "A", body: "b" },
      { id: "b", title: "B", body: "c" },
    ],
  }),
  true,
);

// --- S2 expand ---

const card = {
  kind: "next_steps",
  options: [
    { id: "deepen", title: "加深 surface", body: "why", workset_item_ids: ["w1", "w2"] },
    { id: "oos", title: "扩主机", body: "scope", workset_item_ids: ["h1", "w1"] },
    { id: "report", title: "出报告", body: "only report" },
  ],
};
const expanded = expandSelectedOptions(card, ["deepen", "report", "missing"]);
assert.deepEqual(expanded.workset_item_ids, ["w1", "w2"]);
assert.deepEqual(expanded.summary_titles, ["加深 surface", "出报告"]);
assert.equal(formatSelectedSummary(expanded.summary_titles), "已选择：加深 surface、出报告");
assert.equal(formatSelectedSummary([]), "已选择");

const emptyExpand = expandSelectedOptions(card, []);
assert.deepEqual(emptyExpand.workset_item_ids, []);
assert.deepEqual(emptyExpand.summary_titles, []);

assert.equal(parseChoiceOptions({ kind: "handoff", question: "x" }).length, 0);

// Spec #450 S3: custom is a peer option, never 「补充：」
const confirmText = buildConfirmOptionsText(card, ["deepen"], { customText: "优先 auth" });
assert.match(confirmText, /加深 surface/);
assert.match(confirmText, /why/);
assert.match(confirmText, /自定义：优先 auth/);
assert.doesNotMatch(confirmText, /补充/);
const singleOnly = buildConfirmOptionsText(card, ["report"]);
assert.match(singleOnly, /出报告/);
assert.doesNotMatch(singleOnly, /补充/);
const customAloneText = buildConfirmOptionsText(card, [], { customText: "先做登录口" });
assert.match(customAloneText, /自定义：先做登录口/);
assert.doesNotMatch(customAloneText, /补充/);

// Spec #450: next_steps projects to one wizard question; custom-alone reduces.
assert.equal(resolveChoicePresentation(card), "approval_wizard");
const projected = parseWizardQuestions(card);
assert.equal(projected.length, 1);
assert.equal(projected[0].id, PROJECTED_NEXT_STEPS_QUESTION_ID);
assert.equal(projected[0].allow_custom, true);

assert.equal(
  isQuestionAnswerValid({
    selection: "single",
    allow_custom: true,
    selected_option_ids: ["deepen"],
    custom_text: "",
  }),
  true,
);
assert.equal(
  isQuestionAnswerValid({
    selection: "single",
    allow_custom: true,
    selected_option_ids: [],
    custom_text: "先做登录口",
  }),
  true,
);
assert.equal(
  isQuestionAnswerValid({
    selection: "single",
    allow_custom: true,
    selected_option_ids: ["deepen"],
    custom_text: "note",
  }),
  false,
  "single: custom XOR option",
);
assert.equal(
  isQuestionAnswerValid({
    selection: "single",
    allow_custom: true,
    selected_option_ids: [],
    custom_text: "",
  }),
  false,
);

const reducedCustom = reduceChoiceDecision(card, { custom_text: "先做登录口" });
assert.equal(reducedCustom.ok, true);
if (reducedCustom.ok) {
  assert.deepEqual(reducedCustom.selected_option_ids, []);
  assert.equal(reducedCustom.custom_text, "先做登录口");
}

const reducedEmpty = reduceChoiceDecision(card, { selected_option_ids: [] });
assert.equal(reducedEmpty.ok, false);

const wizardCard = {
  presentation: "approval_wizard",
  questions: [
    {
      id: "q1",
      prompt: "How many flavors?",
      selection: "single",
      options: [
        { id: "three", title: "Three" },
        { id: "five", title: "Five" },
      ],
    },
    {
      id: "q2",
      prompt: "Mix-ins?",
      selection: "multi",
      options: [{ id: "chips", title: "Chips" }],
      allow_custom: true,
    },
  ],
};
const wizardOk = validateChoiceCardPayload(wizardCard);
assert.equal(wizardOk.ok, true);
if (wizardOk.ok) {
  assert.equal(wizardOk.mode, "next_steps");
  assert.equal(wizardOk.value.presentation, "approval_wizard");
}

const wizardReduced = reduceChoiceDecision(wizardCard, {
  answers: [
    { question_id: "q1", selected_option_ids: ["three"] },
    { question_id: "q2", selected_option_ids: ["chips"], custom_text: "sprinkles" },
  ],
});
assert.equal(wizardReduced.ok, true);
if (wizardReduced.ok) {
  assert.deepEqual(wizardReduced.selected_option_ids, ["three", "chips"]);
}

const customOnlyQ = validateChoiceCardPayload({
  presentation: "approval_wizard",
  questions: [{ id: "only", prompt: "Anything else?", options: [], allow_custom: true }],
});
assert.equal(customOnlyQ.ok, true);

const customBlocked = validateChoiceCardPayload({
  presentation: "approval_wizard",
  questions: [{ id: "only", prompt: "Pick one", options: [], allow_custom: false }],
});
assert.equal(customBlocked.ok, false);

// --- S3 soft gate ---

assert.equal(
  shouldSoftGateNextSteps({
    boundary: "stoppable",
    openWorksetCount: 3,
    hasLegalChoiceCard: false,
    turnHadTools: false,
  }),
  true,
);
assert.equal(
  shouldSoftGateNextSteps({
    boundary: "continue_empty",
    openWorksetCount: 0,
    openPriors: true,
    hasLegalChoiceCard: false,
    turnHadTools: false,
  }),
  true,
);
assert.equal(
  shouldSoftGateNextSteps({
    boundary: "stoppable",
    openWorksetCount: 2,
    hasLegalChoiceCard: true,
    turnHadTools: false,
  }),
  false,
  "legal choice present → no gate",
);
assert.equal(
  shouldSoftGateNextSteps({
    boundary: "stoppable",
    openWorksetCount: 2,
    hasLegalChoiceCard: false,
    turnHadTools: true,
  }),
  false,
  "tools this turn → no gate",
);
assert.equal(
  shouldSoftGateNextSteps({
    boundary: "mid_turn",
    openWorksetCount: 5,
    hasLegalChoiceCard: false,
    turnHadTools: false,
  }),
  false,
  "non-boundary → no gate",
);
assert.equal(
  shouldSoftGateNextSteps({
    boundary: "settle",
    openWorksetCount: 0,
    openPriors: false,
    hasLegalChoiceCard: false,
    turnHadTools: false,
  }),
  false,
);

assert.equal(isChoiceDecisionFinal("confirm_options"), true);
assert.equal(isChoiceDecisionFinal("answered"), true);
assert.equal(isChoiceDecisionFinal("maybe"), false);

console.log("choiceCard.test.ts ok");
