/**
 * Pure parsers for optional structured task_assign fields (map #81 F1).
 * Snake_case and camelCase accepted. Never invents values from free-text instruction.
 */

/** Parse optional structured id list. Empty → undefined. */
export function parseStringIdList(raw: unknown): string[] | undefined {
  if (raw == null) return undefined;
  const items: string[] = [];
  if (Array.isArray(raw)) {
    for (const x of raw) {
      const s = String(x ?? "").trim();
      if (s) items.push(s);
    }
  } else if (typeof raw === "string") {
    for (const part of raw.split(",")) {
      const s = part.trim();
      if (s) items.push(s);
    }
  } else {
    return undefined;
  }
  return items.length ? items : undefined;
}

/**
 * Dig-deeper / finding focus ids (F1).
 * Prefer focus_finding_ids; accept legacy retest_finding_ids as alias.
 */
export function parseFocusFindingIds(message: Record<string, unknown>): string[] | undefined {
  return (
    parseStringIdList(message.focus_finding_ids ?? message.focusFindingIds) ??
    parseStringIdList(message.retest_finding_ids ?? message.retestFindingIds)
  );
}

export function parseFocusNote(message: Record<string, unknown>): string | undefined {
  const raw =
    typeof message.focus_note === "string"
      ? message.focus_note
      : typeof message.focusNote === "string"
        ? message.focusNote
        : undefined;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

export type F1FocusFields = {
  focusFindingIds?: string[];
  focusNote?: string;
};

/** Bundle F1 focus fields from a task_assign-shaped message. */
export function parseF1Focus(message: Record<string, unknown>): F1FocusFields {
  const focusFindingIds = parseFocusFindingIds(message);
  const focusNote = parseFocusNote(message);
  const out: F1FocusFields = {};
  if (focusFindingIds) out.focusFindingIds = focusFindingIds;
  if (focusNote) out.focusNote = focusNote;
  return out;
}
