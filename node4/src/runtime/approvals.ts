/**
 * User authorization cards (platform request_decision / user_input).
 * Agent tools wait here; platform ConfirmCard authorize|cancel resolves them.
 */
export type PendingApproval = {
  resolve: (decision: "authorize" | "cancel") => void;
  conversationId: string;
  createdAt: number;
};

const pending = new Map<string, PendingApproval>();

export function registerApprovalWait(
  requestId: string,
  conversationId: string,
): Promise<"authorize" | "cancel"> {
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
  const raw = String(response || "").trim().toLowerCase();
  const decision: "authorize" | "cancel" =
    raw === "authorize" || raw === "approved" || raw === "yes" || raw === "true" || raw === "1"
      ? "authorize"
      : "cancel";
  entry.resolve(decision);
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
