/**
 * Spec #305 pure seams for thinking lifecycle + tool success (S3 / S5).
 * Run: npx tsx src/lib/status.test.ts  (from platform/frontend)
 */
import assert from "node:assert/strict";
import {
  isSuccessfulToolExecution,
  mergeThinkingStatus,
  mergeToolLifecycleStatus,
  normalizeExecutionStatus,
  resolveThinkingUiStatus,
  resolveThinkingUiStatusForSession,
  resolveToolItemStatus,
  thinkingCardProjection,
  thinkingLifecycleTitle,
  toolActivitySummaryKind,
  toolActivitySummaryLabel,
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

// Issue 8: mergeThinkingStatus uses normalizeExecutionStatus synonyms
{
  assert.equal(mergeThinkingStatus("running", "done"), "done");
  assert.equal(mergeThinkingStatus("done", "running"), "done");
  assert.equal(mergeThinkingStatus("done", undefined), "done");
  assert.equal(mergeThinkingStatus(undefined, "running"), "running");
  assert.equal(mergeThinkingStatus(undefined, undefined), undefined);
  assert.equal(mergeThinkingStatus("running", "completed"), "done");
  assert.equal(mergeThinkingStatus("ok", "running"), "done");
  console.log("ok: mergeThinkingStatus prefers done via normalize");
}

// Spec #305 R2: tool lifecycle merge keeps empty; prefer done
{
  assert.equal(mergeToolLifecycleStatus("", ""), "");
  assert.equal(mergeToolLifecycleStatus(undefined, undefined), "");
  assert.equal(mergeToolLifecycleStatus("running", "done"), "done");
  assert.equal(mergeToolLifecycleStatus("done", "running"), "done");
  assert.equal(mergeToolLifecycleStatus("running", "completed"), "done");
  assert.equal(mergeToolLifecycleStatus("", "running"), "running");
  assert.equal(mergeToolLifecycleStatus("running", ""), "running");
  assert.equal(mergeToolLifecycleStatus("error", "done"), "fail");
  // Live tool_output must mirror this: missing/empty stays empty (no invent running).
  assert.equal(String(undefined ?? "").trim() || "", "");
  assert.equal(resolveToolItemStatus(undefined), "");
  assert.equal(resolveToolItemStatus(null), "");
  console.log("ok: mergeToolLifecycleStatus prefer-done keeps empty");
}

// Issue 13: ThinkingCard presentational projection
{
  const runningEmpty = thinkingCardProjection({ status: "running", text: "" });
  assert.equal(runningEmpty.title, "思考中…");
  assert.equal(runningEmpty.body, "");
  assert.equal(runningEmpty.defaultExpanded, true);
  assert.equal(runningEmpty.showBodyWhenExpanded, false);

  const doneBody = thinkingCardProjection({ status: "done", reasoning: "full plan" });
  assert.equal(doneBody.title, "思考完成");
  assert.equal(doneBody.body, "full plan");
  assert.equal(doneBody.showBodyWhenExpanded, true);

  const historical = thinkingCardProjection({ text: "old" });
  assert.equal(historical.title, "思考完成");
  assert.ok(!String(historical.body).includes("暂无"), "no fake placeholder copy");

  // Orphan running thinking when Case is idle (node restart mid-llm_waiting)
  assert.equal(resolveThinkingUiStatusForSession("running", { sessionActive: false }), "done");
  assert.equal(resolveThinkingUiStatusForSession("running", { sessionActive: true }), "running");
  const orphan = thinkingCardProjection({ status: "running", text: "" }, { sessionActive: false });
  assert.equal(orphan.title, "思考完成");
  console.log("ok: S3 thinkingCardProjection default expanded + empty body");
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

// Issue 3 + 5: tool activity summary surface
{
  assert.equal(resolveToolItemStatus(""), "");
  assert.equal(resolveToolItemStatus("running"), "running");
  assert.equal(resolveToolItemStatus("done"), "done");

  assert.equal(
    toolActivitySummaryKind([
      { status: "running", result: { status_code: 200 } },
    ]),
    "running",
    "explicit running → 执行中 even with 200",
  );
  assert.equal(
    toolActivitySummaryLabel([
      { status: "running", toolName: "shell", result: { status_code: 200 } },
    ]),
    "执行中",
  );

  assert.equal(
    toolActivitySummaryKind([
      { status: "", result: { status_code: 200 } },
    ]),
    "done",
    "missing status + status_code 200 → success family",
  );
  assert.ok(
    toolActivitySummaryLabel([
      { status: "", toolName: "http_request", result: { status_code: 200 } },
    ]).includes("请求") || toolActivitySummaryLabel([
      { status: "", toolName: "http_request", result: { status_code: 200 } },
    ]).includes("完成"),
  );

  assert.equal(
    toolActivitySummaryKind([{ status: "done", toolName: "shell" }]),
    "done",
  );
  assert.equal(
    toolActivitySummaryLabel([{ status: "done", toolName: "shell" }]),
    "已执行1条命令",
  );

  assert.equal(
    toolActivitySummaryKind([{ status: "error" }]),
    "fail",
  );
  assert.equal(toolActivitySummaryLabel([{ status: "error" }]), "失败");
  console.log("ok: S5 toolActivitySummary 执行中 vs success family");
}

console.log("all status Spec #305 tests passed");
