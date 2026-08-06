/**
 * Spec #308 — Worker audit channel filters & scope detect (S-channel).
 *
 * Fail-closed: Worker process frames never render in Main chat.
 * Dialog filters by agent_id (and package_turn_id for the right pane).
 */

export const WORKER_AUDIT_CHANNEL = "worker_audit";

export type MessageLike = {
  id?: string;
  msg_type?: string;
  role?: string;
  content?: Record<string, unknown> | null;
  created_at?: string;
  /** Live WS top-level fields (before content stamp). */
  channel?: string;
  agent_id?: string;
  package_turn_id?: string;
};

/** True when a message/frame belongs on the Worker audit channel (not Main). */
export function isWorkerAuditScoped(msg: MessageLike | null | undefined): boolean {
  if (!msg) return false;
  const content = msg.content && typeof msg.content === "object" ? msg.content : {};
  const channel = String(msg.channel || content.channel || "").trim();
  if (channel === WORKER_AUDIT_CHANNEL) return true;
  const agentId = String(msg.agent_id || content.agent_id || "").trim();
  const turnId = String(msg.package_turn_id || content.package_turn_id || "").trim();
  if (agentId && turnId) return true;
  // Explicit package lifecycle types are always Worker-scoped.
  const t = String(msg.msg_type || "").trim();
  if (t === "worker_package_start" || t === "worker_package_delivery") return true;
  return false;
}

/** Main chat list: drop Worker process / package frames. */
export function filterMainChannelMessages<T extends MessageLike>(messages: T[]): T[] {
  return messages.filter((m) => !isWorkerAuditScoped(m));
}

/** Worker dialog: frames for one agent_id only. */
export function filterWorkerAgentMessages<T extends MessageLike>(
  messages: T[],
  agentId: string,
): T[] {
  const id = String(agentId || "").trim();
  if (!id) return [];
  return messages.filter((m) => {
    if (!isWorkerAuditScoped(m)) return false;
    const content = m.content && typeof m.content === "object" ? m.content : {};
    const aid = String(m.agent_id || content.agent_id || "").trim();
    return aid === id || aid.endsWith(`-${id}`) || id.endsWith(`-${aid}`);
  });
}

/** Right pane: further filter by package_turn_id. */
export function filterWorkerTurnMessages<T extends MessageLike>(
  messages: T[],
  packageTurnId: string,
): T[] {
  const turn = String(packageTurnId || "").trim();
  if (!turn) return [];
  return messages.filter((m) => {
    const content = m.content && typeof m.content === "object" ? m.content : {};
    return String(m.package_turn_id || content.package_turn_id || "").trim() === turn;
  });
}

export function readAgentId(msg: MessageLike): string {
  const content = msg.content && typeof msg.content === "object" ? msg.content : {};
  return String(msg.agent_id || content.agent_id || "").trim();
}

export function readPackageTurnId(msg: MessageLike): string {
  const content = msg.content && typeof msg.content === "object" ? msg.content : {};
  return String(msg.package_turn_id || content.package_turn_id || "").trim();
}
