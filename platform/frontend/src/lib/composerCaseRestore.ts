/**
 * Spec #474 S1: restore composer chips from Case snapshot.
 * Partner = Case current Mention; Graph = that Participant Session when the
 * pack declares the id. Composer no longer restores Goal.
 * Case sticky engagement_template is never a restore source.
 */
import { type MentionTarget } from "../components/ChatComposer";
import { packDeclaresEngagementTemplate, type EngagementTemplateId } from "./experts";

export type ComposerRestoreExpert = {
  id: string;
  is_default?: boolean;
  enabled?: boolean;
};

export type ComposerRestoreSnapshot = {
  task_context?: Record<string, unknown> | null;
  sessions?: Record<string, unknown> | null;
  strix_agents?: Array<Record<string, unknown>> | null;
  participants?: Array<Record<string, unknown>> | null;
};

export type ComposerRestore = {
  partner: MentionTarget | null;
  engagementTemplate: EngagementTemplateId | null;
};

export type ComposerSnapshotAction =
  | "ignore"
  | "state_only"
  | "state_and_restore"
  | "keep_restore_pending"
  | "clear_case";

/**
 * Coordinate async Case snapshot results without letting an older request mutate
 * the current Case or letting heartbeat overwrite an already-restored composer.
 */
export function decideComposerSnapshotAction(input: {
  requestedCaseId: string;
  currentCaseId: string | null | undefined;
  outcome: "success" | "failure" | "not_found";
  restoredCaseId: string | null | undefined;
}): ComposerSnapshotAction {
  if (input.currentCaseId !== input.requestedCaseId) return "ignore";
  if (input.outcome === "not_found") return "clear_case";
  if (input.outcome === "failure") return "keep_restore_pending";
  return input.restoredCaseId === input.requestedCaseId
    ? "state_only"
    : "state_and_restore";
}

export function shouldPollConversationSnapshot(input: {
  activeCaseId: string | null;
  running: boolean;
  snapshotLoaded: boolean;
}): boolean {
  return Boolean(input.activeCaseId && (input.running || !input.snapshotLoaded));
}

/**
 * Only the latest Case-open generation may drop the switch skeleton.
 * A transient `/state` failure keeps it up so the first successful snapshot
 * can still finish once-on-open restore.
 */
export function shouldReleaseCaseLoadingSkeleton(input: {
  requestSeq: number;
  latestSeq: number;
  snapshotAction: ComposerSnapshotAction | null;
}): boolean {
  if (input.requestSeq !== input.latestSeq) return false;
  if (input.snapshotAction === "keep_restore_pending") return false;
  if (input.snapshotAction === "ignore") return false;
  return true;
}

/** Chip edits must not complete restore while the Case snapshot is still pending. */
export function shouldAcceptComposerChipOverride(input: {
  activeCaseId: string | null;
  restoredCaseId: string | null | undefined;
}): boolean {
  if (!input.activeCaseId) return true;
  return input.restoredCaseId === input.activeCaseId;
}

export function shouldShowCaseLoadingSkeleton(input: {
  activeCaseId: string | null;
  openingCaseId: string | null;
  messagesLoading: boolean;
}): boolean {
  if (!input.activeCaseId) return false;
  return (
    input.openingCaseId === input.activeCaseId
    || input.messagesLoading
  );
}

export function shouldShowComposerLoadingSkeleton(input: {
  activeCaseId: string | null;
  caseSurfaceLoading: boolean;
  homeRestoreDone: boolean;
  mentionCatalogLoaded: boolean;
  hasSelectableMention: boolean;
  hasSelectedMention: boolean;
}): boolean {
  if (input.activeCaseId) return input.caseSurfaceLoading;
  if (!input.homeRestoreDone || !input.mentionCatalogLoaded) return true;
  return input.hasSelectableMention && !input.hasSelectedMention;
}

/**
 * New-chat / fallback partner (Spec #299: only online / schedulable seats):
 * 1) expert.is_default from 专家管理 (if online)
 * 2) pack_id === default (通用助理, if online)
 * 3) first online target
 */
