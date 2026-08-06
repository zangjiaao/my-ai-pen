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

async function testEmptyRunningOnMessageStart() {
  const platform = fakePlatform();
  const stream = new PlatformTextStream(platform, task());
  await stream.handle({
    type: "message_start",
    message: { role: "assistant", content: [] },
  });
  await drain(stream);

  const thinking = platform.messages.filter((m) => m.type === "thinking");
  assert.ok(thinking.length >= 1, "T1 empty running thinking frame required");
  const first = thinking[0]!;
  const content = thinkingContent(first);
  assert.equal(content.status, "running");
  assert.equal(String(content.text || ""), "");
  assert.equal(String(content.reasoning || ""), "");
  assert.ok(String(content.stream_id || first.stream_id || "").startsWith("n4-thinking-"));
  console.log("ok: S1 empty running thinking on message_start");
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

async function testNoDoneWhenThinkingNeverOpened() {
  const platform = fakePlatform();
  const stream = new PlatformTextStream(platform, task());
  // Text-only path: no message_start thinking open — only text final.
  await stream.emitFinalText("hello");
  await drain(stream);
  const thinking = platform.messages.filter((m) => m.type === "thinking");
  assert.equal(thinking.length, 0, "text-only emit must not invent thinking");
  const text = platform.messages.filter((m) => m.type === "text");
  assert.ok(text.length >= 1);
  console.log("ok: S1 no thinking frames on text-only emit");
}

async function main() {
  await testEmptyRunningOnMessageStart();
  await testProgressiveRunningAndFinalDone();
  await testNoDoneWhenThinkingNeverOpened();
  console.log("all platform-observability Spec #305 tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
