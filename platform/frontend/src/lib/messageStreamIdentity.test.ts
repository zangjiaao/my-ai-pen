/**
 * Pure stream-identity + pending chrome + prune (Spec #276) — no vitest; run with:
 *   npx tsx src/lib/messageStreamIdentity.test.ts
 * (from platform/frontend)
 */
import assert from "node:assert/strict";
import {
  clearLiveStreams,
  durableStreamSnapshots,
  hasProgressiveLive,
  liveFrameToMessageLike,
  mergeMessagesWithLiveStreams,
  mergeProgressiveText,
  messageListKey,
  pendingChromeVisible,
  pruneLiveCatchUp,
  reducePendingChrome,
  upsertLiveByStreamId,
  type LiveStreamFrame,
  type PendingChrome,
} from "./messageStreamIdentity.ts";

// ---------------------------------------------------------------------------
// S1: multi-stream keys; no live-slot helpers
// ---------------------------------------------------------------------------
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

// Live map keys are raw stream_id only; fail-closed without stream_id
{
  let live: Record<string, LiveStreamFrame> = {};
  live = upsertLiveByStreamId(live, {
    streamId: "n4-thinking-abc-1",
    msgType: "thinking",
    text: "first",
  });
  live = upsertLiveByStreamId(live, {
    streamId: "n4-thinking-abc-2",
    msgType: "thinking",
    text: "second turn",
  });
  assert.deepEqual(Object.keys(live).sort(), ["n4-thinking-abc-1", "n4-thinking-abc-2"]);
  assert.equal(live["n4-thinking-abc-1"]!.text, "first");
  assert.equal(live["n4-thinking-abc-2"]!.text, "second turn");

  const before = { ...live };
  const unchanged = upsertLiveByStreamId(live, {
    streamId: "",
    msgType: "thinking",
    text: "orphan without stream",
  });
  assert.equal(unchanged, live, "missing stream_id must not mutate map identity when empty");
  assert.deepEqual(Object.keys(unchanged), Object.keys(before));
  assert.ok(!Object.keys(unchanged).some((k) => k.startsWith("live-slot-")), "no live-slot keys");

  const stillNo = upsertLiveByStreamId(live, {
    streamId: null,
    msgType: "text",
    text: "also ignored",
  });
  assert.deepEqual(Object.keys(stillNo), Object.keys(live));
  console.log("ok: live map stream_id only; fail-closed without stream_id; no live-slot keys");
}

// Progressive growth on same stream_id
{
  let live = upsertLiveByStreamId({}, {
    streamId: "n4-text-1",
    msgType: "text",
    text: "好的",
  });
  live = upsertLiveByStreamId(live, {
    streamId: "n4-text-1",
    msgType: "text",
    text: "好的，我",
  });
  assert.equal(live["n4-text-1"]!.text, "好的，我");
  assert.equal(Object.keys(live).length, 1);
  console.log("ok: same stream_id merges progressive text");
}

// ---------------------------------------------------------------------------
// S2: pending chrome lifecycle
// ---------------------------------------------------------------------------
{
  let pending: PendingChrome = null;
  // tool alone must never show pending
  pending = reducePendingChrome(pending, { type: "tool_output" });
  assert.equal(pending, null);
  assert.equal(pendingChromeVisible(pending, "conv-1"), false);

  // show after send intent
  pending = reducePendingChrome(pending, {
    type: "send_success",
    conversationId: "conv-1",
  });
  assert.deepEqual(pending, { conversationId: "conv-1", label: "思考中…" });
  assert.equal(pendingChromeVisible(pending, "conv-1"), true);
  assert.equal(pendingChromeVisible(pending, "conv-other"), false);

  // tool_output while pending does not clear or reseed
  pending = reducePendingChrome(pending, { type: "tool_output" });
  assert.deepEqual(pending, { conversationId: "conv-1", label: "思考中…" });

  // hide on first stream
  pending = reducePendingChrome(pending, { type: "stream_started" });
  assert.equal(pending, null);
  console.log("ok: pending show after send, hide on stream, not on tool alone");
}

{
  let pending: PendingChrome = reducePendingChrome(null, {
    type: "send_success",
    conversationId: "c2",
    label: "工作中…",
  });
  assert.equal(pending!.label, "工作中…");
  pending = reducePendingChrome(pending, { type: "terminal" });
  assert.equal(pending, null);

  pending = reducePendingChrome(null, { type: "send_success", conversationId: "c3" });
  pending = reducePendingChrome(pending, { type: "clear" });
  assert.equal(pending, null);

  // empty conversationId → no chrome
  assert.equal(
    reducePendingChrome(null, { type: "send_success", conversationId: "" }),
    null,
  );
  console.log("ok: pending hide on terminal/clear; empty conv rejected");
}

