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

const e = new LlmTurnError("403 fail");
assert.equal(isLlmTurnError(e), true);
assert.equal(e.code, "llm_error");
assert.match(formatLlmErrorForUser("plain"), /模型调用失败：plain/);

console.log("llm-turn-error.test.ts: ok");
