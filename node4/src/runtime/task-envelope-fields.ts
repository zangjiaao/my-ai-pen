/**
 * Pure parsers for optional structured task_assign fields (map #81 focus envelope).
 * Snake_case and camelCase accepted. Never invents values from free-text instruction.
 */

/**
 * Optional boolean from task_assign wire: true/false or "true"/"false".
 * Other values → undefined (caller leaves field unset so RoE defaults apply).
 */
export function parseOptionalWireBoolean(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

/** RoE allow_postex | allowPostex. Undefined → resolveEngagementRoe derives from template. */
export function parseAllowPostex(message: Record<string, unknown>): boolean | undefined {
  return parseOptionalWireBoolean(message.allow_postex ?? message.allowPostex);
}

/** Spec #139 NC-RoE-Destructive: allow_destructive | allowDestructive. Undefined → default deny. */
export function parseAllowDestructive(message: Record<string, unknown>): boolean | undefined {
  return parseOptionalWireBoolean(message.allow_destructive ?? message.allowDestructive);
}

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

/** Dig-deeper / finding focus ids. Wire: focus_finding_ids | focusFindingIds only. */
export function parseFocusFindingIds(message: Record<string, unknown>): string[] | undefined {
  return parseStringIdList(message.focus_finding_ids ?? message.focusFindingIds);
}

/** Authorized handoff card body — This-turn note only, never the user utterance. */
export function parseHandoffSummary(message: Record<string, unknown>): string | undefined {
  const raw =
    typeof message.handoff_summary === "string"
      ? message.handoff_summary
      : typeof message.handoffSummary === "string"
        ? message.handoffSummary
        : undefined;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
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

export type FocusFields = {
  focusFindingIds?: string[];
  focusNote?: string;
};

/** Bundle focus fields from a task_assign-shaped message. */
export function parseFocusFields(message: Record<string, unknown>): FocusFields {
  const focusFindingIds = parseFocusFindingIds(message);
  const focusNote = parseFocusNote(message);
  const out: FocusFields = {};
  if (focusFindingIds) out.focusFindingIds = focusFindingIds;
  if (focusNote) out.focusNote = focusNote;
  return out;
}
