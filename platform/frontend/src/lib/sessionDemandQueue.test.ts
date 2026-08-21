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
  SESSION_DEMAND_MAX_PER_CASE,
  sessionDemandQueueIsFull,
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
  const five: SessionDemandItem[] = Array.from({ length: SESSION_DEMAND_MAX_PER_CASE }, (_, i) => ({
    id: `p${i}`,
    kind: "text",
    text: `t${i}`,
    status: "pending",
  }));
  assert.equal(sessionDemandQueueIsFull([]), false);
  assert.equal(sessionDemandQueueIsFull(five.slice(0, 4)), false);
  assert.equal(sessionDemandQueueIsFull(five), true);
  assert.equal(
    sessionDemandQueueIsFull([...five.slice(0, 4), { ...a, status: "cancelled" }]),
    false,
    "cancelled rows do not count toward the cap",
  );
  console.log("ok: sessionDemandQueueIsFull");
}

{
  const here = dirname(fileURLToPath(import.meta.url));
  const pageSrc = readFileSync(join(here, "../pages/ConversationPage.tsx"), "utf8");
  assert.match(
    pageSrc,
    /session_demand_drained[\s\S]*queuedDemandUserContent/,
    "drain must append a user bubble, not only drop queue chrome",
  );
  const forceFn = pageSrc.match(/const handleForceDemand[\s\S]*?\}, \[/);
  assert.ok(forceFn, "handleForceDemand must exist");
  assert.match(forceFn[0], /session_demand_force/, "force-send still dispatches");
  assert.doesNotMatch(
    forceFn[0],
    /queuedDemandUserContent|addMessageToConversation|removeQueuedDemand/,
    "force-send must wait for session_demand_drained before promoting a user bubble",
  );
  const composerSrc = readFileSync(join(here, "../components/ChatComposer.tsx"), "utf8");
  assert.match(
    composerSrc,
    /demandQueueFull/,
    "composer must not clear draft when the Session demand queue is full",
  );
  console.log("ok: ConversationPage promotes drained demands to user bubbles");
}