export function pickDefaultMentionTarget(
  targets: MentionTarget[],
  experts: ComposerRestoreExpert[],
): MentionTarget | null {
  const selectable = targets.filter((t) => t.selectable !== false);
  if (!selectable.length) return null;
  const byId = new Map(experts.map((e) => [e.id, e]));
  const flagged = selectable.find((t) => {
    if (!t.expertId) return false;
    const e = byId.get(t.expertId);
    return Boolean(e?.is_default && e.enabled !== false);
  });
  if (flagged) return flagged;
  const builtin = selectable.find((t) => String(t.packId || "").toLowerCase() === "default");
  if (builtin) return builtin;
  return selectable.find((t) => t.status === "online") || selectable[0] || null;
}

/** Same product Graph ids + aliases as work_mode_settled. Unknown → 不指定. */
export function engagementTemplateFromGraphId(
  graphId: unknown,
): EngagementTemplateId | null {
  const gid = String(graphId || "").trim().toLowerCase();
  if (!gid) return null;
  if (gid === "redteam_deep" || gid === "redteam" || gid === "deep") return "redteam_deep";
  if (gid === "app_assessment" || gid === "assess" || gid === "assessment") {
    return "app_assessment";
  }
  if (gid === "hypothesis_cycle") return "hypothesis_cycle";
  return null;
}

function readTaskContext(snapshot: ComposerRestoreSnapshot): Record<string, unknown> {
  const task = snapshot.task_context;
  return task && typeof task === "object" && !Array.isArray(task) ? task : {};
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sessionRowForExpert(
  snapshot: ComposerRestoreSnapshot,
  expertId: string,
): Record<string, unknown> | null {
  const sessions = asRecord(snapshot.sessions);
  if (sessions) {
    const direct = asRecord(sessions[expertId]);
    if (direct) return direct;
    const alt = asRecord(sessions[`expert:${expertId}`]);
    if (alt) return alt;
  }
  return null;
}

function agentRowForExpert(
  snapshot: ComposerRestoreSnapshot,
  expertId: string,
): Record<string, unknown> | null {
  const rows = [
    ...(Array.isArray(snapshot.strix_agents) ? snapshot.strix_agents : []),
    ...(Array.isArray(snapshot.participants) ? snapshot.participants : []),
  ];
  for (const raw of rows) {
    const row = asRecord(raw);
    if (!row) continue;
    if (String(row.parent_id || "").trim()) continue;
    if (String(row.expert_id || "").trim() === expertId) return row;
  }
  return null;
}

function sessionWorkMode(row: Record<string, unknown> | null): "free" | "graph" | null {
  if (!row) return null;
  const raw = String(row.work_mode || "").trim().toLowerCase();
  if (raw === "free") return "free";
  if (raw === "graph" || raw.startsWith("hard_graph")) return "graph";
  return null;
}

function sessionGraphId(row: Record<string, unknown> | null): string {
  if (!row) return "";
  const gid = String(row.graph_id || "").trim();
  if (gid) return gid;
  const raw = String(row.work_mode || "").trim();
  if (raw.toLowerCase().startsWith("hard_graph:")) {
    return raw.split(":")[1] || "";
  }
  return "";
}

export function restoreComposerFromCaseSnapshot(
  snapshot: ComposerRestoreSnapshot,
  mentionTargets: MentionTarget[],
  experts: ComposerRestoreExpert[],
): ComposerRestore {
  const fallback = pickDefaultMentionTarget(mentionTargets, experts);
  const unspecified: ComposerRestore = {
    partner: fallback,
    engagementTemplate: null,
  };

  const task = readTaskContext(snapshot);
  const expertId = String(task.expert_id || "").trim();
  if (!expertId) return unspecified;

  const partner = mentionTargets.find(
    (t) => t.kind === "expert" && t.expertId === expertId && t.selectable !== false,
  );
  if (!partner) return unspecified;

  const session = sessionRowForExpert(snapshot, expertId);
  const agent = session ? null : agentRowForExpert(snapshot, expertId);
  const row = session || agent;
  const mode = sessionWorkMode(row);
  let engagementTemplate =
    mode === "graph" ? engagementTemplateFromGraphId(sessionGraphId(row)) : null;
  if (engagementTemplate && !packDeclaresEngagementTemplate(partner.packId, engagementTemplate)) {
    engagementTemplate = null;
  }

  return {
    partner,
    engagementTemplate,
  };
}
