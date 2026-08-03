/**
 * User authorization cards (platform request_decision / user_input).
 * Agent tools wait here; platform ConfirmCard authorize|cancel OR free-text reply resolves them.
 *
 * Spec #277 §3.3 14a: click and type are the same feedback path into the current Session.
 * Platform forwards raw feedback; this Session tool normalizes cancel vs authorize.
 */

export type ApprovalDecision = "authorize" | "cancel";

export type PendingApproval = {
  resolve: (decision: ApprovalDecision) => void;
  conversationId: string;
  createdAt: number;
};

const pending = new Map<string, PendingApproval>();

/** Structured button / wire values that mean authorize. */
const AUTHORIZE_TOKENS = new Set([
  "authorize",
  "approved",
  "approve",
  "yes",
  "true",
  "1",
  "ok",
  "okay",
]);

/**
 * Explicit cancel tokens only (Session tool side — not platform NLP invent of engagement).
 * Free-text replies that are not cancel mean the user engaged with the card.
 */
const CANCEL_TOKENS = new Set([
  "cancel",
  "cancelled",
  "canceled",
  "reject",
  "rejected",
  "deny",
  "denied",
  "no",
  "false",
  "0",
  "取消",
  "拒绝",
  "不同意",
  "否",
  "不要",
  "算了",
]);

/**
 * Normalize user feedback for request_user_decision.
 * - Button / wire authorize tokens → authorize
 * - Explicit cancel tokens → cancel
 * - Any other non-empty free text → authorize (user replied on the card form)
 * - Empty → cancel
 *
 * This is Session-tool logic for the blocking approval wait only — not platform
 * free-text invent of engagement / mode / pack.
 */
export function normalizeApprovalResponse(response: unknown): ApprovalDecision {
  const raw = String(response ?? "").trim();
  if (!raw) return "cancel";
  const lower = raw.toLowerCase();
  if (AUTHORIZE_TOKENS.has(lower)) return "authorize";
  if (CANCEL_TOKENS.has(lower) || CANCEL_TOKENS.has(raw)) return "cancel";
  // Free-text engagement (e.g. 同意, "go ahead", scope notes) unblocks as authorize.
  return "authorize";
}

/** True when response is a structured button/wire decision (not free-text prose). */
export function isStructuredApprovalResponse(response: unknown): boolean {
  const raw = String(response ?? "").trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  return AUTHORIZE_TOKENS.has(lower) || CANCEL_TOKENS.has(lower) || CANCEL_TOKENS.has(raw);
}

export function registerApprovalWait(
  requestId: string,
  conversationId: string,
): Promise<ApprovalDecision> {
  return new Promise((resolve) => {
    // Replace any prior wait for same id.
    const prev = pending.get(requestId);
    if (prev) prev.resolve("cancel");
    pending.set(requestId, {
      resolve,
      conversationId,
      createdAt: Date.now(),
    });
  });
}

export function resolveApproval(requestId: string, response: unknown): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;
  pending.delete(requestId);
  entry.resolve(normalizeApprovalResponse(response));
  return true;
}

/** Cancel all waits for a conversation (interrupt / settle). */
export function cancelApprovalsForConversation(conversationId: string): void {
  const cid = String(conversationId || "").trim();
  for (const [id, entry] of [...pending.entries()]) {
    if (entry.conversationId === cid) {
      pending.delete(id);
      entry.resolve("cancel");
    }
  }
}

/** Test helper: clear all waits. */
export function clearAllApprovals(): void {
  for (const [, entry] of [...pending.entries()]) {
    entry.resolve("cancel");
  }
  pending.clear();
}
