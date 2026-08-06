/**
 * Spec #305 pure seams for thinking lifecycle + tool success (S3 / S5).
 * Run: npx tsx src/lib/status.test.ts  (from platform/frontend)
 */
import assert from "node:assert/strict";
import {
  isSuccessfulToolExecution,
  mergeThinkingStatus,
  normalizeExecutionStatus,
  resolveThinkingUiStatus,
  thinkingLifecycleTitle,
} from "./status.ts";

// S3 ThinkingCard projection helpers
{
  assert.equal(resolveThinkingUiStatus(undefined), "done");
  assert.equal(resolveThinkingUiStatus(null), "done");
  assert.equal(resolveThinkingUiStatus(""), "done");
  assert.equal(resolveThinkingUiStatus("running"), "running");
  assert.equal(resolveThinkingUiStatus("done"), "done");
  assert.equal(resolveThinkingUiStatus("completed"), "done");

  assert.equal(thinkingLifecycleTitle(undefined), "思考完成");
  assert.equal(thinkingLifecycleTitle(""), "思考完成");
  assert.equal(thinkingLifecycleTitle("running"), "思考中…");
  assert.equal(thinkingLifecycleTitle("done"), "思考完成");
  console.log("ok: S3 thinking title + historical missing → done");
}

// Platform/FE merge: prefer done over stale running
{
  assert.equal(mergeThinkingStatus("running", "done"), "done");
  assert.equal(mergeThinkingStatus("done", "running"), "done");
  assert.equal(mergeThinkingStatus("done", undefined), "done");
  assert.equal(mergeThinkingStatus(undefined, "running"), "running");
  assert.equal(mergeThinkingStatus(undefined, undefined), undefined);
  console.log("ok: mergeThinkingStatus prefers done");
}

// S5: running never counts successful even with HTTP 200 in result
{
  assert.equal(
    isSuccessfulToolExecution("running", { status_code: 200 }),
    false,
    "running + HTTP 200 must not look done",
  );
  assert.equal(isSuccessfulToolExecution("done"), true);
  assert.equal(isSuccessfulToolExecution("error"), false);
  assert.equal(
    isSuccessfulToolExecution("", { status_code: 200 }),
    true,
    "historical missing status may use result code",
  );
  assert.equal(normalizeExecutionStatus(""), "running");
  console.log("ok: S5 tool running not successful with result hints");
}

console.log("all status Spec #305 tests passed");
