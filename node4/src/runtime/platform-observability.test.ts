/**
 * Spec #305 S1 — thinking status protocol on ProgressiveContentStream / PlatformTextStream.
 * Run: npx tsx src/runtime/platform-observability.test.ts  (from node4/)
 */
import assert from "node:assert/strict";
import { PlatformTextStream } from "./platform-observability.js";
import type { PlatformMessage, PlatformSink, TaskEnvelope } from "../types.js";

function fakePlatform(): PlatformSink & { messages: PlatformMessage[] } {
  const messages: PlatformMessage[] = [];
  return {
    messages,
    send: async (msg: PlatformMessage) => {
      messages.push(structuredClone(msg));
    },
  };
}

function task(): TaskEnvelope {
  return {
    taskId: "task-1",
    conversationId: "conv-1",
  } as TaskEnvelope;
}

function thinkingContent(msg: PlatformMessage): Record<string, unknown> {
  const c = msg.content;
  return c && typeof c === "object" && !Array.isArray(c) ? (c as Record<string, unknown>) : {};
}

async function drain(stream: PlatformTextStream): Promise<void> {
  // Progressive maybeFlush does not await the send chain; settle microtasks.
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
  void stream;
}

async function testNoT1OnBareMessageStart() {
  // Issue 10: message_start alone must not spam empty thinking.
  const platform = fakePlatform();
  const stream = new PlatformTextStream(platform, task());
  await stream.handle({
    type: "message_start",
    message: { role: "assistant", content: [] },
  });
  await drain(stream);

  const thinking = platform.messages.filter((m) => m.type === "thinking");
  assert.equal(thinking.length, 0, "no empty T1 on bare message_start");
  console.log("ok: Issue 10 no T1 on bare message_start");
}

async function testEmptyRunningOnThinkingChannelOpen() {
  // Empty T1 shells retired: thinking_start with empty body must not invent a Message.
  // Mid-turn wait is list-tail Working chrome on the frontend.
  const platform = fakePlatform();
  const stream = new PlatformTextStream(platform, task());
  await stream.handle({
    type: "message_start",
    message: { role: "assistant", content: [] },
  });
  await stream.handle({
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "" }],
    },
    assistantMessageEvent: {
      type: "thinking_start",
      partial: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "" }],
      },
    },
  });
  await drain(stream);

  const thinking = platform.messages.filter((m) => m.type === "thinking");
  assert.equal(thinking.length, 0, "no empty T1 Message on empty thinking_start");
  console.log("ok: no empty thinking shell on thinking_start without body");
}

async function testProgressiveRunningAndFinalDone() {
  const platform = fakePlatform();
  const stream = new PlatformTextStream(platform, task());
  await stream.handle({
    type: "message_start",
    message: { role: "assistant", content: [] },
  });
  await stream.handle({
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "plan a" }],
    },
    assistantMessageEvent: {
      type: "thinking_delta",
      partial: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "plan a" }],
      },
    },
  });
  await drain(stream);
  await stream.handle({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "plan a full" }],
    },
  });
  await drain(stream);

  const thinking = platform.messages.filter((m) => m.type === "thinking");
  assert.ok(thinking.some((m) => thinkingContent(m).status === "running"), "running frames");
  const last = thinking[thinking.length - 1]!;
  const lastContent = thinkingContent(last);
  assert.equal(lastContent.status, "done", "finalFlush stamps done");
  assert.equal(String(lastContent.text || lastContent.reasoning), "plan a full");
  const streamIds = new Set(
    thinking.map((m) => String(thinkingContent(m).stream_id || m.stream_id || "")),
  );
  assert.equal(streamIds.size, 1, "one stream_id for the turn");
  console.log("ok: S1 progressive running + final done with full body");
}

