/**
 * Spec #301 — Tasks list honesty: cap work items and disclose overflow.
 * Pure helper so unit tests cover +N more / hiddenCount without mounting RightPanel.
 */

/** Default visible work-item cap for Status Tasks (was silent 40). */
export const TASKS_WORK_ITEM_CAP = 80;

/**
 * Slice a sorted work-item list to the display cap.
 * When truncated, hiddenCount is the remainder for "+N more" disclosure.
 */
export function discloseTaskListCap<T>(
  sorted: readonly T[],
  cap: number = TASKS_WORK_ITEM_CAP,
): { items: T[]; hiddenCount: number } {
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : TASKS_WORK_ITEM_CAP;
  if (sorted.length <= limit) {
    return { items: [...sorted], hiddenCount: 0 };
  }
  return {
    items: sorted.slice(0, limit),
    hiddenCount: sorted.length - limit,
  };
}
