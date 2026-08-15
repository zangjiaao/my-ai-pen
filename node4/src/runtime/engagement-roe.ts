/**
 * Structured engagement template → RoE (rules of engagement) for agent prompts.
 * Pure mapping — no free-text NLP, no target-name detection.
 *
 * Templates (product language):
 * - app_assessment: pre-prod / scoped app test; post-ex OFF
 * - redteam_deep: authorized deep path; post-ex ON within scope
 *
 * Pack selection remains separate (pentest / ctf / …). Templates may be aliases
 * of the pentest pack for dispatch; RoE still uses the template string.
 */

export type EngagementTemplateId = "app_assessment" | "redteam_deep" | string;

export type RoeFlags = {
  /** Canonical template when recognized; else raw engagement/template string. */
  template: string;
  /** Whether post-exploitation / lateral host control is in scope. */
  allowPostex: boolean;
  /**
   * Spec #139 NC-RoE-Destructive: destructive tests denied unless explicitly allowed.
   * Customer product default is false; lab may set allow_destructive / allowDestructive.
   */
  allowDestructive: boolean;
  /** Human-readable bans for the agent. */
  bans: string[];
  /** Focus hints (not a vuln matrix). */
  focus: string[];
};

/** Destructive action classes that need explicit RoE allow (NC-RoE-Destructive). */
export const DESTRUCTIVE_ACTION_CLASSES = [
  "db_wipe_reset",
  "bulk_delete_overwrite",
  "dos_flood",
  "password_state_change",
  "privilege_elevation_attack",
] as const;

export type DestructiveActionClass = (typeof DESTRUCTIVE_ACTION_CLASSES)[number];

/**
 * Whether a described action is default-destructive (needs allow).
 * Conservative keyword steer for host gates — not target-specific.
 */
export function classifyDestructiveAction(description: string): {
  destructive: boolean;
  classes: DestructiveActionClass[];
} {
  const t = String(description || "").toLowerCase();
  const classes: DestructiveActionClass[] = [];
  if (
    /reset\s*(db|database)|drop\s+table|truncate\s+|setup\.php|create\s+database|wipe\s+(db|database|data)/i.test(
      t,
    )
  ) {
    classes.push("db_wipe_reset");
  }
  if (/bulk\s+delete|rm\s+-rf|overwrite\s+all|mass\s+delete|delete\s+all\s+users/i.test(t)) {
    classes.push("bulk_delete_overwrite");
  }
  if (/\b(dos|denial.of.service|flood|resource\s+exhaust)/i.test(t)) {
    classes.push("dos_flood");
  }
  if (/change\s+.*password|reset\s+password|force\s+password/i.test(t)) {
    classes.push("password_state_change");
  }
  if (/privilege\s+escalat|grant\s+admin|make\s+admin|elevate\s+priv/i.test(t)) {
    classes.push("privilege_elevation_attack");
  }
  return { destructive: classes.length > 0, classes };
}

/**
 * Gate destructive actions. Default deny unless RoE allowDestructive.
 * When denied, caller should not execute and may record skipped_roe.
 */
export function assertDestructiveAllowed(
  roe: RoeFlags,
  description: string,
): { ok: true } | { ok: false; error: string; classes: DestructiveActionClass[] } {
  const { destructive, classes } = classifyDestructiveAction(description);
  if (!destructive) return { ok: true };
  if (roe.allowDestructive) return { ok: true };
  return {
    ok: false,
    classes,
    error:
      `destructive action denied by RoE (classes=${classes.join(",")}). ` +
      `Do not execute; record skipped_roe. Capability may book via non-destructive observation only. ` +
      `(Spec #139 NC-RoE-Destructive; default deny)`,
  };
}

const TEMPLATE_ALIASES: Record<string, "app_assessment" | "redteam_deep"> = {
  app_assessment: "app_assessment",
  assessment: "app_assessment",
  assess: "app_assessment",
  "pre-prod": "app_assessment",
  preprod: "app_assessment",
  redteam_deep: "redteam_deep",
  redteam: "redteam_deep",
  "red-team": "redteam_deep",
  deep: "redteam_deep",
};

/**
 * Resolve RoE from structured envelope fields only.
 * @param engagementTemplate - UI template id (preferred)
 * @param engagement - may be pack id or template alias
 * @param allowPostex - explicit override; null/undefined → derive from template
 */
