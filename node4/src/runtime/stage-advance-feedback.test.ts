/**
 * Stage-advance Feedback: typed vote only — no instruction NLP.
 * Run: npx tsx src/runtime/stage-advance-feedback.test.ts
 */
import assert from "node:assert/strict";
import {
  buildStageAdvanceDecisionPayload,
  evaluateStageAdvance,
  parseStageAdvance,
} from "./stage-advance-feedback.js";

assert.equal(parseStageAdvance({ stage_advance: "pause" }), "pause");
assert.equal(parseStageAdvance({ stageAdvance: "STOP" }), "stop");
assert.equal(parseStageAdvance({ data: { stage_advance: "continue" } }), "continue");
assert.equal(
  parseStageAdvance({ facts: [{ key: "stage_advance", summary: "pause" }] }),
  "pause",
);
assert.equal(
  parseStageAdvance({ facts: [{ fact_key: "graph/stage_advance", summary: "stop — bounded" }] }),
  "stop",
);
assert.equal(
  parseStageAdvance({ notes: "stage_advance=pause", deadends: ["pause"] }),
  undefined,
  "must not scrape notes/deadends",
);
assert.equal(
  parseStageAdvance({ facts: [{ key: "notes", summary: "user said pause after surface" }] }),
  undefined,
  "must not treat unrelated fact summaries as a vote",
);

assert.equal(
  evaluateStageAdvance({
    vote: "pause",
    instruction: "",
    hasNextStage: true,
  }),
  "pause",
);
assert.equal(
  evaluateStageAdvance({
    vote: { stage_advance: "continue" },
    instruction: "摸完 surface 可以停。若你准备进 class_probe 先问我。",
    hasNextStage: true,
  }),
  "continue",
  "typed continue wins; host must not NLP 可以停",
);
assert.equal(
  evaluateStageAdvance({
    vote: undefined,
    instruction: "摸完 surface 可以停",
    hasNextStage: true,
  }),
  "continue",
  "missing vote → continue (Feedback Agent judges; host does not HITL)",
);
assert.equal(
  evaluateStageAdvance({
    captainAdvance: undefined,
    instruction: "",
    hasNextStage: true,
  }),
  "continue",
  "empty instruction (lab) → continue",
);
assert.equal(
  evaluateStageAdvance({
    captainAdvance: undefined,
    instruction: "full assessment",
    hasNextStage: false,
  }),
  "continue",
  "last stage does not pause",
);
assert.equal(
  evaluateStageAdvance({
    vote: "stop",
    instruction: "",
    hasNextStage: true,
  }),
  "stop",
);

const card = buildStageAdvanceDecisionPayload({
  conversationId: "c1",
  taskId: "t1",
  graphId: "app_assessment",
  stageId: "surface",
  nextStageId: "auth_session",
  captainSummary: "three surfaces TESTED",
  requestId: "req-1",
});
assert.equal(card.type, "request_decision");
assert.equal(card.kind, "next_steps");
assert.match(String(card.question), /auth_session/);
assert.match(String(card.question), /surface/);
const opts = card.options as Array<{ id: string; title: string }>;
assert.equal(opts[0]?.id, "advance_continue");
assert.equal(opts[0]?.title, "auth_session");
assert.equal(opts[1]?.id, "advance_stop");
assert.equal(opts[1]?.title, "surface");
assert.doesNotMatch(JSON.stringify(card), /端口扫描|class_probe 探测/);

console.log("stage-advance-feedback.test.ts: ok");
