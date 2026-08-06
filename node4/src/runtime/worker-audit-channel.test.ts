/**
 * Spec #308 pure seams: package turn id, delivery mapping, Worker scope detect.
 */
import assert from "node:assert/strict";
import {
  isWorkerAuditScoped,
  mapDeliveryStatus,
  newPackageTurnId,
  handoffFieldsForAudit,
  WORKER_AUDIT_CHANNEL,
} from "./worker-audit-channel.js";

function testNewPackageTurnId() {
  const a = newPackageTurnId("sub_1");
  const b = newPackageTurnId("sub_1");
  assert.ok(a.startsWith("pkg_sub_1_"), a);
  assert.notEqual(a, b, "turn ids must be unique per call");
}

function testIsWorkerAuditScoped() {
  assert.equal(isWorkerAuditScoped(null), false);
  assert.equal(isWorkerAuditScoped({}), false);
  assert.equal(isWorkerAuditScoped({ agent_id: "sub_1" }), false, "agent alone not enough");
  assert.equal(isWorkerAuditScoped({ package_turn_id: "pkg_x" }), false, "turn alone not enough");
  assert.equal(
    isWorkerAuditScoped({ agent_id: "sub_1", package_turn_id: "pkg_x" }),
    true,
  );
  assert.equal(
    isWorkerAuditScoped({ channel: WORKER_AUDIT_CHANNEL }),
    true,
    "explicit channel is scoped even without ids",
  );
  assert.equal(
    isWorkerAuditScoped({ channel: "main", agent_id: "x" }),
    false,
  );
}

function testMapDeliveryStatus() {
  assert.equal(mapDeliveryStatus({ aborted: true, ok: true }), "interrupted");
  assert.equal(mapDeliveryStatus({ aborted: true, ok: false }), "interrupted");
  assert.equal(mapDeliveryStatus({ ok: true }), "ok");
  assert.equal(mapDeliveryStatus({ ok: false }), "failed");
  assert.equal(mapDeliveryStatus({ ok: false, timedOut: true }), "failed");
  assert.notEqual(mapDeliveryStatus({ aborted: true }), mapDeliveryStatus({ ok: false }));
}

function testHandoffFields() {
  const fields = handoffFieldsForAudit(
    {
      target: "https://ex.com",
      scope: "web",
      already_done: "recon",
      this_turn_goal: "probe sqli",
      success_criteria: "poc or deadend",
    },
    "extra notes",
  );
  assert.equal(fields.this_turn_goal, "probe sqli");
  assert.equal(fields.target, "https://ex.com");
  assert.equal(fields.assignment, "extra notes");
  for (const k of ["target", "scope", "already_done", "this_turn_goal", "success_criteria"]) {
    assert.ok(k in fields, k);
  }
}

testNewPackageTurnId();
testIsWorkerAuditScoped();
testMapDeliveryStatus();
testHandoffFields();
console.log("worker-audit-channel.test.ts: ok");
