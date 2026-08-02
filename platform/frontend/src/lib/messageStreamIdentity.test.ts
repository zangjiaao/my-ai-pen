/**
 * Pure stream-identity helpers — no vitest; run with:
 *   npx tsx src/lib/messageStreamIdentity.test.ts
 * (from platform/frontend)
 */
import assert from "node:assert/strict";
import {
  canMorphThinkingFromLiveSlot,
  mergeProgressiveText,
  messageListKey,
  preferNonLiveSlotId,
} from "./messageStreamIdentity.ts";

// messageListKey prefers stream_id
{
  const thinking1 = messageListKey({
    id: "uuid-a",
    content: { stream_id: "n4-thinking-abc-1" },
  });
  const thinking2 = messageListKey({
    id: "uuid-b",
    content: { stream_id: "n4-thinking-abc-2" },
  });
  assert.equal(thinking1, "stream:n4-thinking-abc-1");
  assert.equal(thinking2, "stream:n4-thinking-abc-2");
  assert.notEqual(thinking1, thinking2, "multi-stream thinking keys must be distinct");
  console.log("ok: multi-stream keys distinct for thinking-1 vs thinking-2");
}

{
  const byId = messageListKey({ id: "msg-only", content: {} });
  assert.equal(byId, "msg-only");
  const byCreated = messageListKey({ id: "", created_at: "2020-01-01T00:00:00Z" });
  assert.equal(byCreated, "idx-2020-01-01T00:00:00Z");
  console.log("ok: messageListKey prefers stream_id then id");
}

// preferNonLiveSlotId never returns live-slot when a real id exists
{
  assert.equal(
    preferNonLiveSlotId("live-slot-conv1", "n4-thinking-abc-1", "uuid-real"),
    "n4-thinking-abc-1",
  );
  assert.equal(
    preferNonLiveSlotId("live-slot-conv1", "uuid-real"),
    "uuid-real",
  );
  assert.equal(
    preferNonLiveSlotId(undefined, "live-slot-x", "stream:sid"),
    "stream:sid",
  );
  console.log("ok: preferNonLiveSlotId never returns live-slot when a real id exists");
}

// preferNonLiveSlotId with all empty → deterministic empty string (not random)
{
  const a = preferNonLiveSlotId();
  const b = preferNonLiveSlotId(null, undefined, "", "  ");
  assert.equal(a, "");
  assert.equal(b, "");
  assert.equal(preferNonLiveSlotId("live-slot-only"), "live-slot-only");
  console.log("ok: preferNonLiveSlotId empty → deterministic empty string");
}

// morph only agent_pending + streamId
{
  assert.equal(canMorphThinkingFromLiveSlot("agent_pending", "n4-thinking-1"), true);
  assert.equal(canMorphThinkingFromLiveSlot("agent_pending", ""), false);
  assert.equal(canMorphThinkingFromLiveSlot("agent_pending", null), false);
  assert.equal(canMorphThinkingFromLiveSlot("agent_pending", undefined), false);
  assert.equal(canMorphThinkingFromLiveSlot("thinking", "n4-thinking-1"), false);
  assert.equal(canMorphThinkingFromLiveSlot("text", "n4-thinking-1"), false);
  assert.equal(canMorphThinkingFromLiveSlot(undefined, "n4-thinking-1"), false);
  // Missing stream_id must NOT re-collapse thinking onto the slot
  assert.equal(canMorphThinkingFromLiveSlot("agent_pending", "   "), false);
  console.log("ok: morph only when agent_pending AND streamId present");
}

// mergeProgressiveText
{
  assert.equal(mergeProgressiveText("好的", "好的，我"), "好的，我");
  assert.equal(mergeProgressiveText("好的，我来", "好的"), "好的，我来");
  assert.equal(mergeProgressiveText("", "hello"), "hello");
  assert.equal(mergeProgressiveText("keep", ""), "keep");
  console.log("ok: mergeProgressiveText prefers longer / prefix growth");
}

console.log("all messageStreamIdentity tests passed");
