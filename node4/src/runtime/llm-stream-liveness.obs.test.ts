/**
 * Spec #353 S1–S3 — stream health via observability seams (stall emit + diagnosis).
 * Run: npx tsx src/runtime/llm-stream-liveness.obs.test.ts  (from node4/)
 */
import assert from "node:assert/strict";
import {
  applyStreamHealthTick,
  CheckpointThrottle,
  handleNode4SessionEvent,
  PlatformTextStream,
  streamDiagnosisPayload,
  type ObservabilityContext,
} from "./platform-observability.js";
import { LlmStreamHealth } from "./llm-stream-health.js";
import { PanelAgentTracker } from "./panel-agents.js";
import { LlmUsageLedger } from "./llm-usage.js";
import { GoalStore } from "../stores/goal.js";
import { TodoStore } from "../stores/todo.js";
import type { PlatformMessage, PlatformSink, TaskEnvelope, ToolRuntime } from "../types.js";
import {
  isIncompleteStreamError,
  llmTurnErrorWithDiagnosis,
  formatLlmErrorForUser,
} from "./llm-turn-error.js";

function fakePlatform(): PlatformSink & { messages: PlatformMessage[] } {
  const messages: PlatformMessage[] = [];
  return {
    messages,
    send: async (msg: PlatformMessage) => {
      messages.push(structuredClone(msg));
    },
  };
}

function makeCtx(
  platform: PlatformSink,
  health: LlmStreamHealth,
): ObservabilityContext {
  const panel = new PanelAgentTracker("test task", "Expert");
  return {
    platform,
    task: { taskId: "t1", conversationId: "c1" } as TaskEnvelope,
    runtime: { lifecycle: {}, todo: new TodoStore() } as ToolRuntime,
    goals: new GoalStore(),
    usage: new LlmUsageLedger(),
    panel,
    startedAt: new Date().toISOString(),
    rolePackId: "pentest",
    counters: { toolCallCount: 0, phase: "starting" },
    streamHealth: health,
  };
}

// --- S1: silence past threshold → stall status_update (Runtime SoT) ---

{
  let now = 10_000_000;
  const health = new LlmStreamHealth({
    stallThresholdMs: 5_000,
    abortThresholdMs: null,
    now: () => now,
  });
  const platform = fakePlatform();
  const ctx = makeCtx(platform, health);
  health.open(now);
  now += 5_000;
  const outcome = await applyStreamHealthTick(ctx, health);
  assert.equal(outcome, "stalled");
  assert.equal(ctx.counters.phase, "llm_stalled");
  const statuses = platform.messages.filter((m) => m.type === "status_update");
  assert.ok(statuses.length >= 1, "stall emits status_update");
  const last = statuses[statuses.length - 1]! as Record<string, unknown>;
  assert.equal(last.agent_phase, "llm_stalled");
  assert.equal(last.status, "running");
  assert.ok(last.stream_health, "stream_health snapshot present");
  assert.match(String(last.message || ""), /无进度|等待/);
  assert.equal(ctx.panel.list()[0]?.current_action, "llm_stalled");
}

// --- S1: activity clears stall; no false stall on healthy turn ---

{
  let now = 20_000_000;
  const health = new LlmStreamHealth({
    stallThresholdMs: 10_000,
    abortThresholdMs: null,
    now: () => now,
  });
  const platform = fakePlatform();
  const ctx = makeCtx(platform, health);
  const textStream = new PlatformTextStream(platform, ctx.task);
  const throttle = new CheckpointThrottle();

  await handleNode4SessionEvent(ctx, textStream, throttle, { type: "turn_start" });
  assert.equal(health.state, "open");
  assert.equal(ctx.counters.phase, "llm_waiting");

  now += 3_000;
  await handleNode4SessionEvent(ctx, textStream, throttle, {
    type: "message_update",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "plan" }] },
    assistantMessageEvent: {
      type: "thinking_delta",
      partial: { role: "assistant", content: [{ type: "thinking", thinking: "plan" }] },
    },
  });
  assert.equal(health.snapshot().chunk_count, 1);
  assert.equal(health.snapshot().kind_counts.thinking, 1);
  assert.equal(await applyStreamHealthTick(ctx, health), "ok");

  // Force stall then resume via chunk
  now += 10_000;
  assert.equal(await applyStreamHealthTick(ctx, health), "stalled");
  now += 100;
  await handleNode4SessionEvent(ctx, textStream, throttle, {
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    assistantMessageEvent: { type: "text_delta", partial: { role: "assistant", content: [] } },
  });
  assert.equal(health.state, "open");
  assert.equal(ctx.counters.phase, "llm_waiting");
}

// --- S2: incomplete end → diagnosis package on LlmTurnError ---

{
  let now = 30_000_000;
  const health = new LlmStreamHealth({
    stallThresholdMs: 60_000,
    abortThresholdMs: null,
    now: () => now,
  });
  health.open(now);
  health.noteActivity("thinking", { atMs: now });
  now += 2_000;
  assert.equal(isIncompleteStreamError(new Error("Stream ended without finish_reason")), true);
  const err = llmTurnErrorWithDiagnosis("Stream ended without finish_reason", health, {
    finishReasonPresent: false,
  });
  assert.match(err.userMessage, /模型调用失败/);
  assert.match(err.userMessage, /finish_reason/);
  assert.ok(err.diagnosis);
  assert.equal(err.diagnosis!.stream_terminal_class, "incomplete_finish");
  assert.equal(err.diagnosis!.finish_reason_present, false);
  assert.equal(err.diagnosis!.chunk_count, 1);
  assert.equal(err.diagnosis!.tool_name_seen, false);
  const payload = streamDiagnosisPayload(err.diagnosis);
  assert.ok(payload);
  assert.equal(payload!.stream_terminal_class, "incomplete_finish");
}

// --- S2: idle abort tick → abort outcome + diagnosis ---

{
  let now = 40_000_000;
  let aborted = false;
  const health = new LlmStreamHealth({
    stallThresholdMs: 2_000,
    abortThresholdMs: 5_000,
    now: () => now,
  });
  const platform = fakePlatform();
  const ctx = makeCtx(platform, health);
  health.open(now);
  health.noteActivity("text", { atMs: now });
  now += 2_000;
  assert.equal(await applyStreamHealthTick(ctx, health), "stalled");
  now += 3_000;
  const outcome = await applyStreamHealthTick(ctx, health, {
    onIdleAbort: () => {
      aborted = true;
    },
  });
  assert.equal(outcome, "abort");
  assert.equal(aborted, true);
  assert.equal(health.isIdleAbortRequested, true);
  const withDiag = platform.messages.filter(
    (m) => (m as Record<string, unknown>).stream_diagnosis != null,
  );
  assert.ok(withDiag.length >= 1, "idle abort emits stream_diagnosis");
  const d = (withDiag[withDiag.length - 1] as Record<string, unknown>).stream_diagnosis as {
    stream_terminal_class?: string;
  };
  assert.equal(d.stream_terminal_class, "idle_timeout");
}

// --- format keeps provider detail ---

assert.match(
  formatLlmErrorForUser("Stream ended without finish_reason"),
  /Stream ended without finish_reason/,
);

console.log("llm-stream-liveness.obs.test.ts: ok");
