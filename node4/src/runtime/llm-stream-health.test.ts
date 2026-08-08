/**
 * Spec #353 S1/S2 — LLM stream health pure transitions + diagnosis package.
 * Run: npx tsx src/runtime/llm-stream-health.test.ts  (from node4/)
 */
import assert from "node:assert/strict";
import {
  LlmStreamHealth,
  classifyStreamProviderMessage,
  coarseKindFromAssistantEventType,
  isIncompleteStreamMessage,
  loadStreamHealthConfigFromEnv,
  streamIdleTimeoutMessage,
  streamStallDetail,
} from "./llm-stream-health.js";

// --- S1: open → activity → stall → resume ---

{
  let now = 1_000_000;
  const h = new LlmStreamHealth({
    stallThresholdMs: 5_000,
    abortThresholdMs: 20_000,
    now: () => now,
  });
  assert.equal(h.state, "closed");
  assert.equal(h.tick(), "ok", "closed tick is no-op");

  h.open(now);
  assert.equal(h.state, "open");
  assert.equal(h.tick(now + 4_999), "ok", "before stall threshold");
  assert.equal(h.state, "open");

  assert.equal(h.tick(now + 5_000), "stalled");
  assert.equal(h.state, "stalled");
  // Second tick while stalled (under abort) stays stalled, no re-fire.
  assert.equal(h.tick(now + 6_000), "ok");
  assert.equal(h.state, "stalled");

  h.noteActivity("thinking", { atMs: now + 7_000 });
  assert.equal(h.state, "open", "activity clears stall");
  assert.equal(h.snapshot(now + 7_000).chunk_count, 1);
  assert.equal(h.snapshot().kind_counts.thinking, 1);
}

// --- S1: healthy multi-chunk turn never stalls ---

{
  let now = 2_000_000;
  const h = new LlmStreamHealth({
    stallThresholdMs: 10_000,
    abortThresholdMs: null,
    now: () => now,
  });
  h.open(now);
  for (let i = 0; i < 5; i++) {
    now += 3_000;
    h.noteActivity(i % 2 === 0 ? "text" : "thinking", { atMs: now });
    assert.equal(h.tick(now), "ok", `chunk ${i} no stall`);
  }
  assert.equal(h.state, "open");
  assert.equal(h.snapshot().chunk_count, 5);
}

// --- S1: tool name seen via toolcall activity ---

{
  const h = new LlmStreamHealth({ stallThresholdMs: 60_000, abortThresholdMs: null });
  h.open();
  h.noteActivity("toolcall", { toolName: "shell" });
  const snap = h.snapshot();
  assert.equal(snap.tool_name_seen, true);
  assert.equal(snap.tool_name, "shell");
  assert.equal(snap.kind_counts.toolcall, 1);
}

// --- S1/S2: idle abort after longer threshold ---

{
  let now = 3_000_000;
  const h = new LlmStreamHealth({
    stallThresholdMs: 2_000,
    abortThresholdMs: 8_000,
    now: () => now,
  });
  h.open(now);
  h.noteActivity("thinking", { atMs: now });
  now += 2_000;
  assert.equal(h.tick(now), "stalled");
  now += 6_000; // total idle 8s from last activity
  assert.equal(h.tick(now), "abort");
  assert.equal(h.state, "terminal");
  assert.equal(h.isIdleAbortRequested, true);
  const d = h.diagnosis();
  assert.equal(d.stream_terminal_class, "idle_timeout");
  assert.ok(d.idle_ms >= 8_000);
  assert.equal(d.finish_reason_present, false);
  assert.match(d.provider_message, /idle/i);
  // Further ticks after terminal are no-ops
  assert.equal(h.tick(now + 1000), "ok");
  assert.equal(h.state, "terminal");
}

// --- S2: incomplete stream diagnosis package ---

