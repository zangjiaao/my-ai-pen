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
} from "./approvals.js";

clearAllApprovals();

assert.equal(normalizeApprovalResponse("authorize"), "authorize");
assert.equal(normalizeApprovalResponse("approved"), "authorize");
assert.equal(normalizeApprovalResponse("yes"), "authorize");
assert.equal(normalizeApprovalResponse("cancel"), "cancel");
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
assert.equal(isStructuredApprovalResponse("同意"), false);
assert.equal(isStructuredApprovalResponse("go ahead"), false);

// resolveApproval unblocks waiter with normalized decision.
const wait = registerApprovalWait("req-1", "conv-1");
const resolved = resolveApproval("req-1", "同意");
assert.equal(resolved, true);
assert.equal(await wait, "authorize");

const waitCancel = registerApprovalWait("req-2", "conv-1");
assert.equal(resolveApproval("req-2", "取消"), true);
assert.equal(await waitCancel, "cancel");

// Unknown request id
assert.equal(resolveApproval("missing", "authorize"), false);

clearAllApprovals();
console.log("approvals.test.ts: ok");