// ---------------------------------------------------------------------------
// S3: prune boundary + catch-up
// ---------------------------------------------------------------------------
{
  assert.deepEqual(clearLiveStreams(), {});
  assert.equal(hasProgressiveLive({}), false);

  const live: Record<string, LiveStreamFrame> = {
    "n4-thinking-1": {
      streamId: "n4-thinking-1",
      msgType: "thinking",
      text: "abc",
    },
    "n4-thinking-2": {
      streamId: "n4-thinking-2",
      msgType: "thinking",
      text: "longer live text",
    },
  };
  assert.equal(hasProgressiveLive(live), true);

  // RQ has same stream with text ≥ live → drop; shorter durable keeps live
  const pruned = pruneLiveCatchUp(live, [
    { streamId: "n4-thinking-1", text: "abc" },
    { streamId: "n4-thinking-2", text: "short" },
  ]);
  assert.equal(pruned["n4-thinking-1"], undefined);
  assert.equal(pruned["n4-thinking-2"]!.text, "longer live text");
  console.log("ok: catch-up prune when RQ text ≥ live");
}

{
  const durable = durableStreamSnapshots([
    { msg_type: "thinking", content: { stream_id: "s1", text: "t1" } },
    { msg_type: "text", content: { stream_id: "s2", reasoning: "via reasoning" } },
    { msg_type: "tool_call", content: {} },
    { msg_type: "agent_pending", content: { stream_id: "", text: "思考中…" } },
  ]);
  assert.deepEqual(durable, [
    { streamId: "s1", text: "t1" },
    { streamId: "s2", text: "via reasoning" },
  ]);
  console.log("ok: durableStreamSnapshots extracts stream text");
}

// ---------------------------------------------------------------------------
// S4: display merge — filter agent_pending, overlay by stream_id
// ---------------------------------------------------------------------------
{
  const durable = [
    {
      id: "u1",
      msg_type: "text",
      role: "user",
      content: { text: "hi" },
    },
    {
      id: "pending-old",
      msg_type: "agent_pending",
      role: "agent",
      content: { text: "思考中…" },
    },
    {
      id: "uuid-think",
      msg_type: "thinking",
      role: "agent",
      content: { stream_id: "n4-thinking-1", text: "partial", reasoning: "partial" },
    },
  ];
  const live: Record<string, LiveStreamFrame> = {
    "n4-thinking-1": {
      streamId: "n4-thinking-1",
      msgType: "thinking",
      text: "partial more",
      messageId: "uuid-think",
      conversationId: "conv-a",
    },
    "n4-thinking-2": {
      streamId: "n4-thinking-2",
      msgType: "thinking",
      text: "new turn",
      conversationId: "conv-a",
    },
  };
  const merged = mergeMessagesWithLiveStreams(durable, live, {
    activeConversationId: "conv-a",
  });
  assert.ok(!merged.some((m) => m.msg_type === "agent_pending"), "agent_pending filtered");
  assert.equal(merged.length, 3, "user + thinking1 + thinking2");
  const keys = merged.map((m) => messageListKey(m));
  assert.deepEqual(keys, [
    "u1",
    "stream:n4-thinking-1",
    "stream:n4-thinking-2",
  ]);
  const t1 = merged.find((m) => readSid(m) === "n4-thinking-1")!;
  assert.equal(t1.content.text, "partial more");
  console.log("ok: display merge filters agent_pending and keys by stream_id");
}

// mergeProgressiveText
{
  assert.equal(mergeProgressiveText("好的", "好的，我"), "好的，我");
  assert.equal(mergeProgressiveText("好的，我来", "好的"), "好的，我来");
  assert.equal(mergeProgressiveText("", "hello"), "hello");
  assert.equal(mergeProgressiveText("keep", ""), "keep");
  console.log("ok: mergeProgressiveText prefers longer / prefix growth");
}

// liveFrameToMessageLike is stream-keyed
{
  const like = liveFrameToMessageLike({
    streamId: "n4-thinking-9",
    msgType: "thinking",
    text: "x",
  });
  assert.equal(messageListKey(like), "stream:n4-thinking-9");
  assert.ok(!like.id.startsWith("live-slot-"));
  console.log("ok: liveFrameToMessageLike uses stream identity");
}

function readSid(m: { content: Record<string, unknown> }): string {
  return typeof m.content.stream_id === "string" ? m.content.stream_id : "";
}

console.log("all messageStreamIdentity tests passed");