{
  let now = 4_000_000;
  const h = new LlmStreamHealth({
    stallThresholdMs: 60_000,
    abortThresholdMs: null,
    now: () => now,
  });
  h.open(now);
  h.noteActivity("thinking", { atMs: now });
  now += 1_000;
  h.noteActivity("text", { atMs: now });
  now += 500;
  const d = h.terminalFailure({
    providerMessage: "Stream ended without finish_reason",
    finishReasonPresent: false,
    atMs: now,
  });
  assert.equal(h.state, "terminal");
  assert.equal(d.stream_terminal_class, "incomplete_finish");
  assert.equal(d.finish_reason_present, false);
  assert.equal(d.chunk_count, 2);
  assert.equal(d.kind_counts.thinking, 1);
  assert.equal(d.kind_counts.text, 1);
  assert.equal(d.tool_name_seen, false);
  assert.ok(d.last_activity_at);
  assert.match(d.provider_message, /finish_reason/);
}

// --- S2: success terminal ---

{
  const h = new LlmStreamHealth({ stallThresholdMs: 60_000, abortThresholdMs: null });
  h.open();
  h.noteActivity("text");
  const d = h.terminalSuccess({ finishReason: "end_turn" });
  assert.equal(h.state, "terminal");
  assert.equal(d.stream_terminal_class, "success");
  assert.equal(d.finish_reason_present, true);
}

// finish_reason_present false when no reason observed
{
  const h = new LlmStreamHealth({ stallThresholdMs: 60_000, abortThresholdMs: null });
  h.open();
  const d = h.terminalSuccess();
  assert.equal(d.finish_reason_present, false, "no finishReason arg → not claimed present");
}

// --- S2: classify helpers ---

assert.equal(
  classifyStreamProviderMessage("Stream ended without finish_reason"),
  "incomplete_finish",
);
assert.equal(isIncompleteStreamMessage("Stream ended without finish_reason"), true);
assert.equal(isIncompleteStreamMessage("403 China opt-in"), false);
assert.equal(classifyStreamProviderMessage("stream idle timeout"), "idle_timeout");
// Negatives: bare timeout / operation timeout must not become stream forensics theater
assert.equal(classifyStreamProviderMessage("operation timeout"), "other");
assert.equal(classifyStreamProviderMessage("timeout"), "other");
assert.equal(classifyStreamProviderMessage("shell aborted by user"), "other");
assert.equal(classifyStreamProviderMessage("operation aborted"), "aborted");
assert.equal(coarseKindFromAssistantEventType("thinking_delta"), "thinking");
assert.equal(coarseKindFromAssistantEventType("text_start"), "text");
assert.equal(coarseKindFromAssistantEventType("toolcall_start"), "toolcall");
assert.equal(coarseKindFromAssistantEventType("unknown"), "empty_or_other");

// --- Config from env ---

{
  const cfg = loadStreamHealthConfigFromEnv({
    NODE4_LLM_STALL_MS: "12000",
    NODE4_LLM_IDLE_ABORT_MS: "30000",
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.stallThresholdMs, 12_000);
  assert.equal(cfg.abortThresholdMs, 30_000);
}

{
  const cfg = loadStreamHealthConfigFromEnv({
    NODE4_LLM_STALL_MS: "5000",
    NODE4_LLM_IDLE_ABORT_MS: "0",
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.stallThresholdMs, 5_000);
  assert.equal(cfg.abortThresholdMs, null, "0 disables abort");
}

// --- Runtime-authored copy (not free-text NLP catalogs) ---

assert.ok(streamStallDetail().length > 0);
assert.ok(streamIdleTimeoutMessage().length > 0);

// --- close stops stall/abort ---

{
  let now = 5_000_000;
  const h = new LlmStreamHealth({
    stallThresholdMs: 1_000,
    abortThresholdMs: 2_000,
    now: () => now,
  });
  h.open(now);
  h.close();
  now += 10_000;
  assert.equal(h.tick(now), "ok");
  assert.equal(h.state, "closed");
}

console.log("llm-stream-health.test.ts: ok");
