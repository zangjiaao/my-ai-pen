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
import {
  mapPromptFailureToLlmTurnError,
  streamDiagnosisPayload,
  surfaceLlmTurnFailure,
} from "./llm-turn-surface.js";

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

// --- S2: idle abort tick → single-writer (abort callback only; no status/diagnosis) ---

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
  const beforeAbortMsgs = platform.messages.length;
  now += 3_000;
  const outcome = await applyStreamHealthTick(ctx, health, {
    onIdleAbort: () => {
      aborted = true;
    },
  });
  assert.equal(outcome, "abort");
  assert.equal(aborted, true);
  assert.equal(health.isIdleAbortRequested, true);
  assert.equal(health.state, "terminal");
  // Tick must NOT publish failed status — runners own surfaceLlmTurnFailure.
  const withDiag = platform.messages.filter(
    (m) => (m as Record<string, unknown>).stream_diagnosis != null,
  );
  assert.equal(withDiag.length, 0, "tick idle abort does not emit stream_diagnosis");
  assert.equal(
    platform.messages.length,
    beforeAbortMsgs,
    "tick idle abort does not emit extra status frames",
  );
}

// --- S2: surface helper is the single publisher ---

{
  let now = 50_000_000;
  const health = new LlmStreamHealth({
    stallThresholdMs: 2_000,
    abortThresholdMs: 5_000,
    now: () => now,
  });
  health.open(now);
  health.noteActivity("thinking", { atMs: now });
  now += 5_000;
  assert.equal(health.tick(now), "abort");
  const platform = fakePlatform();
  const err = await surfaceLlmTurnFailure({
    platform,
    conversationId: "c1",
    taskId: "t1",
    health,
    error: mapPromptFailureToLlmTurnError(new Error("session aborted"), health)!,
  });
  assert.match(err.userMessage, /模型调用失败|idle/i);
  assert.equal(err.diagnosis?.stream_terminal_class, "idle_timeout");
  const statuses = platform.messages.filter((m) => m.type === "status_update");
  assert.equal(statuses.length, 1, "exactly one failed status from surface helper");
  assert.ok((statuses[0] as Record<string, unknown>).stream_diagnosis);
}

// --- mapPromptFailure: structured only (no broad keyword wrap) ---

{
  assert.equal(
    mapPromptFailureToLlmTurnError(new Error("shell provider stream llm failed")),
    null,
    "unrelated throw with stream/llm words must not auto-wrap",
  );
  assert.ok(
    mapPromptFailureToLlmTurnError(new Error("Stream ended without finish_reason")),
  );
}

// --- format keeps provider detail ---

assert.match(
  formatLlmErrorForUser("Stream ended without finish_reason"),
  /Stream ended without finish_reason/,
);

// --- S1: overlapping tools — first end must not arm idle abort (#497) ---

{
  let now = 60_000_000;
  let aborted = false;
  const health = new LlmStreamHealth({
    stallThresholdMs: 2_000,
    abortThresholdMs: 5_000,
    now: () => now,
  });
  const platform = fakePlatform();
  const ctx = makeCtx(platform, health);
  const textStream = new PlatformTextStream(platform, ctx.task);
  const throttle = new CheckpointThrottle();
  const tick = () =>
    applyStreamHealthTick(ctx, health, {
      onIdleAbort: () => {
        aborted = true;
      },
    });

  await handleNode4SessionEvent(ctx, textStream, throttle, { type: "turn_start" });
  await handleNode4SessionEvent(ctx, textStream, throttle, {
    type: "tool_execution_start",
    toolName: "http",
    toolCallId: "http-1",
  });
  await handleNode4SessionEvent(ctx, textStream, throttle, {
    type: "tool_execution_start",
    toolName: "subagent",
    toolCallId: "sub-1",
  });
  await handleNode4SessionEvent(ctx, textStream, throttle, {
    type: "tool_execution_end",
    toolName: "http",
    toolCallId: "http-1",
  });
  assert.equal(health.state, "closed", "sibling still running — health stays closed");
  assert.equal(ctx.counters.phase, "tool_running");
  const waitingAfterFirstEnd = platform.messages.filter(
    (m) => m.type === "status_update" && (m as { agent_phase?: string }).agent_phase === "llm_waiting",
  );
  assert.equal(waitingAfterFirstEnd.length, 1, "only turn_start opened llm_waiting so far");

  now += 6_000;
  assert.equal(await tick(), "ok", "idle abort must not fire while a sibling tool runs");
  assert.equal(aborted, false);

  await handleNode4SessionEvent(ctx, textStream, throttle, {
    type: "tool_execution_end",
    toolName: "subagent",
    toolCallId: "sub-1",
  });
  assert.equal(health.state, "open", "last tool end re-enters model wait");
  assert.equal(ctx.counters.phase, "llm_waiting");
}

// Sequential single tool still opens health on end (unchanged #353).
{
  const health = new LlmStreamHealth({ abortThresholdMs: null });
  const platform = fakePlatform();
  const ctx = makeCtx(platform, health);
  const textStream = new PlatformTextStream(platform, ctx.task);
  const throttle = new CheckpointThrottle();
  await handleNode4SessionEvent(ctx, textStream, throttle, {
    type: "tool_execution_start",
    toolName: "http",
  });
  await handleNode4SessionEvent(ctx, textStream, throttle, {
    type: "tool_execution_end",
    toolName: "http",
  });
  assert.equal(health.state, "open");
  assert.equal(ctx.counters.phase, "llm_waiting");
}

console.log("llm-stream-liveness.obs.test.ts: ok");
