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
  /** Human-readable bans for the agent. */
  bans: string[];
  /** Focus hints (not a vuln matrix). */
  focus: string[];
};

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

  const template = known || rawTemplate || rawEng || "app_assessment";

  if (allowPostex) {
    return {
      template,
      allowPostex: true,
      bans: [
        "Out-of-scope hosts and data",
        "Actions outside the authorized RoE / client rules",
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
    bans: [
      "Webshell deployment for persistence",
      "Privilege escalation on the host OS",
      "Persistence mechanisms",
      "Trace cleanup / anti-forensics",
      "Internal lateral movement beyond the application boundary",
      "Out-of-scope hosts and data",
    ],
    focus: [
      "Port and Web/API surface enumeration on provided assets",
      "Conventional web vulnerabilities when observed",
      "Authorization and business-logic issues (e.g. IDOR) with dual actors when possible",
      "Prove impact with HTTP/shell evidence; do not pursue host takeover",
    ],
  };
}

/** Multi-line system/user prompt block for RoE. */
export function formatRoeInjection(roe: RoeFlags): string {
  const lines = [
    "<rules-of-engagement>",
    `Engagement template: ${roe.template}`,
    `allow_postex: ${roe.allowPostex ? "true" : "false"}`,
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
