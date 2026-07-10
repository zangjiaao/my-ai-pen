import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { loadDotEnv } from "./env.js";
import { PlatformWSClient } from "./platform/ws-client.js";
import { runPentestTask } from "./runtime/session-runner.js";
import type { PlatformMessage, ScanMode, TaskEnvelope } from "./types.js";

loadDotEnv();
loadDotEnv("node2/.env");

const config = loadConfig();
const client = new PlatformWSClient(config.platformWsUrl, config.nodeToken);

let currentAbort: AbortController | undefined;
let currentTask: Promise<void> | undefined;

client.on("task_assign", async (message) => {
  if (currentTask) {
    await client.send({
      type: "task_error",
      conversation_id: String(message.conversation_id || ""),
      message: "Node2 is busy",
    });
    return;
  }

  const task = normalizeTask(message);
  currentAbort = new AbortController();
  currentTask = (async () => {
    try {
      await runPentestTask(config, client, task, currentAbort.signal);
    } catch (error) {
      await client.send({
        type: "task_error",
        conversation_id: task.conversationId,
        task_id: task.taskId,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      currentAbort = undefined;
      currentTask = undefined;
    }
  })();
});

client.on("user_interrupt", async (message) => {
  currentAbort?.abort();
  await client.send({
    type: "text",
    conversation_id: String(message.conversation_id || ""),
    content: { text: "Task interrupted by user." },
  });
});

client.on("user_input", async () => {
  await client.send({
    type: "text",
    content: { text: "Node2 received user_input, but v1 handles approvals through runtime gates rather than a visible approval tool." },
  });
});

console.log(`[node2] ${config.nodeName} starting. Platform: ${config.platformWsUrl}`);
await client.connect();

function normalizeTask(message: PlatformMessage): TaskEnvelope {
  const taskId = String(message.task_id || randomUUID());
  const conversationId = String(message.conversation_id || taskId);
  // Only structured engagement from the platform — do not keyword-parse free text.
  const engagementRaw = message.engagement ?? message.task_engagement ?? message.intent;
  const engagement =
    typeof engagementRaw === "string" && ["assess", "verify", "retest", "consult"].includes(engagementRaw.trim().toLowerCase())
      ? (engagementRaw.trim().toLowerCase() as TaskEnvelope["engagement"])
      : undefined;
  return {
    taskId,
    conversationId,
    instruction: String(message.initial_instruction || message.text || ""),
    scanMode: normalizeScanMode(message.scan_mode || message.scanMode),
    engagement,
    target: isRecord(message.target) ? message.target : {},
    scope: isRecord(message.scope) ? message.scope : {},
    snapshot: isRecord(message.snapshot) ? message.snapshot : {},
    workerLimits: normalizeWorkerLimits(message.worker_limits || message.workerLimits),
  };
}

function normalizeWorkerLimits(raw: unknown): TaskEnvelope["workerLimits"] | undefined {
  if (!isRecord(raw)) return undefined;
  const maxMs = Number(raw.worker_max_ms ?? raw.maxMs ?? raw.max_ms);
  const maxTurns = Number(raw.worker_max_turns ?? raw.maxTurns ?? raw.max_turns);
  const maxTimeoutRetries = Number(
    raw.worker_max_timeout_retries ?? raw.maxTimeoutRetries ?? raw.max_timeout_retries,
  );
  const out: NonNullable<TaskEnvelope["workerLimits"]> = {};
  if (Number.isFinite(maxMs) && maxMs > 0) out.maxMs = Math.floor(maxMs);
  if (Number.isFinite(maxTurns) && maxTurns > 0) out.maxTurns = Math.floor(maxTurns);
  if (Number.isFinite(maxTimeoutRetries) && maxTimeoutRetries >= 0) {
    out.maxTimeoutRetries = Math.floor(maxTimeoutRetries);
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeScanMode(value: unknown): ScanMode {
  const normalized = String(value || "standard").trim().toLowerCase();
  if (normalized === "quick" || normalized === "standard" || normalized === "deep") return normalized;
  return "standard";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
