/**
 * User authorization cards (platform request_decision / user_input).
 * Agent tools wait here; platform ConfirmCard authorize|cancel OR free-text reply resolves them.
 *
 * Spec #277 §3.3 14a: click and type are the same feedback path into the current Session.
 * Platform forwards raw feedback; this Session tool normalizes cancel vs authorize.
 * Spec #312: confirm_options + selected_option_ids for next_steps multi-select.
 */

/**
 * authorize/cancel for RoE cards; confirm_options for Spec #312 next_steps multi-select;
 * answered = multi-card free-text freeze of a non-primary wait (unblock without apply).
 */
export type ApprovalDecision = "authorize" | "cancel" | "confirm_options" | "answered";

/** Full wait result for request_user_decision (decision + optional next_steps payload). */
export type ApprovalResult = {
  decision: ApprovalDecision;
  selected_option_ids?: string[];
  workset_item_ids?: string[];
  text?: string;
};

export type ApprovalResolveExtras = {
  selected_option_ids?: unknown;
  workset_item_ids?: unknown;
  text?: unknown;
};

export type PendingApproval = {
  resolve: (result: ApprovalResult) => void;
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

function stringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.map((x) => String(x ?? "").trim()).filter(Boolean);
  return out.length ? out : undefined;
}

/**
 * Normalize user feedback for request_user_decision.
 * - Button / wire authorize tokens → authorize
 * - Explicit cancel tokens → cancel
 * - confirm_options → confirm_options (Spec #312)
 * - answered → answered (Spec #312 L9 secondary free-text freeze; no handoff/graph apply)
 * - Any other non-empty free text → authorize (user replied on the primary card form)
 * - Empty → cancel
 *
 * This is Session-tool logic for the blocking approval wait only — not platform
 * free-text invent of engagement / mode / pack.
 */
export function normalizeApprovalResponse(response: unknown): ApprovalDecision {
  const raw = String(response ?? "").trim();
  if (!raw) return "cancel";
  const lower = raw.toLowerCase();
  // Spec #312: structured multi-select confirm (not free-text invent of engagement).
  if (lower === "confirm_options") return "confirm_options";
  // Multi-card freeze token for non-primary waits (platform secondary response).
  if (lower === "answered") return "answered";
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
  if (lower === "confirm_options" || lower === "answered") return true;
  return AUTHORIZE_TOKENS.has(lower) || CANCEL_TOKENS.has(lower) || CANCEL_TOKENS.has(raw);
}

export function registerApprovalWait(
  requestId: string,
  conversationId: string,
): Promise<ApprovalResult> {
  return new Promise((resolve) => {
    // Replace any prior wait for same id.
    const prev = pending.get(requestId);
    if (prev) prev.resolve({ decision: "cancel" });
    pending.set(requestId, {
      resolve,
      conversationId,
      createdAt: Date.now(),
    });
  });
}

export function resolveApproval(
  requestId: string,
  response: unknown,
  extras?: ApprovalResolveExtras,
): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;
  pending.delete(requestId);
  const decision = normalizeApprovalResponse(response);
  const result: ApprovalResult = { decision };
  const selected = stringList(extras?.selected_option_ids);
  const workset = stringList(extras?.workset_item_ids);
  const text = extras?.text != null ? String(extras.text).trim() : "";
  if (selected) result.selected_option_ids = selected;
  if (workset) result.workset_item_ids = workset;
  if (text) result.text = text;
  entry.resolve(result);
  return true;
}

/** Cancel all waits for a conversation (interrupt / settle). */
export function cancelApprovalsForConversation(conversationId: string): void {
  const cid = String(conversationId || "").trim();
  for (const [id, entry] of [...pending.entries()]) {
    if (entry.conversationId === cid) {
      pending.delete(id);
      entry.resolve({ decision: "cancel" });
    }
  }
}

/** Test helper: clear all waits. */
export function clearAllApprovals(): void {
  for (const [, entry] of [...pending.entries()]) {
    entry.resolve({ decision: "cancel" });
  }
  pending.clear();
}
