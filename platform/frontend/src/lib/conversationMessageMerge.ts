/**
 * Conversation timeline merge + same-family tool grouping.
 * Extracted from ConversationPage so the page stays orchestration, not merge policy.
 */

import type { InfiniteData } from "@tanstack/react-query";
import type { Message } from "./types";
import {
  isProgressiveRunningSummary,
  mergeThinkingStatus,
  mergeToolLifecycleStatus,
} from "./status";
import { toolFamilyKey } from "./toolDetail";
import { shouldRenderStatusNotice } from "./chatStreamChrome";

export type MessageRecord = Record<string, unknown>;
export type MessagesInfiniteData = InfiniteData<MessageRecord[], unknown>;

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function last<T>(items: T[]): T | undefined {
  return items[items.length - 1];
}

export function shouldUpdateMessageRecord(existing: MessageRecord, incoming: MessageRecord): boolean {
  const existingId = recordMessageId(existing);
  const incomingId = recordMessageId(incoming);
  if (existingId && incomingId && existingId === incomingId) return true;
  // Progressive assistant text/thinking: same stream_id updates one bubble.
  const existingType = recordMessageType(existing);
  const incomingType = recordMessageType(incoming);
  if (
    (existingType === "text" || existingType === "thinking")
    && existingType === incomingType
  ) {
    const existingStream = recordStreamId(existing);
    const incomingStream = recordStreamId(incoming);
    if (existingStream && incomingStream && existingStream === incomingStream) return true;
  }
  return recordMessageType(existing) === "tool_call" && recordMessageType(incoming) === "tool_call" && Boolean(recordToolRunKey(existing)) && recordToolRunKey(existing) === recordToolRunKey(incoming);
}

export function mergeMessageRecords(existing: MessageRecord, incoming: MessageRecord): MessageRecord {
  const existingType = recordMessageType(existing);
  const incomingType = recordMessageType(incoming);
  if (
    (existingType === "text" || existingType === "thinking")
    && existingType === incomingType
  ) {
    const existingContent = recordContent(existing);
    const incomingContent = recordContent(incoming);
    const prevText = readString(existingContent.text) || readString(existingContent.reasoning);
    const nextText = readString(incomingContent.text) || readString(incomingContent.reasoning);
    // Stream frames carry cumulative full text. Prefer monotonic growth / prefix
    // relationship — never concatenate (that caused "好的好的" style doubles).
    let text = nextText;
    if (!nextText) text = prevText;
    else if (!prevText) text = nextText;
    else if (nextText.startsWith(prevText) || prevText.startsWith(nextText)) {
      text = nextText.length >= prevText.length ? nextText : prevText;
    } else if (nextText.length >= prevText.length) {
      text = nextText;
    } else {
      text = prevText;
    }
    const mergedStatus =
      existingType === "thinking"
        ? mergeThinkingStatus(existingContent.status, incomingContent.status)
        : incomingContent.status ?? existingContent.status;
    return {
      ...existing,
      ...incoming,
      id: recordMessageId(existing) || recordMessageId(incoming),
      content: {
        ...existingContent,
        ...incomingContent,
        text,
        ...(existingType === "thinking" ? { reasoning: text } : {}),
        ...(mergedStatus !== undefined ? { status: mergedStatus } : {}),
        stream_id: incomingContent.stream_id || existingContent.stream_id,
        message_id: existingContent.message_id || incomingContent.message_id,
      },
      created_at: existing.created_at || incoming.created_at,
    };
  }
  if (existingType !== "tool_call" || incomingType !== "tool_call") return incoming;
  const existingContent = recordContent(existing);
  const incomingContent = recordContent(incoming);
  const mergedStatus = mergeToolLifecycleStatus(existingContent.status, incomingContent.status);
  const mergedItems = mergeToolItemsRecords(existingContent, incomingContent, mergedStatus);
  return {
    ...existing,
    ...incoming,
    // Keep the first durable/stable id so later frames upsert the same card.
    id: recordMessageId(existing) || recordMessageId(incoming),
    content: {
      ...existingContent,
      ...incomingContent,
      command: readString(incomingContent.command) || readString(existingContent.command) || "",
      target: readString(incomingContent.target) || readString(existingContent.target) || "",
      args: incomingContent.args ?? existingContent.args,
      stdout: appendStdout(readString(existingContent.stdout), readString(incomingContent.stdout)),
      // Prefer fail/done over running; keep empty when both missing (result-hint path).
      ...(mergedStatus ? { status: mergedStatus } : { status: "" }),
      // Prefer terminal item status over a late progressive running frame that
      // would otherwise replace the whole tool_items array and re-light 执行中.
      ...(mergedItems ? { tool_items: mergedItems } : {}),
      summary: mergeToolCardSummary(
        existingContent.summary,
        incomingContent.summary,
        mergedStatus,
      ),
      message_id:
        readString(existingContent.message_id)
        || readString(incomingContent.message_id)
        || recordMessageId(existing)
        || recordMessageId(incoming),
    },
    created_at: existing.created_at || incoming.created_at,
  };
}