async function testEmptyRunningThenEmptyDone() {
  // Empty thinking open + empty message_end must not invent thinking Messages
  // (empty T1 shells retired; FE Working covers wait).
  const platform = fakePlatform();
  const stream = new PlatformTextStream(platform, task());
  await stream.handle({
    type: "message_update",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "" }] },
    assistantMessageEvent: {
      type: "thinking_start",
      partial: { role: "assistant", content: [{ type: "thinking", thinking: "" }] },
    },
  });
  await drain(stream);
  await stream.handle({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "" }] },
  });
  await drain(stream);

  const thinking = platform.messages.filter((m) => m.type === "thinking");
  assert.equal(thinking.length, 0, "empty thinking turn invents no thinking frames");
  console.log("ok: empty thinking open/end invents no Message");
}

async function testNoDoneWhenThinkingNeverOpened() {
  const platform = fakePlatform();
  const stream = new PlatformTextStream(platform, task());
  // Text-only path: no thinking_* open — only text final.
  await stream.emitFinalText("hello");
  await drain(stream);
  const thinking = platform.messages.filter((m) => m.type === "thinking");
  assert.equal(thinking.length, 0, "text-only emit must not invent thinking");
  const text = platform.messages.filter((m) => m.type === "text");
  assert.ok(text.length >= 1);

  // Full text-only assistant turn via message_start/end still no thinking spam.
  const platform2 = fakePlatform();
  const stream2 = new PlatformTextStream(platform2, task());
  await stream2.handle({
    type: "message_start",
    message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
  });
  await stream2.handle({
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: "hi there" }] },
    assistantMessageEvent: {
      type: "text_delta",
      partial: { role: "assistant", content: [{ type: "text", text: "hi there" }] },
    },
  });
  await drain(stream2);
  await stream2.handle({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "hi there" }] },
  });
  await drain(stream2);
  assert.equal(
    platform2.messages.filter((m) => m.type === "thinking").length,
    0,
    "text-only turn must not emit thinking frames",
  );
  console.log("ok: S1 no thinking frames on text-only turns");
}


async function testToolEndOpensEmptyRunningBeforeThinkingTokens() {
  // Spec residual: tool → llm_waiting must not leave chat silent until thinking_*.
  const platform = fakePlatform();
  const stream = new PlatformTextStream(platform, task());

  // Prior assistant text-only turn (no thinking) then tools run externally.
  await stream.handle({
    type: "message_start",
    message: { role: "assistant", content: [{ type: "text", text: "calling tool" }] },
  });
  await stream.handle({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "calling tool" }] },
  });
  await drain(stream);
  assert.equal(
    platform.messages.filter((m) => m.type === "thinking").length,
    0,
    "text-only prior turn has no thinking",
  );

  // tool_execution_end → no empty thinking shell (Working chrome covers llm_waiting)
  await stream.handle({
    type: "tool_execution_end",
    toolName: "shell",
    toolCallId: "tc-1",
  });
  await drain(stream);

  const afterTool = platform.messages.filter((m) => m.type === "thinking");
  assert.equal(afterTool.length, 0, "no empty thinking after tool end");

  // Later thinking tokens open a real thinking stream with body
  await stream.handle({
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "after tool analysis" }],
    },
    assistantMessageEvent: {
      type: "thinking_delta",
      partial: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "after tool analysis" }],
      },
    },
  });
  await drain(stream);
  await stream.handle({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "after tool analysis done" }],
    },
  });
  await drain(stream);

  const thinking = platform.messages.filter((m) => m.type === "thinking");
  assert.ok(thinking.some((m) => thinkingContent(m).status === "running"));
  const last = thinking[thinking.length - 1]!;
  assert.equal(thinkingContent(last).status, "done");
  assert.equal(String(thinkingContent(last).text || ""), "after tool analysis done");
  console.log("ok: no empty T1 after tool; real thinking when tokens arrive");
}