export function resolveEngagementRoe(input: {
  engagementTemplate?: string | null;
  engagement?: string | null;
  allowPostex?: boolean | null;
  /** Explicit RoE allow for destructive tests (lab). Default false. */
  allowDestructive?: boolean | null;
}): RoeFlags {
  const rawTemplate = String(input.engagementTemplate || "").trim().toLowerCase();
  const rawEng = String(input.engagement || "").trim().toLowerCase();
  const key = rawTemplate || rawEng;
  const known = TEMPLATE_ALIASES[key];

  let allowPostex: boolean;
  if (typeof input.allowPostex === "boolean") {
    allowPostex = input.allowPostex;
  } else if (known === "redteam_deep") {
    allowPostex = true;
  } else {
    // Conservative default: post-ex off (including blank / unknown / plain "pentest")
    allowPostex = false;
  }

  // Spec #139 NC-RoE: destructive default deny; lab must set explicitly
  const allowDestructive =
    typeof input.allowDestructive === "boolean" ? input.allowDestructive : false;

  const template = known || rawTemplate || rawEng || "app_assessment";

  const destructiveBan =
    "Destructive tests (DB wipe/reset, bulk delete, DoS/flood, password state-change on others, privilege elevation attacks) unless allow_destructive=true";

  if (allowPostex) {
    return {
      template,
      allowPostex: true,
      allowDestructive,
      bans: [
        "Out-of-scope hosts and data",
        "Actions outside the authorized RoE / client rules",
        ...(allowDestructive ? [] : [destructiveBan]),
      ],
      focus: [
        "External surface discovery within scope",
        "Hypothesis-driven exploit of observed surfaces",
        "Post-exploitation and lateral movement only within authorized scope",
        "Evidence-backed booking for each proven issue",
      ],
    };
  }

  return {
    template,
    allowPostex: false,
    allowDestructive,
    bans: [
      "Webshell deployment for persistence",
      "Privilege escalation on the host OS",
      "Persistence mechanisms",
      "Trace cleanup / anti-forensics",
      "Internal lateral movement beyond the application boundary",
      "Out-of-scope hosts and data",
      ...(allowDestructive ? [] : [destructiveBan]),
    ],
    focus: [
      "Port and Web/API surface enumeration on provided assets",
      "Conventional web vulnerabilities when observed",
      "Authorization and business-logic issues (e.g. IDOR) with dual actors when possible",
      "Prove impact with HTTP/shell evidence; do not pursue host takeover",
      "When destructive capability is observed but RoE denies: record skipped_roe; book entry-point without performing wipe",
    ],
  };
}

/** Multi-line system/user prompt block for RoE. */
export function formatRoeInjection(roe: RoeFlags): string {
  const lines = [
    "<rules-of-engagement>",
    `Engagement template: ${roe.template}`,
    `allow_postex: ${roe.allowPostex ? "true" : "false"}`,
    `allow_destructive: ${roe.allowDestructive ? "true" : "false"}`,
    "",
    "Focus:",
    ...roe.focus.map((f) => `- ${f}`),
    "",
    "Forbidden unless explicitly authorized in this RoE (currently banned):",
    ...roe.bans.map((b) => `- ${b}`),
    "",
    roe.allowPostex
      ? "Post-exploitation skills (host control, privesc, lateral) may be used only inside the authorized scope and recorded with evidence."
      : "Do NOT use post-exploitation / lateral host-control techniques. Application-layer proof is sufficient. Prefer skills: surface-enum, authz-logic, recon — not postex-host or lateral.",
    roe.allowDestructive
      ? "Destructive tests are allowed within Scope; still require proof bar / L0 for booking."
      : "Destructive tests are DENIED by default. If a destructive entry point is found, record surface note=skipped_roe and do not execute wipe/flood/bulk-delete. Book capability only with non-destructive proof.",
    "Do not invent target answer keys or fixed vulnerability checklists.",
    "</rules-of-engagement>",
  ];
  return lines.join("\n");
}

/** True if string looks like a known template (not a free-text invent). */
export function isKnownEngagementTemplate(value: string | null | undefined): boolean {
  const key = String(value || "")
    .trim()
    .toLowerCase();
  return Boolean(TEMPLATE_ALIASES[key]);
}
