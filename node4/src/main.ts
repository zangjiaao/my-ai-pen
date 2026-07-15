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
/** Conversations currently executing a work burst. */
const busy = new Set<string>();
/** Per-conversation abort for platform user_interrupt. */
const aborts = new Map<string, AbortController>();

async function runAssignedTask(message: Record<string, unknown>): Promise<void> {
  const task = normalizeTask(message);
  if (busy.has(task.conversationId)) {
    await client.send({
      type: "task_error",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      message: "Node4 agent is busy on this conversation. Interrupt first to stop the current burst.",
    });
    return;
  }
  const abort = new AbortController();
  aborts.set(task.conversationId, abort);
  busy.add(task.conversationId);
  try {
    await runNode4Task(config, client, task, abort.signal);
  } catch (error) {
    if (!abort.signal.aborted) {
      await client.send({
        type: "task_error",
        conversation_id: task.conversationId,
        task_id: task.taskId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    if (aborts.get(task.conversationId) === abort) {
      aborts.delete(task.conversationId);
    }
    busy.delete(task.conversationId);
  }
}

client.on("task_assign", async (message) => {
  await runAssignedTask(message);
});

/**
 * Shared-session follow-up from the platform (mid-task steer or continue).
 * Node4 has no long-lived host after settle — promote steer to a work burst
 * when not busy; otherwise tell the room the expert is still working.
 */
client.on("user_steer", async (message) => {
  const conversationId = String(message.conversation_id || message.conversationId || "").trim();
  if (!conversationId) return;

  if (busy.has(conversationId)) {
    await client.send({
      type: "text",
      conversation_id: conversationId,
      content: {
        text: "This expert is still working on the current turn. Wait a moment or interrupt first.",
      },
    });
    return;
  }

  const contentText =
    message.content && typeof message.content === "object" && !Array.isArray(message.content)
      ? String((message.content as Record<string, unknown>).text || "")
      : "";
  const text = String(message.text || contentText || message.initial_instruction || "").trim();
  if (!text) return;

  await runAssignedTask({
    ...message,
    conversation_id: conversationId,
    initial_instruction: text,
    text,
  });
});

/** Platform Interrupt button → abort in-flight session.prompt / tool children. */
client.on("user_interrupt", async (message) => {
  const conversationId = String(message.conversation_id || message.conversationId || "").trim();
  if (!conversationId) return;
  const action = String(message.action || "cancel").toLowerCase();
  const abort = aborts.get(conversationId);
  if (abort) {
    abort.abort();
    await client.send({
      type: "status_update",
      conversation_id: conversationId,
      message: action === "pause" ? "Paused by user." : "Interrupted by user — stopping this work burst.",
      status: action === "pause" ? "paused" : "canceled",
      agent_phase: "aborted",
    });
    return;
  }
  await client.send({
    type: "status_update",
    conversation_id: conversationId,
    message: "No active work burst to interrupt on this node.",
    status: "idle",
  });
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
  const goalObjectiveRaw =
    typeof message.goal_objective === "string"
      ? message.goal_objective
      : typeof message.goalObjective === "string"
        ? message.goalObjective
        : "";
  const goalModeOn =
    message.goal_mode === true ||
    message.goal_mode === "true" ||
    message.goalMode === true ||
    Boolean(goalObjectiveRaw.trim());
  const goalObjective = goalObjectiveRaw.trim()
    ? goalObjectiveRaw.trim()
    : goalModeOn
      ? "Within authorized scope, maximize verified findings, flags, and challenge unlocks with evidence-backed booking. Enumerate challenges yourself. Do not complete until remaining recon items are solved or proven blocked; complete needs audit_notes, remaining_unsolved=0, and harness gates. Partial clearance is not done."
      : undefined;

  const expertName =
    typeof message.expert_name === "string"
      ? message.expert_name
      : typeof message.expertName === "string"
        ? message.expertName
        : undefined;
  const expertId =
    typeof message.expert_id === "string"
      ? message.expert_id
      : typeof message.expertId === "string"
        ? message.expertId
        : undefined;

  const engagementTemplate =
    typeof message.engagement_template === "string"
      ? message.engagement_template
      : typeof message.engagementTemplate === "string"
        ? message.engagementTemplate
        : undefined;
  const allowPostexRaw = message.allow_postex ?? message.allowPostex;
  const allowPostex =
    typeof allowPostexRaw === "boolean"
      ? allowPostexRaw
      : allowPostexRaw === "true"
        ? true
        : allowPostexRaw === "false"
          ? false
          : undefined;

  return {
    taskId,
    conversationId,
    instruction,
    target,
    scope,
    engagement: typeof message.engagement === "string" ? message.engagement : undefined,
    role: typeof message.role === "string" ? message.role : undefined,
    engagementTemplate: engagementTemplate?.trim() || undefined,
    allowPostex,
    accounts: message.accounts !== undefined ? message.accounts : undefined,
    goalObjective,
    expertName: expertName?.trim() || undefined,
    expertId: expertId?.trim() || undefined,
    parentTaskId:
      typeof message.parent_task_id === "string"
        ? message.parent_task_id
        : typeof message.parentTaskId === "string"
          ? message.parentTaskId
          : undefined,
  };
}

console.log(`[node4] starting node=${config.nodeName} ws=${config.platformWsUrl}`);
await client.connect();
