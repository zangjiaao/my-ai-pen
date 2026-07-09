/**
 * Smoke test for TaskDiagnostics: proves agent/platform events land on disk
 * with inspectable phase transitions.
 */
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { TaskDiagnostics } from "./runtime/agent-observability.js";
import type { PlatformMessage, PlatformSink } from "./types.js";

class MemorySink implements PlatformSink {
  readonly events: PlatformMessage[] = [];
  async send(message: PlatformMessage): Promise<void> {
    this.events.push(message);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const workspaceDir = resolve("tmp", "node2-observability-smoke");
const taskId = `obs-${randomUUID()}`;
const taskDir = resolve(workspaceDir, taskId);
await mkdir(taskDir, { recursive: true });

const sink = new MemorySink();
const task = {
  taskId,
  conversationId: `conv-${taskId}`,
  instruction: "observability smoke",
  target: { type: "url", value: "http://127.0.0.1:9" },
  scope: { allow: ["http://127.0.0.1:9"] },
  snapshot: {},
};

const diagnostics = await TaskDiagnostics.create(taskDir, task);
const platform = diagnostics.wrapPlatform(sink);

await platform.send({
  type: "status_update",
  conversation_id: task.conversationId,
  task_id: task.taskId,
  status: "running",
  agent_phase: "starting",
});

await diagnostics.handleAgentEvent({ type: "agent_start" });
await diagnostics.handleAgentEvent({ type: "turn_start" });
await diagnostics.handleAgentEvent({
  type: "message_end",
  message: {
    role: "assistant",
    stopReason: "toolUse",
    content: [
      { type: "text", text: "Next I will probe the target." },
      { type: "toolCall", name: "http", id: "call-1" },
    ],
  },
});
await diagnostics.handleAgentEvent({
  type: "tool_execution_start",
  toolCallId: "call-1",
  toolName: "http",
  args: { method: "GET", url: "http://127.0.0.1:9/" },
});
assert(diagnostics.snapshot().phase === "tool_running", `expected tool_running, got ${diagnostics.snapshot().phase}`);
await diagnostics.handleAgentEvent({
  type: "tool_execution_end",
  toolCallId: "call-1",
  toolName: "http",
  isError: false,
  result: { status: 200 },
});
assert(diagnostics.snapshot().phase === "llm_waiting", `expected llm_waiting after tool, got ${diagnostics.snapshot().phase}`);
await diagnostics.handleAgentEvent({ type: "turn_end", message: { role: "assistant" }, toolResults: [{}] });
await diagnostics.handleAgentEvent({ type: "agent_end", messages: [] });
await platform.send({
  type: "task_complete",
  conversation_id: task.conversationId,
  task_id: task.taskId,
  status: "completed",
  summary: "observability smoke complete",
});

const eventsRaw = await readFile(diagnostics.paths.eventsPath, "utf8");
const events = eventsRaw
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line));
assert(events.length >= 8, `expected multiple events, got ${events.length}`);
assert(events.some((item) => item.type === "task_start"), "missing task_start");
assert(events.some((item) => item.type === "tool_execution_start" && item.tool_name === "http"), "missing tool start");
assert(events.some((item) => item.kind === "platform_out" && item.type === "task_complete"), "missing platform task_complete log");

const state = JSON.parse(await readFile(diagnostics.paths.statePath, "utf8"));
assert(state.phase === "finished", `expected finished phase, got ${state.phase}`);
assert(state.toolCallCount >= 1, "toolCallCount should increment");
assert(state.llmTurnCount >= 1, "llmTurnCount should increment");
assert(state.lastTool === "http", `lastTool should be http, got ${state.lastTool}`);

const summary = JSON.parse(await readFile(diagnostics.paths.summaryPath, "utf8"));
assert(summary.paths?.events === "events.jsonl", "summary should document artifact paths");

// Platform still received live messages.
assert(sink.events.some((item) => item.type === "status_update"), "platform sink missing status_update");
assert(sink.events.some((item) => item.type === "task_complete"), "platform sink missing task_complete");

console.log(JSON.stringify({
  ok: true,
  taskDir,
  eventCount: events.length,
  phase: state.phase,
  toolCallCount: state.toolCallCount,
  llmTurnCount: state.llmTurnCount,
  lastTool: state.lastTool,
  artifacts: diagnostics.paths,
}, null, 2));
