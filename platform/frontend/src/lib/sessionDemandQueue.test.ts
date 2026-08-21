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
  assert.deepEqual(cancelled.map((r) => r.id), ["b"]);
  assert.deepEqual(pendingQueuedDemands(cancelled).map((r) => r.id), ["b"]);
  const gone = removeQueuedDemand(cancelled, "b");
  assert.deepEqual(gone, []);
  console.log("ok: cancel and remove drop the row");
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
  const editFn = pageSrc.match(/const handleEditDemand[\s\S]*?\}, \[/);
  assert.ok(editFn, "handleEditDemand must exist");
  assert.match(editFn[0], /session_demand_delete/, "edit deletes the queued demand");
  assert.match(editFn[0], /setValue/, "edit overwrites the composer draft");
  assert.doesNotMatch(editFn[0], /interrupting/, "edit must not wait for interrupt to clear");
  assert.match(editFn[0], /forcingDemandId/, "edit must no-op on the row already taken for force-send");
  const cancelFn = pageSrc.match(/const handleCancelDemand[\s\S]*?\}, \[/);
  assert.ok(cancelFn, "handleCancelDemand must exist");
  assert.match(cancelFn[0], /removeQueuedDemand/, "cancel drops the row");
  assert.doesNotMatch(cancelFn[0], /cancelQueuedDemand/, "cancel must not leave a cancelled ghost");
  assert.match(cancelFn[0], /forcingDemandId/, "cancel must no-op on the row already taken for force-send");
  assert.match(
    pageSrc,
    /handleConfirmOptions[\s\S]*sessionDemandQueueIsFull[\s\S]*liveWait/,
    "queue-full must refuse enqueue only — live approval wait still sends",
  );
  assert.match(
    pageSrc,
    /resetConversationState[\s\S]*setForcingDemandId\(null\)/,
    "Case switch must drop the force-row lock",
  );
  assert.match(
    pageSrc,
    /task_complete:[\s\S]*setForcingDemandId\(null\)/,
    "terminal settle must drop the force-row lock",
  );
  const choiceDisabled = pageSrc.match(/choiceDisabled=\{\s*([\s\S]*?)\s*\}/);
  assert.ok(choiceDisabled, "choiceDisabled must exist");
  assert.doesNotMatch(
    choiceDisabled[1],
    /sessionDemandQueueIsFull/,
    "queue-full must not grey authorize/handoff ChoiceCards",
  );
  assert.match(
    pageSrc,
    /session_demand_rejected[\s\S]*setValue/,
    "rejected text enqueue must restore the composer draft",
  );
  const composerSrc = readFileSync(join(here, "../components/ChatComposer.tsx"), "utf8");
  assert.match(
    composerSrc,
    /demandQueueFull/,
    "composer must not clear draft when the Session demand queue is full",
  );
  const queueSrc = readFileSync(join(here, "../components/SessionDemandQueue.tsx"), "utf8");
  assert.match(queueSrc, /SESSION_DEMAND_SEND_LABEL/);
  assert.match(queueSrc, /SESSION_DEMAND_EDIT_LABEL/);
  assert.match(queueSrc, /SESSION_DEMAND_CANCEL_LABEL/);
  assert.match(
    queueSrc,
    /disabled=\{forceDisabled\}[\s\S]{0,240}SESSION_DEMAND_SEND_LABEL/,
    "only force-send is gated on interrupt",
  );
  assert.match(queueSrc, /busyDemandId/, "the force-taken row must be identifiable");
  assert.match(queueSrc, /rowTaken/, "edit/cancel lock only the force-taken row");
  const sendJsx = queueSrc.indexOf("{SESSION_DEMAND_SEND_LABEL}");
  assert.ok(sendJsx >= 0, "send label is rendered");
  const afterSendJsx = queueSrc.slice(sendJsx);
  assert.match(afterSendJsx, /SESSION_DEMAND_EDIT_LABEL/);
  assert.match(afterSendJsx, /SESSION_DEMAND_CANCEL_LABEL/);
  assert.doesNotMatch(
    afterSendJsx,
    /forceDisabled/,
    "edit and cancel stay available on other rows during interrupt",
  );
  console.log("ok: ConversationPage promotes drained demands to user bubbles");
}
