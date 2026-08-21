/**
 * Approval wait normalize + resolve (Spec #277 §3.3 14a free-text feedback).
 */
import assert from "node:assert/strict";
import {
  clearAllApprovals,
  isStructuredApprovalResponse,
  normalizeApprovalResponse,
  registerApprovalWait,
  resolveApproval,
  shouldAbortTurnOnApprovalDecision,
} from "./approvals.js";

clearAllApprovals();

assert.equal(normalizeApprovalResponse("authorize"), "authorize");
assert.equal(normalizeApprovalResponse("approved"), "authorize");
assert.equal(normalizeApprovalResponse("yes"), "authorize");
assert.equal(normalizeApprovalResponse("confirm_options"), "confirm_options");
// Spec #312 L9: secondary multi-card freeze must not authorize (handoff/graph).
assert.equal(normalizeApprovalResponse("answered"), "answered");
assert.equal(normalizeApprovalResponse("cancel"), "cancel");
assert.equal(shouldAbortTurnOnApprovalDecision("cancel"), true);
assert.equal(shouldAbortTurnOnApprovalDecision("authorize"), false);
assert.equal(shouldAbortTurnOnApprovalDecision("confirm_options"), false);
assert.equal(shouldAbortTurnOnApprovalDecision("answered"), false);
assert.equal(normalizeApprovalResponse("取消"), "cancel");
assert.equal(normalizeApprovalResponse("拒绝"), "cancel");
assert.equal(normalizeApprovalResponse("no"), "cancel");
assert.equal(normalizeApprovalResponse(""), "cancel");
// Free-text engagement (not platform NLP — Session tool only).
assert.equal(normalizeApprovalResponse("同意"), "authorize");
assert.equal(normalizeApprovalResponse("可以，开始吧"), "authorize");
assert.equal(normalizeApprovalResponse("go ahead"), "authorize");

assert.equal(isStructuredApprovalResponse("authorize"), true);
assert.equal(isStructuredApprovalResponse("cancel"), true);
assert.equal(isStructuredApprovalResponse("confirm_options"), true);
assert.equal(isStructuredApprovalResponse("answered"), true);
assert.equal(isStructuredApprovalResponse("同意"), false);
assert.equal(isStructuredApprovalResponse("go ahead"), false);

// resolveApproval unblocks waiter with normalized decision.
const wait = registerApprovalWait("req-1", "conv-1");
const resolved = resolveApproval("req-1", "同意");
assert.equal(resolved, true);
assert.equal((await wait).decision, "authorize");

const waitCancel = registerApprovalWait("req-2", "conv-1");
assert.equal(resolveApproval("req-2", "取消"), true);
assert.equal((await waitCancel).decision, "cancel");

// Spec #312: confirm_options carries selected option ids.
const waitNext = registerApprovalWait("req-3", "conv-1");
assert.equal(
  resolveApproval("req-3", "confirm_options", {
    selected_option_ids: ["a", "b"],
    workset_item_ids: ["w1"],
    text: "已选择：A、B",
  }),
  true,
);
const nextResult = await waitNext;
assert.equal(nextResult.decision, "confirm_options");
assert.deepEqual(nextResult.selected_option_ids, ["a", "b"]);
assert.deepEqual(nextResult.workset_item_ids, ["w1"]);
assert.equal(nextResult.text, "已选择：A、B");

const waitCustom = registerApprovalWait("req-3b", "conv-1");
assert.equal(
  resolveApproval("req-3b", "confirm_options", {
    selected_option_ids: [],
    custom_text: "先做登录口",
    text: "已选择：\n- 自定义：先做登录口",
  }),
  true,
);
const customResult = await waitCustom;
assert.equal(customResult.decision, "confirm_options");
assert.equal(customResult.custom_text, "先做登录口");

// Spec #312 L9: secondary freeze unblocks as answered (not authorize).
const waitAnswered = registerApprovalWait("req-4", "conv-1");
assert.equal(resolveApproval("req-4", "answered"), true);
assert.equal((await waitAnswered).decision, "answered");

// Unknown request id
assert.equal(resolveApproval("missing", "authorize"), false);

clearAllApprovals();
console.log("approvals.test.ts: ok");
