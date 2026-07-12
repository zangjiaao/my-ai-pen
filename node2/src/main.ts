import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { loadDotEnv } from "./env.js";
import { PlatformWSClient } from "./platform/ws-client.js";
import {
  disposeConversationHost,
  getConversationHost,
  getOrCreateConversationHost,
} from "./runtime/conversation-host.js";
import type { PlatformMessage, ScanMode, TaskEnvelope } from "./types.js";

loadDotEnv();
loadDotEnv("node2/.env");

const config = loadConfig();
const client = new PlatformWSClient(config.platformWsUrl, config.nodeToken);

/** Per-conversation abort for the current work burst (not process-wide busy). */
const burstAborts = new Map<string, AbortController>();

client.on("task_assign", async (message) => {
  const task = normalizeTask(message);
  const host = getOrCreateConversationHost(task.conversationId, config, client);

  if (host.isBusy()) {
    await client.send({
      type: "task_error",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      message: "This conversation's pentest agent is still working. Wait a moment or send interrupt first.",
    });
    return;
  }

  const abort = new AbortController();
  burstAborts.set(task.conversationId, abort);
  try {
    await host.startTask(task, abort.signal);
  } catch (error) {
    await client.send({
      type: "task_error",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (burstAborts.get(task.conversationId) === abort) {
      burstAborts.delete(task.conversationId);
    }
  }
});

/**
 * Follow-up in the group chat: same Pi mind, not a new task_assign.
 * Platform should prefer this after failed/incomplete/complete instead of re-dispatch theater.
 */
client.on("user_steer", async (message) => {
  const conversationId = String(message.conversation_id || "").trim();
  if (!conversationId) return;

  let host = getConversationHost(conversationId);
  const contentText =
    message.content && typeof message.content === "object" && !Array.isArray(message.content)
      ? String((message.content as Record<string, unknown>).text || "")
      : "";
  const text = String(message.text || contentText || message.initial_instruction || "").trim();
  if (!text) return;

  // Node process restarted (or cancel disposed host): if user re-sends a target,
  // re-join the group chat with a fresh living session instead of dead-ending.
  if (!host || host.getStatus() === "disposed") {
    const recovered = tryRecoverTaskFromSteer(message, conversationId, text);
    if (!recovered) {
      await client.send({
        type: "text",
        conversation_id: conversationId,
        content: {
          text:
            "No live pentest session for this conversation on this node (process may have restarted). " +
            "Please re-send the target URL/IP once so a new session can join the group chat.",
        },
      });
      return;
    }
    host = getOrCreateConversationHost(conversationId, config, client);
    const abort = new AbortController();
    burstAborts.set(conversationId, abort);
    try {
      await host.startTask(recovered, abort.signal);
    } catch (error) {
      await client.send({
        type: "task_error",
        conversation_id: conversationId,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (burstAborts.get(conversationId) === abort) {
        burstAborts.delete(conversationId);
      }
    }
    return;
  }

  if (host.isBusy()) {
    await client.send({
      type: "text",
      conversation_id: conversationId,
      content: {
        text: "This agent is still working on the previous turn. Wait for it to finish, or interrupt first.",
      },
    });
    return;
  }

  const abort = new AbortController();
  burstAborts.set(conversationId, abort);
  try {
    await host.steer(text, abort.signal);
  } catch (error) {
    await client.send({
      type: "task_error",
      conversation_id: conversationId,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (burstAborts.get(conversationId) === abort) {
      burstAborts.delete(conversationId);
    }
  }
});

client.on("user_interrupt", async (message) => {
  const conversationId = String(message.conversation_id || "").trim();
  const action = String(message.action || "cancel").toLowerCase();
  const abort = conversationId ? burstAborts.get(conversationId) : undefined;
  abort?.abort();

  // Full cancel removes the participant from the group (memory wiped for this process).
  // pause/resume only stop the current burst; session stays alive.
  if (action === "cancel" && conversationId) {
    await disposeConversationHost(conversationId);
    burstAborts.delete(conversationId);
  }

  await client.send({
    type: "text",
    conversation_id: conversationId,
    content: {
      text:
        action === "cancel"
          ? "Task interrupted; this conversation's pentest session was closed."
          : "Interrupt signal sent to the current work burst. Session memory is kept.",
    },
  });
});

client.on("user_input", async () => {
  await client.send({
    type: "text",
    content: {
      text: "Node2 received user_input, but v1 handles approvals through runtime gates rather than a visible approval tool.",
    },
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
  const workerLimits = normalizeWorkerLimits(message.worker_limits || message.workerLimits);
  const hasExplicitScan =
    (message.scan_mode != null && String(message.scan_mode).trim() !== "") ||
    (message.scanMode != null && String(message.scanMode).trim() !== "");
  return {
    taskId,
    conversationId,
    instruction: String(message.initial_instruction || message.text || ""),
    scanMode: normalizeScanMode(
      hasExplicitScan ? message.scan_mode || message.scanMode : workerLimits?.defaultScanMode,
    ),
    engagement,
    target: isRecord(message.target) ? message.target : {},
    scope: isRecord(message.scope) ? message.scope : {},
    snapshot: isRecord(message.snapshot) ? message.snapshot : {},
    workerLimits,
  };
}

/** Rebuild a task envelope from a steer when the living host was lost (node restart). */
function tryRecoverTaskFromSteer(
  message: PlatformMessage,
  conversationId: string,
  text: string,
): TaskEnvelope | undefined {
  if (isRecord(message.target) && String(message.target.value || message.target.url || "").trim()) {
    return normalizeTask({ ...message, conversation_id: conversationId, type: "task_assign" });
  }
  const urlMatch = text.match(/https?:\/\/[^\s<>"']+/i);
  if (!urlMatch) return undefined;
  const value = urlMatch[0].replace(/[),.;]+$/, "");
  return normalizeTask({
    ...message,
    type: "task_assign",
    conversation_id: conversationId,
    task_id: String(message.task_id || randomUUID()),
    target: { type: "url", value },
    scope: { allow: [value], deny: [] },
    initial_instruction: text,
    text,
  });
}

function normalizeWorkerLimits(raw: unknown): TaskEnvelope["workerLimits"] | undefined {
  if (!isRecord(raw)) return undefined;
  const maxMs = Number(raw.worker_max_ms ?? raw.maxMs ?? raw.max_ms);
  const maxTurns = Number(raw.worker_max_turns ?? raw.maxTurns ?? raw.max_turns);
  const maxTimeoutRetries = Number(
    raw.worker_max_timeout_retries ?? raw.maxTimeoutRetries ?? raw.max_timeout_retries,
  );
  const mainMaxMs = Number(raw.main_max_ms ?? raw.mainMaxMs ?? raw.main_ms);
  const mainMaxTurns = Number(raw.main_max_turns ?? raw.mainMaxTurns);
  const maxConcurrentWorkers = Number(
    raw.max_concurrent_workers ?? raw.maxConcurrentWorkers ?? raw.concurrent_workers,
  );
  const scanRaw = raw.default_scan_mode ?? raw.defaultScanMode ?? raw.scan_mode;
  const out: NonNullable<TaskEnvelope["workerLimits"]> = {};
  if (Number.isFinite(maxMs) && maxMs > 0) out.maxMs = Math.floor(maxMs);
  if (Number.isFinite(maxTurns) && maxTurns > 0) out.maxTurns = Math.floor(maxTurns);
  if (Number.isFinite(maxTimeoutRetries) && maxTimeoutRetries >= 0) {
    out.maxTimeoutRetries = Math.floor(maxTimeoutRetries);
  }
  if (Number.isFinite(mainMaxMs) && mainMaxMs > 0) out.mainMaxMs = Math.floor(mainMaxMs);
  if (Number.isFinite(mainMaxTurns) && mainMaxTurns > 0) out.mainMaxTurns = Math.floor(mainMaxTurns);
  if (Number.isFinite(maxConcurrentWorkers) && maxConcurrentWorkers > 0) {
    out.maxConcurrentWorkers = Math.floor(maxConcurrentWorkers);
  }
  if (typeof scanRaw === "string" && scanRaw.trim()) {
    const mode = scanRaw.trim().toLowerCase();
    if (mode === "quick" || mode === "standard" || mode === "deep") out.defaultScanMode = mode;
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
