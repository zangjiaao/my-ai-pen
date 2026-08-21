/**
 * Run: npx tsx src/lib/sessionDemandQueue.test.ts  (from platform/frontend)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cancelQueuedDemand,
  pendingQueuedDemands,
  queuedDemandUserContent,
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

{
  const content = queuedDemandUserContent({ id: "d1", text: "  hello  " });
  assert.equal(content.text, "hello");
  assert.equal(content.message_id, "d1");
  assert.equal(content.client_message_id, "d1");
  console.log("ok: queuedDemandUserContent");
}

{
  const here = dirname(fileURLToPath(import.meta.url));
  const pageSrc = readFileSync(join(here, "../pages/ConversationPage.tsx"), "utf8");
  assert.match(
    pageSrc,
    /session_demand_drained[\s\S]*queuedDemandUserContent/,
    "drain must append a user bubble, not only drop queue chrome",
  );
  assert.match(
    pageSrc,
    /handleForceDemand[\s\S]*queuedDemandUserContent/,
    "force-send must append a user bubble",
  );
  console.log("ok: ConversationPage promotes drained demands to user bubbles");
}
