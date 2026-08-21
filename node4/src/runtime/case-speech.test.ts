/**
 * Case speech delta: unread others only; isSelf = current pi session_id.
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
    { id: "1", speaker: "user", text: "start on :8080", expert_id: "exp-1" },
    { id: "2", speaker: "Default", text: "整理：目标 8080，先登录", expert_id: "def-1", session_id: "pi-def" },
    { id: "3", speaker: "pentest", text: "我先探登录", expert_id: "exp-1", session_id: "pi-exp-a" },
    { id: "4", speaker: "Default", text: "补充：别扫 3000", expert_id: "def-1", session_id: "pi-def" },
  ],
};

const first = selectCaseSpeechDelta(ctx, {
  cursor: "",
  selfSessionId: "pi-exp-a",
  selfExpertId: "exp-1",
  thisTurnText: "继续测登录",
});
assert.deepEqual(
  first.lines.map((l) => l.id),
  ["1", "2", "4"],
  "same pi session: others + user; skip own session talk",
);
assert.equal(first.cursorAfter, "4");
assert.equal(
  first.lines.some((l) => l.text === "继续测登录"),
  false,
);

const reseed = selectCaseSpeechDelta(ctx, {
  cursor: "",
  selfSessionId: "pi-exp-b",
  selfExpertId: "exp-1",
  thisTurnText: "再试一遍",
});
assert.deepEqual(
  reseed.lines.map((l) => l.id),
  ["1", "2", "3", "4"],
  "new pi session same expert: prior own visible talk is not self",
);

const again = selectCaseSpeechDelta(ctx, {
  cursor: first.cursorAfter,
  selfSessionId: "pi-exp-a",
  thisTurnText: "继续",
});
assert.deepEqual(again.lines, [], "same window after cursor → no re-dump");
assert.equal(again.cursorAfter, "4");

const grown: CaseContext = {
  speech: [
    ...(ctx.speech || []),
    { id: "5", speaker: "Default", text: "又整理了一版范围", expert_id: "def-1", session_id: "pi-def" },
  ],
};
const next = selectCaseSpeechDelta(grown, {
  cursor: first.cursorAfter,
  selfSessionId: "pi-exp-a",
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
assert.ok(!harness.includes("我先探登录"), "self speech never in harness on same session");

const skipThisTurn = selectCaseSpeechDelta(
  {
    speech: [
      { id: "u", speaker: "user", text: "继续", expert_id: "exp-1" },
      { id: "d", speaker: "Default", text: "hi", expert_id: "def-1", session_id: "pi-def" },
    ],
  },
  { cursor: "", selfSessionId: "pi-exp-a", selfExpertId: "exp-1", thisTurnText: "继续" },
);
assert.deepEqual(skipThisTurn.lines.map((l) => l.id), ["d"]);

const skipAuthz = selectCaseSpeechDelta(
  {
    speech: [
      { id: "a", speaker: "user", text: "Authorization decision: authorize", expert_id: "exp-1" },
      { id: "u", speaker: "user", text: "对目标：http://lab 再测", expert_id: "exp-1" },
    ],
  },
  { cursor: "", selfSessionId: "pi-exp-a", thisTurnText: "对目标：http://lab 再测" },
);
assert.deepEqual(skipAuthz.lines.map((l) => l.id), [], "authorize placeholder is not Case speech");

const mentionStamp = selectCaseSpeechDelta(
  {
    speech: [
      { id: "u1", speaker: "user", text: "测 6 个 subagent", expert_id: "exp-1" },
      { id: "m1", speaker: "渗透大师", text: "好的我来测", expert_id: "exp-1", session_id: "pi-old" },
    ],
  },
  { cursor: "", selfSessionId: "pi-new", selfExpertId: "exp-1", thisTurnText: "再试一遍" },
);
assert.deepEqual(
  mentionStamp.lines.map((l) => l.id),
  ["u1", "m1"],
  "user mention expert_id and prior same-expert talk survive a new pi session",
);

console.log("case-speech.test.ts: ok");
