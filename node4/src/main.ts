import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { loadDotEnv } from "./env.js";
import { PlatformWSClient } from "./platform/ws-client.js";
import { runNode4Task } from "./runtime/session-runner.js";
import {
  stopAllBrowserSandboxes,
  startBrowserSandboxBackgroundJobs,
} from "./runtime/browser-sandbox.js";
import { isLlmTurnError } from "./runtime/llm-turn-error.js";
import { streamDiagnosisPayload } from "./runtime/llm-turn-surface.js";
import type { TaskEnvelope } from "./types.js";
import { parseCaseContext } from "./runtime/case-context.js";
import { parseGraphExecution } from "./runtime/hard-graph-definition.js";
import {
  parseAllowDestructive,
  parseAllowPostex,
  parseFocusFields,
  parseHandoffSummary,
} from "./runtime/task-envelope-fields.js";
import { sanitizePromptLabel } from "./runtime/prompt-template.js";
import { extractAgentLanguageFromMessage } from "./runtime/agent-language.js";
import {
  cancelApprovalsForConversation,
  normalizeApprovalResponse,
  resolveApproval,
  shouldAbortTurnOnApprovalDecision,
} from "./runtime/approvals.js";
import { classifyUserControl } from "./runtime/package-settlement-law.js";
import {
  clearPendingSteers,
  deliverUserSteerToActiveSession,
  enqueuePendingSteer,
} from "./runtime/active-session-registry.js";
import {
  clearPendingCaseDispose,
  clearPendingSessionDispose,
  disposeWorkingSession,
  disposeWorkingSessionsForCase,
  markPendingCaseDispose,
  markPendingSessionDispose,
  resetWorkingSessionMemory,
} from "./runtime/working-session-park.js";
import { releaseWorkerById } from "./runtime/subagent-idle-pool.js";
import {
  installExpert,
  listInstalledPackIds,
  reconcilePlatformOffers,
  uninstallExpert,
} from "./experts/install.js";

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
      prev.abort("authorized_handoff");
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
      // Spec #353: prefer typed LlmTurnError (+ diagnosis) over message regex.
      if (isLlmTurnError(error)) {
        const diagnosis = streamDiagnosisPayload(error.diagnosis);
        await client.send({
          type: "task_error",
          conversation_id: task.conversationId,
          task_id: task.taskId,
          message: error.userMessage,
          stop_reason: "llm_error",
          ...(diagnosis ? { stream_diagnosis: diagnosis } : {}),
        });
      } else {
        const raw = error instanceof Error ? error.message : String(error);
        const message = raw.startsWith("模型调用失败") || raw.startsWith("llm_error")
          ? raw.replace(/^llm_error:\s*/i, "")
          : raw;
        await client.send({
          type: "task_error",
          conversation_id: task.conversationId,
          task_id: task.taskId,
          message,
          stop_reason: "error",
        });
      }
    }
  } finally {
    cancelApprovalsForConversation(task.conversationId);
    if (aborts.get(task.conversationId) === abort) {
      aborts.delete(task.conversationId);
    }
    busy.delete(task.conversationId);
    // Drop steers that never hit a live session (burst ended mid-race).
    clearPendingSteers(task.conversationId);
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

/** Wait until conversation is not mid work-burst (or timeout). */
async function waitConversationIdle(conversationId: string, maxMs = 4000): Promise<boolean> {
  const start = Date.now();
  while (busy.has(conversationId) && Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return !busy.has(conversationId);
}

/**
 * Spec #354: Case close protocol — release all captains for a CaseID.
 * Platform sends on conversation delete/archive.
 */
client.on("case_session_release", async (message) => {
  const conversationId = String(message.conversation_id || message.conversationId || "").trim();
  if (!conversationId) return;
  // Mark dispose-on-finally so a live burst cannot re-park after abort.
  markPendingCaseDispose(conversationId);
  const prev = aborts.get(conversationId);
  if (prev) {
    cancelApprovalsForConversation(conversationId);
    prev.abort();
  }
  // Ack = accepted only (Platform does not wait). Cleanup is async; do not invent
  // disposed/keys counts before work finishes (Spec #354 deferred release).
  await client.send({
    type: "case_session_release_ack",
    conversation_id: conversationId,
    accepted: true,
    deferred: true,
  });
  void (async () => {
    try {
      const idle = await waitConversationIdle(conversationId);
      const result = await disposeWorkingSessionsForCase(conversationId);
      if (idle) {
        clearPendingCaseDispose(conversationId);
      }
      console.log(
        `[node4] case_session_release conv=${conversationId.slice(0, 8)} disposed=${result.disposed} idle=${idle} deferred=true`,
      );
    } catch (err) {
      console.error(
        `[node4] case_session_release background dispose failed conv=${conversationId.slice(0, 8)}:`,
        err instanceof Error ? err.message : err,
      );
    }
  })();
});

/**
 * Spec #354 L10: Session Delete — dispose one Participant Session captain.
 * Incomplete Todo snapshot returned for Case pending-handoff holding.
 */
client.on("session_dispose", async (message) => {
  const conversationId = String(message.conversation_id || message.conversationId || "").trim();
  const expertId = String(message.expert_id || message.expertId || "").trim();
  if (!conversationId) return;
  // Missing expert_id: Case-scoped pending so any conv::expert finally disposes.
  if (expertId) {
    markPendingSessionDispose(conversationId, expertId);
  } else {
    markPendingCaseDispose(conversationId);
  }
  // If this Session's Case is mid-burst, abort so finally can dispose (not park).
  const prev = aborts.get(conversationId);
  if (prev) {
    cancelApprovalsForConversation(conversationId);
    prev.abort();
  }
  const idle = await waitConversationIdle(conversationId);
  const result = await disposeWorkingSession(conversationId, expertId || undefined);
  if (idle) {
    if (expertId) clearPendingSessionDispose(conversationId, expertId);
    else clearPendingCaseDispose(conversationId);
  }
  console.log(
    `[node4] session_dispose conv=${conversationId.slice(0, 8)} expert=${expertId || "-"} disposed=${result.disposed} idle=${idle}`,
  );
  await client.send({
    type: "session_dispose_ack",
    conversation_id: conversationId,
    expert_id: expertId || null,
    disposed: result.disposed,
    open_todos: result.openTodos,
    pending: !idle,
  });
});

/**
 * Spec #354 L9: Session Reset — clear model memory, keep incomplete Todo.
 */
client.on("session_reset", async (message) => {
  const conversationId = String(message.conversation_id || message.conversationId || "").trim();
  const expertId = String(message.expert_id || message.expertId || "").trim();
  if (!conversationId) return;
  // Prefer idle Reset; if busy, abort then wait so park exists for reset.
  if (busy.has(conversationId)) {
    const prev = aborts.get(conversationId);
    if (prev) {
      cancelApprovalsForConversation(conversationId);
      prev.abort();
    }
    await waitConversationIdle(conversationId);
  }
  const result = await resetWorkingSessionMemory(conversationId, expertId || undefined);
  console.log(
    `[node4] session_reset conv=${conversationId.slice(0, 8)} expert=${expertId || "-"} ok=${result.ok} sid=${(result.agentSessionId || "").slice(0, 8)}`,
  );
  await client.send({
    type: "session_reset_ack",
    conversation_id: conversationId,
    expert_id: expertId || null,
    ok: result.ok,
    open_todo_count: result.openTodoCount,
    reason: result.reason,
    // Spec #354 L10a: new pi Agent.sessionId after Reset (operator copy chrome).
    agent_session_id: result.agentSessionId || null,
  });
});

/**
 * Spec #491 / #354 L12: operator End Worker — dispose idle park or live child.
 * Does not dispose the Participant Session captain.
 */
client.on("worker_release", async (message) => {
  const conversationId = String(message.conversation_id || message.conversationId || "").trim();
  const agentId = String(message.agent_id || message.agentId || "").trim();
  const expertId = String(message.expert_id || message.expertId || "").trim();
  if (!conversationId || !agentId) return;
  const released = await releaseWorkerById(agentId, conversationId);
  console.log(
    `[node4] worker_release conv=${conversationId.slice(0, 8)} agent=${agentId.slice(0, 24)} released=${released}`,
  );
  await client.send({
    type: "worker_release_ack",
    conversation_id: conversationId,
    expert_id: expertId || null,
    agent_id: agentId,
    released,
    reason: released ? "disposed" : "not_found",
  });
});

/** Report physical pack install state so platform logs / future UI can verify. */
async function reportExpertsStatus(extra: Record<string, unknown> = {}): Promise<void> {
  const installed = listInstalledPackIds();
  await client.send({
    type: "experts_status",
    installed,
    effective: installed,
    ...extra,
  });
}

/**
 * Platform UI install/uninstall updates offers and pushes these commands so
 * node4/installed-experts matches "already installed" in the product UI.
 */
client.on("expert_install", async (message) => {
  const packId = String(message.pack_id || message.expert_id || message.packId || "").trim();
  if (!packId) return;
  const r = installExpert(packId);
  console.log(`[node4] expert_install ${packId} ok=${r.ok} ${r.message || ""}`);
  await reportExpertsStatus({
    action: "install",
    pack_id: packId,
    ok: r.ok,
    message: r.message,
  });
});

client.on("expert_uninstall", async (message) => {
  const packId = String(message.pack_id || message.expert_id || message.packId || "").trim();
  if (!packId) return;
  const r = uninstallExpert(packId);
  console.log(`[node4] expert_uninstall ${packId} ok=${r.ok} ${r.message || ""}`);
  await reportExpertsStatus({
    action: "uninstall",
    pack_id: packId,
    ok: r.ok,
    message: r.message,
  });
});

/** Full offers list from platform (on UI install and on every node reconnect). */
client.on("expert_sync", async (message) => {
  const raw = message.offers;
  const offers = Array.isArray(raw) ? raw.map((x) => String(x)) : [];
  const r = reconcilePlatformOffers(offers);
  console.log(
    `[node4] expert_sync offers=[${offers.join(",")}] installed=[${r.installed.join(",")}] ok=${r.ok}`,
  );
  await reportExpertsStatus({
    action: "sync",
    ok: r.ok,
    offers,
  });
});

client.on("ws_open", async () => {
  // Platform also pushes expert_sync on NODE ONLINE; status report is belt-and-suspenders.
  await reportExpertsStatus({ action: "hello" });
});

/**
 * Shared-session follow-up from the platform (mid-task steer or continue).
 * When a work burst is active: inject into the live Agent via steer/followUp
 * (pi mid-run padding — not a new burst, not "still working" reject).
 * When idle: promote steer to a new work burst.
 */
client.on("user_steer", async (message) => {
  const conversationId = String(message.conversation_id || message.conversationId || "").trim();
  if (!conversationId) return;

  const contentText =
    message.content && typeof message.content === "object" && !Array.isArray(message.content)
      ? String((message.content as Record<string, unknown>).text || "")
      : "";
  const text = String(message.text || contentText || message.initial_instruction || "").trim();
  // Spec #116 I0.8: empty message is not abort (shared law)
  const ctrl = classifyUserControl({ kind: text ? "steer_text" : "empty_message", text });
  if (ctrl.reject || !text) return;

  if (busy.has(conversationId)) {
    const delivered = deliverUserSteerToActiveSession(conversationId, text);
    if (delivered.ok) {
      // Silent inject — no canned agent/progress chat (AGENTS.md).
      return;
    }
    // Busy race: session not registered yet. Queue until register flushes.
    if (delivered.reason === "no_session") {
      enqueuePendingSteer(conversationId, text);
      return;
    }
    return;
  }

  await runAssignedTask({
    ...message,
    conversation_id: conversationId,
    initial_instruction: text,
    text,
  });
});

/** Platform ConfirmCard / ChoiceCard → resolve request_user_decision waits. */
client.on("user_input", async (message) => {
  const requestId = String(message.request_id || message.requestId || "").trim();
  if (!requestId) return;
  // Spec #313 L3: mid-run replace permission from structured user confirm (platform-issued).
  const conversationId = String(message.conversation_id || message.conversationId || "").trim();
  const selectedRaw = message.selected_option_ids ?? message.selectedOptionIds;
  const selectedIds = Array.isArray(selectedRaw)
    ? selectedRaw.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  const replacePerm =
    message.todo_replace_permission === true ||
    message.todoReplacePermission === true ||
    selectedIds.includes("replace_todo_map");
  if (replacePerm && conversationId) {
    const { grantTodoReplace } = await import("./runtime/todo-replace-grant.js");
    grantTodoReplace(conversationId);
  }
  const response = message.response ?? message.decision ?? message.text ?? "cancel";
  resolveApproval(requestId, response, {
    selected_option_ids: message.selected_option_ids ?? message.selectedOptionIds,
    workset_item_ids: message.workset_item_ids ?? message.worksetItemIds,
    text: message.text,
    custom_text: message.custom_text ?? message.customText,
    answers: message.answers,
  });
  // User declined the card: stop this turn. Do not feed cancel back into another LLM loop
  // (that re-opens the work timer and can emit another 等待授权 card).
  if (shouldAbortTurnOnApprovalDecision(normalizeApprovalResponse(response)) && conversationId) {
    aborts.get(conversationId)?.abort();
  }
});

/** Platform Interrupt button → abort in-flight session.prompt / tool children. */
client.on("user_interrupt", async (message) => {
  const conversationId = String(message.conversation_id || message.conversationId || "").trim();
  if (!conversationId) return;
  // I0.7: UI interrupt ≠ package-fail (classifyUserControl); abort ends this Graph run.
  cancelApprovalsForConversation(conversationId);
  const abort = aborts.get(conversationId);
  if (abort) {
    const interruptReason = String(message.reason || "").trim();
    const handedOff = interruptReason === "authorized_handoff";
    abort.abort(handedOff ? "authorized_handoff" : undefined);
    return;
  }
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
      : {};
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
  const graphIdRaw =
    typeof message.graph_id === "string"
      ? message.graph_id
      : typeof message.graphId === "string"
        ? message.graphId
        : undefined;
  const graphMainActRaw = String(
    message.graph_main_act ?? message.graphMainAct ?? "",
  )
    .trim()
    .toLowerCase();
  const graphMainAct =
    graphMainActRaw === "delegate_only" || graphMainActRaw === "hard"
      ? ("delegate_only" as const)
      : graphMainActRaw === "delegate_preferred" || graphMainActRaw === "soft"
        ? ("delegate_preferred" as const)
        : undefined;
  const graphExecution = parseGraphExecution(message);
  const focus = parseFocusFields(message);
  const handoffSummary = parseHandoffSummary(message);
  const allowPostex = parseAllowPostex(message);
  const allowDestructive = parseAllowDestructive(message);

  const caseContext = parseCaseContext(message.case_context ?? message.caseContext);
  const conversationTitleRaw =
    message.conversation_title ?? message.conversationTitle;
  const conversationTitle =
    typeof conversationTitleRaw === "string"
      ? conversationTitleRaw
      : conversationTitleRaw != null
        ? String(conversationTitleRaw)
        : undefined;

  // Language: top-level or worker_limits; always a registry wire code (#138).
  const agentLanguage = extractAgentLanguageFromMessage(message);

  // Spec #313 L3: platform-issued Free todo replace grant (one-shot for this task turn).
  const todoReplaceAllowed =
    message.todo_replace_allowed === true ||
    message.todoReplaceAllowed === true ||
    String(message.todo_replace_allowed ?? message.todoReplaceAllowed ?? "")
      .trim()
      .toLowerCase() === "true" ||
    message.todo_replace_permission === true ||
    message.todoReplacePermission === true;

  return {
    taskId,
    conversationId,
    instruction,
    target,
    scope,
    engagement: typeof message.engagement === "string" ? message.engagement : undefined,
    role: typeof message.role === "string" ? message.role : undefined,
    engagementTemplate: engagementTemplate?.trim() || undefined,
    graphId: graphIdRaw?.trim() || undefined,
    graphMainAct,
    graphExecution,
    focusFindingIds: focus.focusFindingIds,
    focusNote: focus.focusNote,
    handoffSummary,
    allowPostex,
    allowDestructive,
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
    conversationTitle,
    agentLanguage,
    todoReplaceAllowed: todoReplaceAllowed || undefined,
    pendingHandoffTodos:
      message.pending_handoff_todos !== undefined
        ? message.pending_handoff_todos
        : message.pendingHandoffTodos !== undefined
          ? message.pendingHandoffTodos
          : undefined,
    pendingHandoff:
      message.pending_handoff === true ||
      message.pendingHandoff === true ||
      undefined,
    sessionContinue:
      message.session_continue === true ||
      message.sessionContinue === true ||
      undefined,
  };
}

/** Spec #334: startup + periodic janitor and lease heartbeat. */
const browserSandboxJobs = startBrowserSandboxBackgroundJobs();

/** Bounded wait so docker/lock hangs cannot block process exit forever (review #320). */
const BROWSER_SANDBOX_SHUTDOWN_DISPOSE_MS = 20_000;

/** Spec #430: stop (not rm) sticky pen-sandboxes on graceful Node exit. */
function installGracefulBrowserSandboxShutdown(): void {
  let shuttingDown = false;
  const onSignal = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    browserSandboxJobs.stop();
    console.log(
      `[node4] ${signal}: stopping sticky pen-sandboxes (timeout ${BROWSER_SANDBOX_SHUTDOWN_DISPOSE_MS}ms)`,
    );
    const timedOut = new Promise<never>((_, reject) => {
      const t = setTimeout(
        () => reject(new Error(`browser sandbox stop timed out after ${BROWSER_SANDBOX_SHUTDOWN_DISPOSE_MS}ms`)),
        BROWSER_SANDBOX_SHUTDOWN_DISPOSE_MS,
      );
      t.unref?.();
    });
    void Promise.race([stopAllBrowserSandboxes(), timedOut])
      .then(() => {
        process.exit(0);
      })
      .catch((err) => {
        console.warn(
          `[node4] browser sandbox stopAll failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      });
  };
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  process.once("SIGINT", () => onSignal("SIGINT"));
}

installGracefulBrowserSandboxShutdown();

console.log(`[node4] starting node=${config.nodeName} ws=${config.platformWsUrl}`);
await client.connect();
