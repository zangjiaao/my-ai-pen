/**
 * Run: npx tsx src/lib/sessionDemandQueue.test.ts  (from platform/frontend)
 */
import assert from "node:assert/strict";
import {
  cancelQueuedDemand,
  pendingQueuedDemands,
  removeQueuedDemand,
  upsertQueuedDemand,
  type SessionDemandItem,
} from "./sessionDemandQueue";

const a: SessionDemandItem = { id: "a", kind: "text", text: "first", status: "pending" };
const b: SessionDemandItem = { id: "b", kind: "text", text: "second", status: "pending" };

{
  const next = upsertQueuedDemand([], a);
  assert.equal(next.length, 1);
  assert.equal(next[0].text, "first");
  const updated = upsertQueuedDemand(next, { ...a, text: "first!" });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].text, "first!");
  const two = upsertQueuedDemand(updated, b);
  assert.deepEqual(two.map((r) => r.id), ["a", "b"]);
  console.log("ok: upsertQueuedDemand");
}

{
  const cancelled = cancelQueuedDemand([a, b], "a");
  assert.equal(cancelled[0].status, "cancelled");
  assert.equal(cancelled[1].status, "pending");
  assert.deepEqual(pendingQueuedDemands(cancelled).map((r) => r.id), ["b"]);
  const gone = removeQueuedDemand(cancelled, "b");
  assert.deepEqual(gone.map((r) => r.id), ["a"]);
  console.log("ok: cancel keeps row; remove drops drained");
}
