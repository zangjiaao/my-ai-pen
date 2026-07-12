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
};

export type RoleResolveInput = {
  /** Explicit structured field from platform/UI. */
  engagement?: string;
  /** Alias for engagement when platform sends role. */
  role?: string;
};
