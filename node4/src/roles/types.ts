/**
 * Role packs: explicit structured engagement/role → prompt + tool surface + booking posture.
 * Routing MUST NOT scan free-text instructions (Agents.md).
 */

export type BookingMode = "finding" | "none";

export type RolePack = {
  /** Stable id used in TaskEnvelope.engagement / .role */
  id: string;
  label: string;
  /** Prepended mission lines for system prompt. */
  missionLines: string[];
  /** How-to-work lines (after mission). */
  workLines: string[];
  /** Tool names registered for this pack (subset of node4 tools). */
  toolNames: readonly string[];
  bookingMode: BookingMode;
  /** Settlement still harness-owned; pack only documents posture. */
  settlementNote: string;
  /**
   * Optional default long-task objective when goal mode is on but the task
   * envelope did not supply goalObjective (structured field only — not NLP).
   */
  defaultGoalObjective?: string;
  /** Skill ids surfaced by skill(list) for this pack (load on demand). */
  skillIds?: readonly string[];
  /** Relative recipe dir under node4 root (e.g. recipes/ctf). */
  recipeDir?: string;
};

export type RoleResolveInput = {
  /** Explicit structured field from platform/UI. */
  engagement?: string;
  /** Alias for engagement when platform sends role. */
  role?: string;
};
