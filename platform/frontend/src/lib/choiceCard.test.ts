/**
 * Spec #312 S1–S3 pure contracts.
 */
import assert from "node:assert/strict";
import {
  expandSelectedOptions,
  formatSelectedSummary,
  isChoiceDecisionFinal,
  isNextStepsChoice,
  parseChoiceOptions,
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
  assert.equal(nextOk.value.selection, "multi");
}

// Infer next_steps from structured options without kind
const inferred = validateChoiceCardPayload({
  options: [
    { id: "x", title: "X", body: "bx" },
    { id: "y", title: "Y", body: "by" },
  ],
});
assert.equal(inferred.ok, true);
if (inferred.ok) assert.equal(inferred.mode, "next_steps");

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
