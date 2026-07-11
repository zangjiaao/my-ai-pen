import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { loadDotEnv } from "./env.js";
import { PlatformWSClient } from "./platform/ws-client.js";
import { runNode4Task } from "./runtime/session-runner.js";
import type { TaskEnvelope } from "./types.js";

loadDotEnv();
loadDotEnv("node2/.env");
loadDotEnv("node4/.env");

const config = loadConfig();
const client = new PlatformWSClient(config.platformWsUrl, config.nodeToken);
const busy = new Set<string>();

client.on("task_assign", async (message) => {
  const task = normalizeTask(message);
  if (busy.has(task.conversationId)) {
    await client.send({
      type: "task_error",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      message: "Node4 agent is busy on this conversation.",
    });
    return;
  }
  busy.add(task.conversationId);
  try {
    await runNode4Task(config, client, task);
  } catch (error) {
    await client.send({
      type: "task_error",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    busy.delete(task.conversationId);
  }
});

function normalizeTask(message: Record<string, unknown>): TaskEnvelope {
  const taskId = String(message.task_id || message.taskId || randomUUID());
  const conversationId = String(message.conversation_id || message.conversationId || taskId);
  const targetRaw = message.target;
  const target =
    targetRaw && typeof targetRaw === "object" && !Array.isArray(targetRaw)
      ? (targetRaw as Record<string, unknown>)
      : { type: "url", value: String(message.target || "") };
  const scopeRaw = message.scope;
  const scope =
    scopeRaw && typeof scopeRaw === "object" && !Array.isArray(scopeRaw)
      ? (scopeRaw as Record<string, unknown>)
      : { allow: [] };
  const instruction = String(
    message.initial_instruction || message.instruction || message.text || "Authorized security assessment.",
  );
  return {
    taskId,
    conversationId,
    instruction,
    target,
    scope,
    engagement: typeof message.engagement === "string" ? message.engagement : undefined,
  };
}

console.log(`[node4] starting node=${config.nodeName} ws=${config.platformWsUrl}`);
await client.connect();