/**
 * Merge progressive tool_items by tool_run_id; prefer fail → done over running
 * (align platform `_merge_tool_items` / Spec #350 interrupt settle).
 */
function mergeToolItemsRecords(
  existingContent: Record<string, unknown>,
  incomingContent: Record<string, unknown>,
  cardStatus: string,
): Array<Record<string, unknown>> | null {
  const eRaw = Array.isArray(existingContent.tool_items) ? existingContent.tool_items : null;
  const iRaw = Array.isArray(incomingContent.tool_items) ? incomingContent.tool_items : null;
  const eItems = (eRaw || []).filter(
    (item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)),
  );
  const iItems = (iRaw || []).filter(
    (item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)),
  );
  if (!eItems.length && !iItems.length) return null;

  const byRun = new Map<string, Record<string, unknown>>();
  const order: string[] = [];
  const push = (item: Record<string, unknown>) => {
    const runId = readString(item.tool_run_id) || `__idx_${order.length}`;
    if (!byRun.has(runId)) {
      order.push(runId);
      byRun.set(runId, { ...item });
      return;
    }
    const prev = byRun.get(runId)!;
    const status = mergeToolLifecycleStatus(prev.status, item.status);
    byRun.set(runId, {
      ...prev,
      ...item,
      command: readString(item.command) || readString(prev.command),
      target: readString(item.target) || readString(prev.target),
      args: item.args ?? prev.args,
      stdout: appendStdout(readString(prev.stdout), readString(item.stdout)),
      evidence_id: item.evidence_id ?? prev.evidence_id,
      summary: mergeToolCardSummary(prev.summary, item.summary, status),
      ...(status ? { status } : { status: "" }),
    });
  };
  for (const item of eItems) push(item);
  for (const item of iItems) push(item);

  // Card-level terminal (interrupt settle) must demote leftover item running —
  // a late progressive frame must not re-light 执行中 under a canceled card.
  const cardN = String(cardStatus || "").trim();
  const cardKind = cardN ? mergeToolLifecycleStatus("running", cardN) : "";
  const forceTerminal = cardKind === "fail" || cardKind === "done" ? cardN : "";

  return order.map((key) => {
    const item = { ...byRun.get(key)! };
    if (!forceTerminal) return item;
    const itemStatus = mergeToolLifecycleStatus(item.status, forceTerminal);
    item.status = itemStatus || forceTerminal;
    if (isProgressiveRunningSummary(item.summary) && (itemStatus === "fail" || cardKind === "fail")) {
      item.summary = "interrupted";
    }
    return item;
  });
}

function mergeToolCardSummary(existing: unknown, incoming: unknown, mergedStatus: string): string {
  const e = readString(existing);
  const i = readString(incoming);
  const statusN = String(mergedStatus || "").trim().toLowerCase();
  const terminalFail = ["fail", "failed", "error", "blocked", "canceled", "cancelled", "interrupted"].includes(statusN);
  const terminalDone = ["done", "ok", "success", "completed", "complete", "saved", "loaded"].includes(statusN);
  // Prefer concrete non-progressive summary; never keep "shell running" once terminal.
  if (terminalFail || terminalDone) {
    if (i && !isProgressiveRunningSummary(i)) return i;
    if (e && !isProgressiveRunningSummary(e)) return e;
    if (terminalFail) return i === "interrupted" || e === "interrupted" ? "interrupted" : (i || e || "interrupted");
    return i || e || "";
  }
  return i || e || "";
}

export function messageRecordFromMessage(message: Message): MessageRecord {
  const content = { ...message.content };
  if (!content.message_id) content.message_id = message.id;
  return {
    id: message.id,
    conversation_id: message.conversation_id,
    role: message.role,
    msg_type: message.msg_type,
    content,
    created_at: message.created_at,
  };
}

function recordContent(record: MessageRecord): Record<string, unknown> {
  return ((record.content || {}) as Record<string, unknown>);
}

export function recordMessageType(record: MessageRecord): string {
  return String(record.msg_type || "text");
}

function recordMessageId(record: MessageRecord): string {
  return readString(record.id) || readString(recordContent(record).message_id);
}

function recordToolRunKey(record: MessageRecord): string {
  return readString(recordContent(record).tool_run_id);
}

function recordStreamId(record: MessageRecord): string {
  return readString(recordContent(record).stream_id);
}

function appendStdout(current: string, incoming: string): string {
  if (!incoming) return current;
  if (!current) return incoming;
  if (current.endsWith(incoming)) return current;
  return `${current}${current.endsWith("\n") ? "" : "\n"}${incoming}`;
}

