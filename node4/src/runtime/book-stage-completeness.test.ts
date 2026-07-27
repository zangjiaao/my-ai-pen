/**
 * validate_book completeness pure helpers (#161 / #192 / #193).
 * Run: npx tsx src/runtime/book-stage-completeness.test.ts
 */
import assert from "node:assert/strict";
import {
  EMPTY_BOOK_ERROR,
  evaluateEmptyBookGate,
  formatEmptyBookRepairBrief,
  formatFeedbackOkCaptainSurface,
  isBookingOnlyStage,
} from "./book-stage-completeness.js";
import { stageUserPrompt } from "./hard-graph-stage-executor.js";
import type { StageExecutorInput } from "./hard-graph-runner.js";

// --- isBookingOnlyStage ---
assert.equal(isBookingOnlyStage({ id: "validate_book", intent: "book", unbookable_on_exit: true }), true);
assert.equal(isBookingOnlyStage({ id: "validate_book" }), true);
assert.equal(isBookingOnlyStage({ id: "component", intent: "probe" }), false);
assert.equal(isBookingOnlyStage({ id: "x", unbookable_on_exit: true }), true);

// --- evaluateEmptyBookGate hybrid ---
assert.equal(
  evaluateEmptyBookGate({
    isBookStage: true,
    confirmableFeedbackOkAtStart: 14,
    storeBookedDelta: 0,
  }).ok,
  false,
  "empty book with feedback_ok fails",
);
assert.equal(
  (evaluateEmptyBookGate({
    isBookStage: true,
    confirmableFeedbackOkAtStart: 14,
    storeBookedDelta: 0,
  }) as { ok: false; error: string }).error,
  EMPTY_BOOK_ERROR,
);
assert.equal(
  evaluateEmptyBookGate({
    isBookStage: true,
    confirmableFeedbackOkAtStart: 14,
    storeBookedDelta: 3,
  }).ok,
  true,
  "partial book passes",
);
assert.equal(
  evaluateEmptyBookGate({
    isBookStage: true,
    confirmableFeedbackOkAtStart: 0,
    storeBookedDelta: 0,
  }).ok,
  true,
  "nothing to book passes",
);
assert.equal(
  evaluateEmptyBookGate({
    isBookStage: false,
    confirmableFeedbackOkAtStart: 99,
    storeBookedDelta: 0,
  }).ok,
  true,
  "non-book stage ignores empty book",
);

// --- captain surface ---
const cap = formatFeedbackOkCaptainSurface([
  { id: "find-a", title: "SQLi", severity: "high" },
  { id: "find-b", title: "XSS", severity: "medium" },
]);
assert.match(cap, /feedback_ok_n: 2/);
assert.match(cap, /finding_id=find-a/);
assert.match(cap, /finding\(confirm, finding_id/);
assert.doesNotMatch(cap, /DVWA/i);

const emptyCap = formatFeedbackOkCaptainSurface([]);
assert.match(emptyCap, /feedback_ok_n: 0/);

const brief = formatEmptyBookRepairBrief({
  stageId: "validate_book",
  failedAttempt: 1,
  confirmableIds: ["find-a", "find-b"],
});
assert.match(brief, /empty_book/);
assert.match(brief, /find-a/);

// --- stageUserPrompt book footer + captain (#192) ---
const bookInput: StageExecutorInput = {
  stage: {
    id: "validate_book",
    intent: "book",
    unbookable_on_exit: true,
    success: "confirm feedback_ok",
    require: { summary: true },
    tools: { allow: ["todo", "finding"] },
  } as any,
  stageIndex: 6,
  graphId: "app_assessment",
  handoff: {
    surfaces: [],
    candidates: [{ title: "c", location: "http://t/", claim: "x", proof_excerpt: "y".repeat(30) }],
    facts: [],
    deadends: [],
    completed_stages: ["component"],
  },
  tools: ["todo", "finding"],
  toolProfile: { allow: ["todo", "finding"] },
};
const task = {
  taskId: "t",
  conversationId: "c",
  instruction: "assess",
  target: {},
  scope: {},
} as any;

const userBook = stageUserPrompt(bookInput, task, {
  confirmableFeedbackOk: [{ id: "find-a", title: "SQLi", severity: "high" }],
});
assert.match(userBook, /finding_id=find-a/);
assert.match(userBook, /finding\(list\)/);
assert.match(userBook, /finding\(confirm, finding_id/);
assert.doesNotMatch(userBook, /finding\(upsert\) as primary|candidates via finding\(upsert\)/);
assert.doesNotMatch(userBook, /deposit surfaces via fact/);

const userProbe = stageUserPrompt(
  {
    ...bookInput,
    stage: {
      id: "class_probe",
      intent: "probe",
      tools: { allow: ["todo", "subagent"] },
    } as any,
    tools: ["todo", "subagent"],
  },
  task,
);
assert.doesNotMatch(userProbe, /Confirmable Finding Store/);

console.log("book-stage-completeness.test.ts: ok");