async function testTurnStartDoesNotOpenT1WithoutTools() {
  // Issue 10 preserved: bare turn_start must not spam empty thinking.
  const platform = fakePlatform();
  const stream = new PlatformTextStream(platform, task());
  await stream.handle({ type: "turn_start" });
  await drain(stream);
  assert.equal(
    platform.messages.filter((m) => m.type === "thinking").length,
    0,
    "turn_start alone must not open thinking T1",
  );
  console.log("ok: turn_start alone does not open T1");
}

async function testThinkingDoneBeforeTextStream() {
  // Done must stamp when text_* starts — not only on message_end after text finishes.
  const platform = fakePlatform();
  const stream = new PlatformTextStream(platform, task());
  await stream.handle({
    type: "message_start",
    message: { role: "assistant", content: [] },
  });
  await stream.handle({
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "reason then reply" }],
    },
    assistantMessageEvent: {
      type: "thinking_delta",
      partial: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "reason then reply" }],
      },
    },
  });
  await drain(stream);
  await stream.handle({
    type: "message_update",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reason then reply" },
        { type: "text", text: "你好" },
      ],
    },
    assistantMessageEvent: {
      type: "text_delta",
      partial: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reason then reply" },
          { type: "text", text: "你好" },
        ],
      },
    },
  });
  await drain(stream);

  const thinking = platform.messages.filter((m) => m.type === "thinking");
  assert.ok(thinking.some((m) => thinkingContent(m).status === "running"), "had running");
  const lastBeforeEnd = thinking[thinking.length - 1]!;
  assert.equal(
    thinkingContent(lastBeforeEnd).status,
    "done",
    "text_* must stamp thinking done before message_end",
  );
  assert.equal(String(thinkingContent(lastBeforeEnd).text || ""), "reason then reply");

  await stream.handle({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reason then reply" },
        { type: "text", text: "你好世界" },
      ],
    },
  });
  await drain(stream);
  const doneCount = platform.messages.filter(
    (m) => m.type === "thinking" && thinkingContent(m).status === "done",
  ).length;
  assert.ok(doneCount >= 1, "at least one done frame");
  console.log("ok: thinking done stamps on text_* before message_end");
}

async function testMultiToolBatchOpensSingleT1() {
  // Empty T1 retired: multi-tool batch must never invent empty thinking shells.
  const platform = fakePlatform();
  const stream = new PlatformTextStream(platform, task());

  await stream.handle({ type: "tool_execution_start", toolName: "browser", toolCallId: "t1" });
  await stream.handle({ type: "tool_execution_start", toolName: "browser", toolCallId: "t2" });
  await stream.handle({ type: "tool_execution_end", toolName: "browser", toolCallId: "t1" });
  await drain(stream);
  assert.equal(
    platform.messages.filter((m) => m.type === "thinking").length,
    0,
    "no thinking while tools still in-flight",
  );

  await stream.handle({ type: "tool_execution_end", toolName: "browser", toolCallId: "t2" });
  await drain(stream);
  assert.equal(
    platform.messages.filter((m) => m.type === "thinking").length,
    0,
    "no empty T1 after last tool ends",
  );

  await stream.handle({ type: "tool_execution_start", toolName: "browser", toolCallId: "t3" });
  await drain(stream);
  assert.equal(
    platform.messages.filter((m) => m.type === "thinking").length,
    0,
    "tool start invents no thinking when none was open",
  );
  console.log("ok: multi-tool batch invents no empty thinking shells");
}

async function main() {
  await testNoT1OnBareMessageStart();
  await testEmptyRunningOnThinkingChannelOpen();
  await testProgressiveRunningAndFinalDone();
  await testEmptyRunningThenEmptyDone();
  await testNoDoneWhenThinkingNeverOpened();
  await testToolEndOpensEmptyRunningBeforeThinkingTokens();
  await testTurnStartDoesNotOpenT1WithoutTools();
  await testThinkingDoneBeforeTextStream();
  await testMultiToolBatchOpensSingleT1();
  console.log("all platform-observability Spec #305 tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