export function isRenderableMessage(message: Message): boolean {
  // Spec #312: only structured confirm_options decisions are visible bubbles.
  if (message.role === "user" && message.msg_type === "decision") {
    return readString(message.content.decision) === "confirm_options";
  }
  if (message.msg_type === "tool_call") return true;
  // Spec #326 L9: drop infra status (tooling_health-class) from the stream list entirely.
  if (
    message.role === "system" ||
    message.msg_type === "status" ||
    message.msg_type === "engagement_closeout"
  ) {
    return shouldRenderStatusNotice(message);
  }
  if (["text", "confirm_card", "choice_card", "vuln_card", "vuln_found", "asset_card", "asset_discovered", "agent_pending", "thinking", "reasoning", "agent_thinking"].includes(message.msg_type)) return true;
  return false;
}
export function groupConsecutiveToolMessages(messages: Message[]): Message[] {
  const grouped: Message[] = [];
  for (const message of messages) {
    const previous = last(grouped);
    if (!previous || !canGroupToolMessages(previous, message)) {
      grouped.push(message);
      continue;
    }
    grouped[grouped.length - 1] = mergeConsecutiveToolMessage(previous, message);
  }
  return grouped;
}

function canGroupToolMessages(previous: Message, incoming: Message): boolean {
  if (previous.role !== "agent" || incoming.role !== "agent") return false;
  if (previous.msg_type !== "tool_call" || incoming.msg_type !== "tool_call") return false;
  // Same tool type only (shell ≈ 执行命令) → one 「执行命令 N次」card.
  const previousKey = toolFamilyKey(previous.content);
  const incomingKey = toolFamilyKey(incoming.content);
  if (!previousKey || !incomingKey || previousKey !== incomingKey) return false;
  return readString(previous.content.agent_source) === readString(incoming.content.agent_source)
    && readString(previous.content.agent_node_id) === readString(incoming.content.agent_node_id)
    && readString(previous.content.expert_id) === readString(incoming.content.expert_id);
}

function mergeConsecutiveToolMessage(previous: Message, incoming: Message): Message {
  const previousRunIds = toolRunIds(previous);
  const incomingRunId = readString(incoming.content.tool_run_id) || incoming.id;
  const tool_run_ids = previousRunIds.includes(incomingRunId) ? previousRunIds : [...previousRunIds, incomingRunId];
  const tool_names = uniqueMessageStrings([...toolNames(previous), readString(incoming.content.tool_name)]);
  const tool_items = [...toolItems(previous), toolItemForMessage(incoming)];
  return {
    ...previous,
    content: {
      ...previous.content,
      ...incoming.content,
      tool_name: tool_names[0] || previous.content.tool_name || incoming.content.tool_name,
      latest_tool_name: incoming.content.tool_name || previous.content.latest_tool_name || previous.content.tool_name,
      tool_names,
      tool_items,
      tool_run_id: previous.content.tool_run_id || incoming.content.tool_run_id,
      tool_run_ids,
      run_count: tool_run_ids.length,
      command: mergeGroupedCommands(readString(previous.content.command), readString(incoming.content.command)),
      stdout: appendGroupedStdout(readString(previous.content.stdout), readString(incoming.content.stdout)),
      status: mergeGroupedToolStatus(readString(previous.content.status), readString(incoming.content.status)),
    },
    created_at: incoming.created_at || previous.created_at,
  };
}

function toolItems(message: Message): Array<Record<string, unknown>> {
  const existing = message.content.tool_items;
  if (Array.isArray(existing) && existing.length) {
    return existing.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  }
  return [toolItemForMessage(message)];
}

function toolItemForMessage(message: Message): Record<string, unknown> {
  // One flat row payload — ToolCallCard projects detail from command/target/args.
  return {
    tool_name: message.content.tool_name,
    tool_run_id: message.content.tool_run_id || message.id,
    status: message.content.status,
    stdout: message.content.stdout,
    command: message.content.command,
    evidence_id: message.content.evidence_id,
    summary: message.content.summary,
    display_title: message.content.display_title,
    category: message.content.category,
    target: message.content.target,
    args: message.content.args,
    result: message.content.result,
    result_text: message.content.result_text,
  };
}
function toolNames(message: Message): string[] {
  const existing = message.content.tool_names;
  if (Array.isArray(existing)) return existing.map(item => String(item)).filter(Boolean);
  return [readString(message.content.tool_name)].filter(Boolean);
}

function uniqueMessageStrings(values: string[]): string[] {
  return Array.from(new Set(values.map(value => String(value || "").trim()).filter(Boolean)));
}
function toolRunIds(message: Message): string[] {
  const existing = message.content.tool_run_ids;
  if (Array.isArray(existing)) return existing.map(item => String(item)).filter(Boolean);
  return [readString(message.content.tool_run_id) || message.id].filter(Boolean);
}

function mergeGroupedCommands(previous: string, incoming: string): string {
  if (!incoming || previous === incoming) return previous;
  if (!previous) return incoming;
  return `${previous}\n${incoming}`;
}

function appendGroupedStdout(current: string, incoming: string): string {
  if (!incoming) return current;
  if (!current) return incoming;
  if (current.includes(incoming)) return current;
  return `${current}${current.endsWith("\n") ? "\n" : "\n\n"}${incoming}`;
}

function mergeGroupedToolStatus(previous: string, incoming: string): string {
  // Spec #305 R2: prefer fail/done over running; do not invent done/running from empty.
  return mergeToolLifecycleStatus(previous, incoming);
}

