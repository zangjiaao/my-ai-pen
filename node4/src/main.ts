import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { loadDotEnv } from "./env.js";
import { PlatformWSClient } from "./platform/ws-client.js";
import { runNode4Task } from "./runtime/session-runner.js";
import type { TaskEnvelope } from "./types.js";
import { parseCaseContext } from "./runtime/case-context.js";
import { sanitizePromptLabel } from "./runtime/prompt.js";
import { cancelApprovalsForConversation, resolveApproval } from "./runtime/approvals.js";

loadDotEnv();
loadDotEnv("node2/.env");
loadDotEnv("node4/.env");

const config = loadConfig();
const client = new PlatformWSClient(config.platformWsUrl, config.nodeToken);
/** Conversations currently executing a work burst. */
const busy = new Set<string>();
/** Per-conversation abort for platform user_interrupt. */
const aborts = new Map<string, AbortController>();

/** Tell the platform whether this node is mid work-burst for a conversation. */
async function emitWorkStatus(
  conversationId: string,
  taskId: string,
  working: boolean,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await client.send({
    type: "work_status",
    conversation_id: conversationId,
    task_id: taskId,
    working,
    // Pi/runtime knows busy set membership; platform UI must mirror this.
    busy: working,
    ...extra,
  });
}

async function runAssignedTask(message: Record<string, unknown>): Promise<void> {
  const task = normalizeTask(message);
  if (busy.has(task.conversationId)) {
    // Handoff supersede: abort the seat that is waiting (e.g. default after authorize)
    // so the destination expert can start immediately on the same conversation.
    const prev = aborts.get(task.conversationId);
    if (prev) {
      cancelApprovalsForConversation(task.conversationId);
      prev.abort();
      for (let i = 0; i < 40 && busy.has(task.conversationId); i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    if (busy.has(task.conversationId)) {
      await client.send({
        type: "task_error",
        conversation_id: task.conversationId,
        task_id: task.taskId,
        message: "Node4 agent is busy on this conversation. Interrupt first to stop the current burst.",
      });
      return;
    }
  }
  const abort = new AbortController();
  aborts.set(task.conversationId, abort);
  busy.add(task.conversationId);
  await emitWorkStatus(task.conversationId, task.taskId, true, {
    expert_id: task.expertId,
    expert_name: task.expertName,
  });
  let endReason = "settled";
  try {
    await runNode4Task(config, client, task, abort.signal);
    if (abort.signal.aborted) endReason = "interrupted";
  } catch (error) {
    if (abort.signal.aborted) {
      endReason = "interrupted";
    } else {
      endReason = "error";
      await client.send({
        type: "task_error",
        conversation_id: task.conversationId,
        task_id: task.taskId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    cancelApprovalsForConversation(task.conversationId);
    if (aborts.get(task.conversationId) === abort) {
      aborts.delete(task.conversationId);
    }
    busy.delete(task.conversationId);
    await emitWorkStatus(task.conversationId, task.taskId, false, {
      reason: endReason,
      expert_id: task.expertId,
      expert_name: task.expertName,
    });
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

/** Platform ConfirmCard → resolve request_user_decision waits. */
client.on("user_input", async (message) => {
  const requestId = String(message.request_id || message.requestId || "").trim();
  if (!requestId) return;
  const response = message.response ?? message.decision ?? message.text ?? "cancel";
  resolveApproval(requestId, response);
});

/** Platform Interrupt button → abort in-flight session.prompt / tool children. */
client.on("user_interrupt", async (message) => {
  const conversationId = String(message.conversation_id || message.conversationId || "").trim();
  if (!conversationId) return;
  cancelApprovalsForConversation(conversationId);
  const action = String(message.action || "cancel").toLowerCase();
  const abort = aborts.get(conversationId);
  if (abort) {
    abort.abort();
    // work_status(working=false) is emitted in runAssignedTask finally after settle.
    await client.send({
      type: "status_update",
      conversation_id: conversationId,
      message: action === "pause" ? "Paused by user." : "Interrupted by user — stopping this work burst.",
      status: action === "pause" ? "paused" : "canceled",
      agent_phase: "aborted",
      working: true, // still winding down until finally
    });
    return;
  }
  await client.send({
    type: "status_update",
    conversation_id: conversationId,
    message: "No active work burst to interrupt on this node.",
    status: "idle",
    working: false,
  });
  // Explicit idle so platform clears a stale worker entry for this node.
  await emitWorkStatus(conversationId, String(message.task_id || ""), false, {
    reason: "not_busy",
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
      ? "Within authorized scope, maximize verified findings, flags, and challenge unlocks with evidence-backed booking. Enumerate challenges yourself from recon. Keep the full objective intact across turns — do not redefine success around easy wins. Call goal(complete) only after a completion audit against current tool evidence proves every recon deliverable is solved or proven blocked. Budget exhaustion is not completion. Partial clearance is not done."
      : undefined;

  // Persona labels are untrusted product config — strip prompt-hostile chars early.
  const expertNameRaw =
    typeof message.expert_name === "string"
      ? message.expert_name
      : typeof message.expertName === "string"
        ? message.expertName
        : undefined;
  const expertIdRaw =
    typeof message.expert_id === "string"
      ? message.expert_id
      : typeof message.expertId === "string"
        ? message.expertId
        : undefined;
  const expertName = expertNameRaw ? sanitizePromptLabel(expertNameRaw, "") || undefined : undefined;
  const expertId = expertIdRaw ? sanitizePromptLabel(expertIdRaw, "") || undefined : undefined;

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

  const caseContext = parseCaseContext(message.case_context ?? message.caseContext);

  // Language: top-level agent_language or worker_limits.agent_language from node config.
  const limits =
    message.worker_limits && typeof message.worker_limits === "object" && !Array.isArray(message.worker_limits)
      ? (message.worker_limits as Record<string, unknown>)
      : message.workerLimits && typeof message.workerLimits === "object" && !Array.isArray(message.workerLimits)
        ? (message.workerLimits as Record<string, unknown>)
        : {};
  const agentLanguageRaw =
    typeof message.agent_language === "string"
      ? message.agent_language
      : typeof message.agentLanguage === "string"
        ? message.agentLanguage
        : typeof limits.agent_language === "string"
          ? limits.agent_language
          : typeof limits.agentLanguage === "string"
            ? limits.agentLanguage
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
    caseContext,
    agentLanguage: agentLanguageRaw?.trim() || undefined,
  };
}

console.log(`[node4] starting node=${config.nodeName} ws=${config.platformWsUrl}`);
await client.connect();
