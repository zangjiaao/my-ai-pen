/**
 * Case speech delta: unread others only, cursor does not re-dump 123 then 1234.
 * Run: npx tsx src/runtime/case-speech.test.ts
 */
import assert from "node:assert/strict";
import type { CaseContext } from "./case-context.js";
import {
  CASE_SPEECH_HEADING,
  formatCaseSpeechHarness,
  selectCaseSpeechDelta,
} from "./case-speech.js";

const ctx: CaseContext = {
  speech: [
    { id: "1", speaker: "user", text: "start on :8080", expert_id: "" },
    { id: "2", speaker: "Default", text: "整理：目标 8080，先登录", expert_id: "def-1" },
    { id: "3", speaker: "pentest", text: "我先探登录", expert_id: "exp-1" },
    { id: "4", speaker: "Default", text: "补充：别扫 3000", expert_id: "def-1" },
  ],
};

const first = selectCaseSpeechDelta(ctx, {
  cursor: "",
  selfExpertId: "exp-1",
  thisTurnText: "继续测登录",
});
assert.deepEqual(
  first.lines.map((l) => l.id),
  ["1", "2", "4"],
  "cold: others + prior user; skip self",
);
assert.equal(first.cursorAfter, "4");
assert.equal(
  first.lines.some((l) => l.text === "继续测登录"),
  false,
);

const again = selectCaseSpeechDelta(ctx, {
  cursor: first.cursorAfter,
  selfExpertId: "exp-1",
  thisTurnText: "继续",
});
assert.deepEqual(again.lines, [], "same window after cursor → no re-dump");
assert.equal(again.cursorAfter, "4");

const grown: CaseContext = {
  speech: [
    ...(ctx.speech || []),
    { id: "5", speaker: "Default", text: "又整理了一版范围", expert_id: "def-1" },
  ],
};
const next = selectCaseSpeechDelta(grown, {
  cursor: first.cursorAfter,
  selfExpertId: "exp-1",
  thisTurnText: "继续",
});
assert.deepEqual(
  next.lines.map((l) => l.id),
  ["5"],
  "growth after cursor is 5 only — not 12345",
);
assert.equal(next.cursorAfter, "5");

const harness = formatCaseSpeechHarness(next.lines);
assert.ok(harness.startsWith(CASE_SPEECH_HEADING));
assert.match(harness, /Default/);
assert.match(harness, /又整理了一版范围/);
assert.ok(!harness.includes("我先探登录"), "self speech never in harness");

const skipThisTurn = selectCaseSpeechDelta(
  {
    speech: [
      { id: "u", speaker: "user", text: "继续", expert_id: "" },
      { id: "d", speaker: "Default", text: "hi", expert_id: "def-1" },
    ],
  },
  { cursor: "", selfExpertId: "exp-1", thisTurnText: "继续" },
);
assert.deepEqual(skipThisTurn.lines.map((l) => l.id), ["d"]);

console.log("case-speech.test.ts: ok");
