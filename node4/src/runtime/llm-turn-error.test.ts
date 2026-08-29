/**
 * LLM soft-error detection (task_error path).
 * Run: npx tsx src/runtime/llm-turn-error.test.ts
 */
import assert from "node:assert/strict";
import {
  LlmTurnError,
  assistantTurnErrorMessage,
  extractLlmTurnError,
  formatLlmErrorForUser,
  isLlmTurnError,
} from "./llm-turn-error.js";

assert.equal(assistantTurnErrorMessage({ role: "assistant", content: [] } as any), null);
assert.equal(
  assistantTurnErrorMessage({
    role: "assistant",
    stopReason: "error",
    errorMessage: "403 China opt in",
    content: [],
  } as any),
  "模型调用失败：403 China opt in",
);
assert.match(
  assistantTurnErrorMessage({
    role: "assistant",
    stop_reason: "error",
    error_message: "rate limited",
  } as any) || "",
  /rate limited/,
);

// Negative: normal assistant end_turn + empty content must NOT trip
assert.equal(
  assistantTurnErrorMessage({
    role: "assistant",
    stopReason: "end_turn",
    content: [],
  } as any),
  null,
);

// Negative: successful stop + string errorMessage must NOT trip
assert.equal(
  assistantTurnErrorMessage({
    role: "assistant",
    stopReason: "end_turn",
    errorMessage: "stray provider noise",
    content: [],
  } as any),
  null,
);
assert.equal(
  assistantTurnErrorMessage({
    role: "assistant",
    stopReason: "tool_use",
    errorMessage: "should ignore",
  } as any),
  null,
);

// Negative: stray non-string error field must NOT trip
assert.equal(
  assistantTurnErrorMessage({
    role: "assistant",
    stopReason: "end_turn",
    error: { code: 403, message: "object error" },
    content: [],
  } as any),
  null,
);
assert.equal(
  assistantTurnErrorMessage({
    role: "assistant",
    content: [],
    error: { nested: true },
  } as any),
  null,
);

// Positive: empty/missing stop + string errorMessage still surfaces
assert.match(
  assistantTurnErrorMessage({
    role: "assistant",
    errorMessage: "provider 403",
    content: [],
  } as any) || "",
  /403/,
);

// stop===error without message still surfaces
assert.match(
  assistantTurnErrorMessage({
    role: "assistant",
    stopReason: "error",
    content: [],
  } as any) || "",
  /Model request failed|模型调用失败/,
);

const msgs = [
  { role: "user", content: "hi" },
  {
    role: "assistant",
    stopReason: "error",
    errorMessage: "403 The latest version of this model is only available hosted in China",
    content: [],
  },
];
const extracted = extractLlmTurnError(msgs);
assert.ok(extracted);
assert.match(extracted!, /403/);
assert.match(extracted!, /模型调用失败/);

assert.equal(extractLlmTurnError([{ role: "user", content: "x" }]), null);
assert.equal(extractLlmTurnError([]), null);
// Free-path settlement contract: soft-error extract is the sole signal before task_error
assert.equal(
  extractLlmTurnError([
    { role: "assistant", stopReason: "end_turn", content: [] },
  ]),
  null,
);
assert.ok(
  extractLlmTurnError([
    { role: "assistant", stopReason: "error", errorMessage: "soft fail" },
  ]),
);

const e = new LlmTurnError("403 fail");
assert.equal(isLlmTurnError(e), true);
assert.equal(e.code, "llm_error");
assert.match(formatLlmErrorForUser("plain"), /模型调用失败：plain/);
assert.match(formatLlmErrorForUser("context_length exceeded"), /occupancy \/ context-length/);
assert.match(
  formatLlmErrorForUser("Stream ended without finish_reason"),
  /输出流未正常结束/,
);

console.log("llm-turn-error.test.ts: ok");
