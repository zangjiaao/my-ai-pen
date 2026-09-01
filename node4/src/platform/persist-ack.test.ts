/**
 * Spec #280 / #543 — persist ack matching is the Node↔platform SoT seam.
 * Run: npx tsx src/platform/persist-ack.test.ts
 */
import assert from "node:assert/strict";
import {
  PersistAckHub,
  isVulnPersistAck,
  needsVulnPersistAck,
  persistAckTimeoutFrame,
  stampPersistNonce,
} from "./persist-ack.js";

assert.equal(needsVulnPersistAck({ type: "vuln_found" }), true);
assert.equal(needsVulnPersistAck({ type: "text" }), false);

const stamped = { type: "vuln_found", conversation_id: "c1" };
const nonce = stampPersistNonce(stamped);
assert.ok(nonce.length > 8);
assert.equal(String((stamped as { persist_nonce?: string }).persist_nonce), nonce);
assert.equal(stampPersistNonce(stamped), nonce, "nonce is stable");

assert.equal(
  isVulnPersistAck(nonce, { type: "vuln_found", persist_nonce: nonce, created: true } as never),
  true,
);
assert.equal(
  isVulnPersistAck(nonce, { type: "vuln_found_error", persist_nonce: nonce, created: false } as never),
  true,
);
assert.equal(
  isVulnPersistAck(nonce, { type: "vuln_found", persist_nonce: "other", created: true } as never),
  false,
);
assert.equal(isVulnPersistAck(nonce, { type: "text", persist_nonce: nonce } as never), false);

const timeout = persistAckTimeoutFrame(nonce);
assert.equal(timeout.type, "vuln_found_error");
assert.equal(timeout.created, false);
assert.match(String(timeout.error), /timeout/i);

{
  const hub = new PersistAckHub();
  const p = hub.register("n-1", 5_000);
  assert.equal(hub.take({ type: "vuln_found", persist_nonce: "n-1", created: true } as never), true);
  const ack = await p;
  assert.equal(ack.created, true);
  assert.equal(ack.type, "vuln_found");
}

{
  const hub = new PersistAckHub();
  const p = hub.register("n-timeout", 20);
  const ack = await p;
  assert.equal(ack.type, "vuln_found_error");
  assert.equal(ack.created, false);
}

console.log("persist-ack.test.ts ok");
