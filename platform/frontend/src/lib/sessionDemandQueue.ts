/**
 * Spec #277 §3.4 / #313 L11 — Session demand queue chrome.
 * While a Session is in-flight, user text waits at list-tail (below 工作中...)
 * unless force-send (interrupt + apply) or cancel.
 */

export const SESSION_DEMAND_CANCEL_LABEL = "取消";
export const SESSION_DEMAND_EDIT_LABEL = "编辑";
export const SESSION_DEMAND_SEND_LABEL = "发送";
/** Spec #277 §3.4 — same cap as backend MAX_DEMANDS_PER_CASE. */
export const SESSION_DEMAND_MAX_PER_CASE = 5;
export const SESSION_DEMAND_QUEUE_FULL_TITLE = "队列已满（最多 5 条）";

export type SessionDemandKind = "text" | "confirm_options";
export type SessionDemandStatus = "pending" | "cancelled";

export type SessionDemandItem = {
  id: string;
  kind: SessionDemandKind;
  text: string;
  status: SessionDemandStatus;
};

export function newSessionDemandId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `demand-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function upsertQueuedDemand(
  items: SessionDemandItem[],
  next: SessionDemandItem,
): SessionDemandItem[] {
  const id = String(next.id || "").trim();
  if (!id) return items;
  const text = String(next.text || "").trim();
  if (!text && next.status !== "cancelled") return items;
  const idx = items.findIndex((row) => row.id === id);
  if (idx < 0) return [...items, { ...next, id, text: text || next.text }];
  const copy = items.slice();
  copy[idx] = { ...copy[idx], ...next, id, text: text || copy[idx].text };
  return copy;
}

/** Remove after drain / force-send / cancel / edit. */
export function removeQueuedDemand(
  items: SessionDemandItem[],
  demandId: string,
): SessionDemandItem[] {
  const id = String(demandId || "").trim();
  if (!id) return items;
  return items.filter((row) => row.id !== id);
}

/** Drop the row. Cancel and edit both remove chrome — no cancelled ghost. */
export function cancelQueuedDemand(
  items: SessionDemandItem[],
  demandId: string,
): SessionDemandItem[] {
  return removeQueuedDemand(items, demandId);
}

export function pendingQueuedDemands(items: SessionDemandItem[]): SessionDemandItem[] {
  return items.filter((row) => row.status === "pending");
}

export function sessionDemandQueueIsFull(items: SessionDemandItem[]): boolean {
  return pendingQueuedDemands(items).length >= SESSION_DEMAND_MAX_PER_CASE;
}

/** Promote a delivered demand into the same user-bubble identity as a direct send. */
export function queuedDemandUserContent(item: Pick<SessionDemandItem, "id" | "text">): {
  text: string;
  message_id: string;
  client_message_id: string;
} {
  const text = String(item.text || "").trim();
  const id = String(item.id || "").trim();
  return { text, message_id: id, client_message_id: id };
}
