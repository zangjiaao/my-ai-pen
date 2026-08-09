/**
 * Pure stream-identity + pending chrome + prune (Spec #276 / #305) — no vitest; run with:
 *   npx tsx src/lib/messageStreamIdentity.test.ts
 * (from platform/frontend)
 */
import assert from "node:assert/strict";
import {
  applyProgressiveActivity,
  buildPendingSendSuccessEvent,
  clearLiveStreams,
  durableStreamSnapshots,
  hasProgressiveLive,
  isProgressiveActivityFrame,
  liveFrameToMessageLike,
  mergeMessagesWithLiveStreams,
  mergeProgressiveText,
  messageListKey,
  pendingChromeSpeakerContent,
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

// Spec #305 S2: empty running thinking upserts; empty without status rejected
{
  let live: Record<string, LiveStreamFrame> = {};
  const rejected = upsertLiveByStreamId(live, {
    streamId: "n4-thinking-empty-1",
    msgType: "thinking",
    text: "",
  });
  assert.equal(Object.keys(rejected).length, 0, "empty without status rejected");

  live = upsertLiveByStreamId(live, {
    streamId: "n4-thinking-empty-1",
    msgType: "thinking",
    text: "",
    content: { status: "running" },
  });
  assert.ok(live["n4-thinking-empty-1"], "empty running thinking enters live map");
  assert.equal(live["n4-thinking-empty-1"]!.text, "");
  assert.equal(live["n4-thinking-empty-1"]!.content?.status, "running");

  live = upsertLiveByStreamId(live, {
    streamId: "n4-thinking-empty-1",
    msgType: "thinking",
    text: "first tokens",
    content: { status: "running" },
  });
  assert.equal(live["n4-thinking-empty-1"]!.text, "first tokens");

  live = upsertLiveByStreamId(live, {
    streamId: "n4-thinking-empty-1",
    msgType: "thinking",
    text: "first tokens full",
    content: { status: "done" },
  });
  assert.equal(live["n4-thinking-empty-1"]!.content?.status, "done");
  console.log("ok: S2 empty running thinking upsert + body growth");
}

// Spec #305 nit: empty thinking accepts done synonyms via normalizeExecutionStatus
{
  let live = upsertLiveByStreamId(
    {},
    {
      streamId: "n4-thinking-synonym",
      msgType: "thinking",
      text: "",
      content: { status: "completed" },
    },
  );
  assert.ok(live["n4-thinking-synonym"], "empty + completed synonym enters live");
  assert.equal(live["n4-thinking-synonym"]!.content?.status, "done");

  live = upsertLiveByStreamId(
    {},
    {
      streamId: "n4-thinking-fail-empty",
      msgType: "thinking",
      text: "",
      content: { status: "error" },
    },
  );
  assert.equal(
    Object.keys(live).length,
    0,
    "empty fail-status thinking still rejected",
  );
  console.log("ok: empty thinking status synonyms via normalize");
}

// Issue 1: empty running → empty done flips status on live map
{
  let live = upsertLiveByStreamId({}, {
    streamId: "n4-thinking-empty-done",
    msgType: "thinking",
    text: "",
    content: { status: "running" },
  });
  live = upsertLiveByStreamId(live, {
    streamId: "n4-thinking-empty-done",
    msgType: "thinking",
    text: "",
    content: { status: "done" },
  });
  assert.equal(live["n4-thinking-empty-done"]!.content?.status, "done");
  assert.equal(live["n4-thinking-empty-done"]!.text, "");
  console.log("ok: Issue 1 empty running → empty done flips status");
}

// Issue 2: live upsert prefer-done (late running does not demote)
{
  let live = upsertLiveByStreamId({}, {
    streamId: "n4-thinking-prefer-done",
    msgType: "thinking",
    text: "full",
    content: { status: "done" },
  });
  live = upsertLiveByStreamId(live, {
    streamId: "n4-thinking-prefer-done",
    msgType: "thinking",
    text: "full",
    content: { status: "running" },
  });
  assert.equal(live["n4-thinking-prefer-done"]!.content?.status, "done");
  console.log("ok: Issue 2 live upsert prefer-done over late running");
}

{
  assert.equal(
    isProgressiveActivityFrame({
      streamId: "n4-thinking-1",
      msgType: "thinking",
      text: "",
      status: "running",
    }),
    true,
  );
  assert.equal(
    isProgressiveActivityFrame({
      streamId: "n4-thinking-1",
      msgType: "thinking",
      text: "",
      status: "done",
    }),
    true,
    "empty done is progressive activity",
  );
  assert.equal(
    isProgressiveActivityFrame({
      streamId: "",
      msgType: "thinking",
      text: "x",
      status: "running",
    }),
    false,
    "fail-closed without stream_id",
  );
  assert.equal(
    isProgressiveActivityFrame({
      streamId: "n4-text-1",
      msgType: "text",
      text: "hi",
    }),
    true,
  );
  console.log("ok: S2 isProgressiveActivityFrame gates");
}

// Product A: composition send → empty running → Working stays; tools do not reseed if cleared
{
  let pending = reducePendingChrome(
    null,
    buildPendingSendSuccessEvent({
      conversationId: "conv-compose",
      expert_name: "渗透大师",
      agent_source: "pentest",
    }),
  );
  assert.equal(pendingChromeVisible(pending, "conv-compose"), true);
  assert.equal(pending!.expert_name, "渗透大师");
  assert.equal(pending!.label, "工作中...");

  const step = applyProgressiveActivity(
    { live: {}, pending },
    {
      streamId: "n4-thinking-compose-1",
      msgType: "thinking",
      text: "",
      status: "running",
      conversationId: "conv-compose",
      content: { status: "running" },
    },
  );
  assert.equal(step.accepted, true);
  assert.ok(step.pending, "Working stays through empty running thinking");
  assert.equal(step.pending!.label, "工作中...");
  assert.ok(step.live["n4-thinking-compose-1"]);
  assert.equal(step.live["n4-thinking-compose-1"]!.content?.status, "running");

  // tools never clear Working mid-turn
  const afterTool = reducePendingChrome(step.pending, { type: "tool_output" });
  assert.ok(afterTool);
  assert.equal(afterTool!.label, "工作中...");
  console.log("ok: Working stays through progressive thinking + tools");
}

// Issue 7: pending content shape for speaker
{
  const pending = reducePendingChrome(
    null,
    buildPendingSendSuccessEvent({
      conversationId: "c-speaker",
      expert_id: "e1",
      expert_name: "渗透大师",
      expert_display_name: "渗透大师",
      agent_source: "pentest",
    }),
  );
  const shape = pendingChromeSpeakerContent(pending!);
  assert.equal(shape.expert_name, "渗透大师");
  assert.equal(shape.expert_display_name, "渗透大师");
  assert.equal(shape.agent_source, "pentest");
  assert.equal(shape.text, "工作中...");
  console.log("ok: Issue 7 pending speaker content shape");
}

// ---------------------------------------------------------------------------
// S2: Working chrome lifecycle (product A — whole turn)
// ---------------------------------------------------------------------------
{
  let pending: PendingChrome = null;
  // tool alone must never show Working
  pending = reducePendingChrome(pending, { type: "tool_output" });
  assert.equal(pending, null);
  assert.equal(pendingChromeVisible(pending, "conv-1"), false);

  // show after send intent
  pending = reducePendingChrome(pending, {
    type: "send_success",
    conversationId: "conv-1",
  });
  assert.deepEqual(pending, { conversationId: "conv-1", label: "工作中..." });
  assert.equal(pendingChromeVisible(pending, "conv-1"), true);
  assert.equal(pendingChromeVisible(pending, "conv-other"), false);

  // tool_output while Working does not clear or reseed
  pending = reducePendingChrome(pending, { type: "tool_output" });
  assert.deepEqual(pending, { conversationId: "conv-1", label: "工作中..." });

  // progressive stream_started keeps Working (coexists with thinking/tool cards)
  pending = reducePendingChrome(pending, { type: "stream_started" });
  assert.deepEqual(pending, { conversationId: "conv-1", label: "工作中..." });

  // tools still never invent Working if already cleared
  pending = reducePendingChrome(null, { type: "tool_output" });
  assert.equal(pending, null);
  console.log("ok: Working show after send, stay on stream/tools, not invented by tool alone");
}

// Spec #305 S4: Working chrome may carry speaker attribution
{
  const pending = reducePendingChrome(null, {
    type: "send_success",
    conversationId: "conv-exp",
    expert_name: "渗透大师",
    expert_id: "exp-1",
    agent_source: "pentest",
  });
  assert.equal(pending!.conversationId, "conv-exp");
  assert.equal(pending!.expert_name, "渗透大师");
  assert.equal(pending!.expert_id, "exp-1");
  assert.equal(pending!.agent_source, "pentest");
  assert.equal(pending!.label, "工作中...");
  console.log("ok: S4 Working chrome carries speaker attribution");
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

// Issue 11: empty live running not pruned when durable empty without done
{
  const live: Record<string, LiveStreamFrame> = {
    "n4-thinking-run": {
      streamId: "n4-thinking-run",
      msgType: "thinking",
      text: "",
      content: { status: "running" },
    },
  };
  const kept = pruneLiveCatchUp(live, [
    { streamId: "n4-thinking-run", text: "", status: "running" },
  ]);
  assert.ok(kept["n4-thinking-run"], "keep empty running until durable done");

  const dropped = pruneLiveCatchUp(live, [
    { streamId: "n4-thinking-run", text: "", status: "done" },
  ]);
  assert.equal(dropped["n4-thinking-run"], undefined, "prune when durable done");

  // R2: durable completed synonym counts as done via normalizeExecutionStatus
  const droppedCompleted = pruneLiveCatchUp(live, [
    { streamId: "n4-thinking-run", text: "", status: "completed" },
  ]);
  assert.equal(droppedCompleted["n4-thinking-run"], undefined, "prune when durable completed");
  console.log("ok: Issue 11 prune empty running thinking only after durable done");
}

{
  const durable = durableStreamSnapshots([
    { msg_type: "thinking", content: { stream_id: "s1", text: "t1" } },
    { msg_type: "text", content: { stream_id: "s2", reasoning: "via reasoning" } },
    { msg_type: "tool_call", content: {} },
    { msg_type: "agent_pending", content: { stream_id: "", text: "思考中…" } },
  ]);
  assert.deepEqual(durable, [
    { streamId: "s1", text: "t1", msgType: "thinking" },
    { streamId: "s2", text: "via reasoning", msgType: "text" },
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

// Issue 12: display merge prefer-done for thinking status
{
  const durable = [
    {
      id: "uuid-think-done",
      msg_type: "thinking",
      role: "agent",
      content: {
        stream_id: "n4-thinking-done",
        text: "full",
        reasoning: "full",
        status: "done",
      },
    },
  ];
  const live: Record<string, LiveStreamFrame> = {
    "n4-thinking-done": {
      streamId: "n4-thinking-done",
      msgType: "thinking",
      text: "full",
      content: { status: "running" },
    },
  };
  const merged = mergeMessagesWithLiveStreams(durable, live);
  assert.equal(merged[0]!.content.status, "done", "durable done wins over live running");
  console.log("ok: Issue 12 display merge prefer-done");
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
