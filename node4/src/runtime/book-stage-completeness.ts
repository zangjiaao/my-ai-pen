/**
 * validate_book completeness (Spec #139 / #161 / map #188).
 * Pure helpers: captain surface for confirmable Store rows + hybrid empty-book gate.
 */

export const EMPTY_BOOK_ERROR = "empty_book_with_confirmable_feedback_ok";

export type ConfirmableFeedbackOkRow = {
  id: string;
  title?: string;
  severity?: string;
};

/** Book intent or unbookable_on_exit (validate_book-class stages). */
export function isBookingOnlyStage(stage: {
  intent?: string;
  unbookable_on_exit?: boolean;
  id?: string;
}): boolean {
  if (stage.unbookable_on_exit) return true;
  const intent = String(stage.intent || "").toLowerCase();
  if (intent === "book") return true;
  const id = String(stage.id || "").toLowerCase();
  return id === "validate_book" || id.endsWith("_book");
}

/**
 * Hybrid empty-book gate (#190):
 * - confirmable feedback_ok at start > 0 AND store booked delta == 0 → fail
 * - partial book (booked delta > 0) → pass (leftovers may become unbookable)
 * - nothing to book (0 feedback_ok at start) → pass with 0 books
 */
export function evaluateEmptyBookGate(input: {
  isBookStage: boolean;
  confirmableFeedbackOkAtStart: number;
  storeBookedDelta: number;
}): { ok: true } | { ok: false; error: string } {
  if (!input.isBookStage) return { ok: true };
  const n = Math.max(0, Math.floor(input.confirmableFeedbackOkAtStart));
  const booked = Math.max(0, Math.floor(input.storeBookedDelta));
  if (n > 0 && booked === 0) {
    return { ok: false, error: EMPTY_BOOK_ERROR };
  }
  return { ok: true };
}

/** Host captain surface: machine list of confirmable Store rows for book stage Main. */
export function formatFeedbackOkCaptainSurface(rows: ConfirmableFeedbackOkRow[]): string {
  if (!rows.length) {
    return [
      "### Confirmable Finding Store (host)",
      "feedback_ok_n: 0 — nothing to confirm this stage (empty book is OK).",
    ].join("\n");
  }
  const lines = rows.slice(0, 40).map((r, i) => {
    const sev = r.severity ? ` severity=${r.severity}` : "";
    const title = (r.title || "").slice(0, 100);
    return `${i + 1}. finding_id=${r.id}${sev}${title ? ` title=${JSON.stringify(title)}` : ""}`;
  });
  const more = rows.length > 40 ? `\n… +${rows.length - 40} more (use finding(list))` : "";
  return [
    "### Confirmable Finding Store (host)",
    `feedback_ok_n: ${rows.length}`,
    "Main duty: finding(list) then finding(confirm, finding_id=…) for each confirmable row (or honest unbookable only when truly not bookable).",
    "Do **not** invent findings without Store finding_id. Do **not** end with zero confirms while this list is non-empty.",
    ...lines,
    more,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Retry brief when prior attempt hit empty-book fail-closed. */
export function formatEmptyBookRepairBrief(input: {
  stageId: string;
  failedAttempt: number;
  confirmableIds: string[];
}): string {
  const ids = input.confirmableIds.slice(0, 24).join(", ") || "(re-list via finding(list))";
  return [
    "### Host book-stage repair brief (empty book)",
    `stage_id: ${input.stageId}`,
    `failed_attempt: ${input.failedAttempt}`,
    `error: ${EMPTY_BOOK_ERROR}`,
    "Prior attempt booked 0 while confirmable feedback_ok remained.",
    "Required: finding(list) then finding(confirm, finding_id=…) for Store rows below (or subset with proof).",
    `confirmable_ids: ${ids}`,
  ].join("\n");
}
