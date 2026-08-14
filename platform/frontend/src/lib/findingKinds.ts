/**
 * Finding classification for Surface chips and Findings tab.
 */
import type { SecurityVulnerability } from "./securityTypes";

export type SurfaceFindingTag = {
  id: string;
  kind: "vuln" | "flag" | "key";
  /** Short chip text shown on the tree row. */
  label: string;
  title: string;
  severity?: string;
  finding: Record<string, unknown>;
};


export type FindingKindId = "vuln" | "auth" | "flag";

export type FindingKindGroup = {
  id: FindingKindId;
  label: string;
  shortLabel: string;
  hint: string;
  badgeClass: string;
  items: Array<Record<string, unknown>>;
};

export function normalizeFindingSeverity(value: unknown): "critical" | "high" | "medium" | "low" | "info" {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "critical" || raw === "high" || raw === "medium" || raw === "low" || raw === "info") return raw;
  return "medium";
}

export function toSurfaceFindingTagForKind(
  finding: Record<string, unknown>,
  path: string,
  index: number,
  kindId: FindingKindId,
  kindIndex = 0,
): SurfaceFindingTag {
  const kind: SurfaceFindingTag["kind"] = kindId === "flag" ? "flag" : kindId === "auth" ? "key" : "vuln";
  const severity = normalizeFindingSeverity(finding.severity);
  // Vuln: severity only. Flag: Flag. Key: PASSWORD/JWT/APIKEY/…
  const label =
    kind === "flag" ? "Flag" : kind === "key" ? classifyAuthSubtype(finding).label : severity;
  const flagToken = kind === "flag" ? extractFlagFromFinding(finding) : undefined;
  const title = String(flagToken || finding.title || "Finding").trim();
  const baseId = String(finding.id || finding.vulnerability_id || finding.finding_id || `finding-${index}`);
  const id = `${baseId}:${kind}:${kindIndex}`.slice(0, 160);
  return {
    id,
    kind,
    label,
    title,
    severity,
    finding,
  };
}

export function findingTagClass(tag: SurfaceFindingTag): string {
  if (tag.kind === "flag") return "bg-status-success/15 text-status-success";
  if (tag.kind === "key") return classifyAuthSubtype(tag.finding).badgeClass;
  return severityBadgeClass(tag.severity);
}

/** Open detail with the chip's category so FLAG does not open as Vulnerability detail. */
export function openFindingFromTag(tag: SurfaceFindingTag): Partial<SecurityVulnerability> {
  const kind = tag.kind === "key" ? "auth" : tag.kind;
  return {
    ...(tag.finding as Partial<SecurityVulnerability>),
    finding_kind: kind,
    kind,
    category: kind,
    __surface_kind: tag.kind,
  } as Partial<SecurityVulnerability>;
}

/**
 * True only for values that look like real URL paths / endpoints.
 * Rejects free-text finding titles, probe notes, and English sentences.
 */



function severityRank(severity: unknown): number {
  const s = normalizeFindingSeverity(severity);
  if (s === "critical") return 0;
  if (s === "high") return 1;
  if (s === "medium") return 2;
  if (s === "low") return 3;
  return 4; // info
}

/** Vuln list: critical → high → medium → low → info; stable title tie-break. */
export function sortFindingsBySeverity(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return [...items].sort((a, b) => {
    const bySev = severityRank(a.severity) - severityRank(b.severity);
    if (bySev !== 0) return bySev;
    return String(a.title || "").localeCompare(String(b.title || ""));
  });
}

export function groupFindingsByKind(findings: Array<Record<string, unknown>>): FindingKindGroup[] {
  // Exclusive: each finding is exactly one of Vuln | Key | Flag (independent objects).
  const buckets: Record<FindingKindId, Array<Record<string, unknown>>> = { vuln: [], auth: [], flag: [] };
  for (const finding of findings) {
    buckets[classifyFindingKind(finding)].push(finding);
  }
  return [
    {
      id: "vuln",
      label: "Vuln",
      shortLabel: "Vuln",
      hint: "by severity",
      badgeClass: "bg-severity-high-subtle text-severity-high",
      items: sortFindingsBySeverity(buckets.vuln),
    },
    {
      id: "auth",
      label: "Key",
      shortLabel: "Key",
      hint: "password · jwt · apikey · …",
      // Default; row badges use classifyAuthSubtype (cool palette, not severity red).
      badgeClass: "bg-status-running/10 text-status-running",
      items: buckets.auth,
    },
    {
      id: "flag",
      label: "Flags",
      shortLabel: "Flag",
      hint: "CTF / challenge tokens",
      badgeClass: "bg-status-success/15 text-status-success",
      items: buckets.flag,
    },
  ];
}

export function findingsTabHoverTitle(groups: FindingKindGroup[]): string {
  const parts = groups.filter((g) => g.items.length > 0).map((g) => `${g.label} ${g.items.length}`);
  return parts.length ? parts.join(" · ") : "Findings";
}

function findingTextBlob(finding: Record<string, unknown>): string {
  return [
    finding.title,
    finding.description,
    finding.impact,
    finding.poc,
    finding.reproduction,
    finding.location,
    finding.flag_value,
  ]
    .map((v) => String(v || ""))
    .join("\n");
}

function hasFlagInFinding(finding: Record<string, unknown>): boolean {
  return Boolean(extractFlagFromFinding(finding));
}

function hasAuthInFinding(finding: Record<string, unknown>): boolean {
  const blob = findingTextBlob(finding);
  return (
    /\b(api[_-]?key|access[_-]?key|secret[_-]?key|aws[_-]?secret|private[_-]?key|akia[0-9a-z]{12,})\b/i.test(blob) ||
    /\b(password|passwd|pwd|credential|credentials)\b/i.test(blob) ||
    /\b(ak\/sk|accesskeyid|secretaccesskey)\b/i.test(blob) ||
    /\b(jwt|bearer\s+[a-z0-9._\-]+|session[_-]?id|cookie)\b/i.test(blob)
  );
}

/** Severity chip styles (vuln rows — no separate VULN badge). */
export function severityBadgeClass(severity: unknown): string {
  const s = normalizeFindingSeverity(severity);
  if (s === "critical") return "bg-severity-critical-subtle text-severity-critical";
  if (s === "high") return "bg-severity-high-subtle text-severity-high";
  if (s === "medium") return "bg-severity-medium-subtle text-severity-medium";
  if (s === "low") return "bg-severity-low-subtle text-severity-low";
  return "bg-severity-info-subtle text-severity-info";
}

type AuthSubtype = {
  label: string;
  badgeClass: string;
};

/** Theme tokens — light / html.dark pairs in index.css. Do not use light-only hex. */
export const AUTH_BADGE = {
  JWT: "bg-status-running/12 text-status-running",
  APIKEY: "bg-key-apikey-subtle text-key-apikey",
  PASSWORD: "bg-key-password-subtle text-key-password",
  SESSION: "bg-key-session-subtle text-key-session",
  TOKEN: "bg-key-token-subtle text-key-token",
  SECRET: "bg-key-secret-subtle text-key-secret",
  KEY: "bg-status-running/10 text-status-running",
} as const;

/**
 * Key subtype badge: PASSWORD / JWT / APIKEY / … — cool palette, not vuln severity reds.
 */
function classifyAuthSubtype(finding: Record<string, unknown>): AuthSubtype {
  const blob = findingTextBlob(finding).toLowerCase();
  // Order: more specific first.
  if (/\bjwt\b|\bjson\s*web\s*token\b|\beyj[a-z0-9_-]+\.[a-z0-9_-]+/i.test(blob)) {
    return { label: "JWT", badgeClass: AUTH_BADGE.JWT };
  }
  if (
    /\b(api[_-]?key|access[_-]?key|secret[_-]?key|akia[0-9a-z]{12,}|accesskeyid|secretaccesskey|ak\/sk)\b/i.test(blob)
  ) {
    return { label: "APIKEY", badgeClass: AUTH_BADGE.APIKEY };
  }
  if (/\b(password|passwd|pwd|口令|密码)\b/i.test(blob)) {
    return { label: "PASSWORD", badgeClass: AUTH_BADGE.PASSWORD };
  }
  if (/\b(session[_-]?id|session[_-]?token|phpsessid|jsessionid)\b/i.test(blob)) {
    return { label: "SESSION", badgeClass: AUTH_BADGE.SESSION };
  }
  if (/\b(bearer\s+[a-z0-9._\-]{8,}|oauth|refresh[_-]?token|access[_-]?token)\b/i.test(blob)) {
    return { label: "TOKEN", badgeClass: AUTH_BADGE.TOKEN };
  }
  if (/\b(private[_-]?key|secret|credential|credentials)\b/i.test(blob)) {
    return { label: "SECRET", badgeClass: AUTH_BADGE.SECRET };
  }
  return { label: "KEY", badgeClass: AUTH_BADGE.KEY };
}

function hasVulnSignalsInFinding(finding: Record<string, unknown>): boolean {
  if (finding.cwe && String(finding.cwe).trim()) return true;
  const title = String(finding.title || "");
  // Flag · cards may embed challenge names like "Reflected XSS" — that is not a Vuln kind.
  if (/^flag\s*[·•:：\-–—]/i.test(title) || /^flag\s+/i.test(title) || /^flag\{/i.test(title)) {
    return false;
  }
  const blob = findingTextBlob(finding);
  return (
    /\b(sql\s*injection|sqli|xss|cross[- ]site|rce|remote\s*code|command\s*injection|ssrf|lfi|rfi|xxe|ssti|idor|path\s*traversal|file\s*upload|deserialization|csrf|open\s*redirect|auth(?:entication|orization)?\s*(?:bypass|flaw)|privilege\s*escalation|insecure|vulnerability|漏洞|注入|越权)\b/i.test(
      title,
    ) || /\b(sql\s*injection|sqli|reflected\s*xss|stored\s*xss|rce|ssrf|cwe-\d+)\b/i.test(blob)
  );
}

function normalizeExplicitKind(finding: Record<string, unknown>): FindingKindId | undefined {
  const explicit = String(finding.finding_kind || finding.kind || finding.category || "")
    .trim()
    .toLowerCase();
  if (["vuln", "vulnerability", "vulns"].includes(explicit)) return "vuln";
  if (
    ["auth", "credential", "credentials", "secret", "secrets", "password", "apikey", "api_key", "aksk", "key"].includes(
      explicit,
    )
  ) {
    return "auth";
  }
  if (["flag", "flags", "ctf"].includes(explicit)) return "flag";
  return undefined;
}

/** Exclusive kinds: vuln | auth(key) | flag — Flag · titles and finding_kind=flag always win. */
export function classifyFindingKind(finding: Record<string, unknown>): FindingKindId {
  const explicit = normalizeExplicitKind(finding);
  if (explicit) return explicit;

  const title = String(finding.title || "").trim();
  if (/^flag\{[^{}\n]{2,120}\}$/i.test(title) || /^FLAG\{[^{}\n]{2,120}\}$/.test(title)) return "flag";
  if (/^flag\s*[·•:：\-–—]/i.test(title) || /^flag\s+/i.test(title)) return "flag";

  const flagPresent = hasFlagInFinding(finding);
  const vulnish = hasVulnSignalsInFinding(finding);
  const authish = hasAuthInFinding(finding);

  if (flagPresent && !vulnish) {
    if (/\b(?:ctf\s*)?flag\b/i.test(title) || /^flag\{/i.test(title) || !authish) return "flag";
  }
  if (authish && !vulnish) return "auth";
  return "vuln";
}

function extractFlagFromFinding(finding: Record<string, unknown>): string | undefined {
  const direct = String(finding.flag_value || "").trim();
  if (direct) return direct;
  const blob = [finding.title, finding.description, finding.poc, finding.reproduction, finding.impact]
    .map((v) => String(v || ""))
    .join("\n");
  const m = blob.match(/flag\{[^{}\n]{2,120}\}/i) || blob.match(/FLAG\{[^{}\n]{2,120}\}/);
  return m ? m[0] : undefined;
}

export function dedupeFindingTags(tags: SurfaceFindingTag[]): SurfaceFindingTag[] {
  const seen = new Set<string>();
  const out: SurfaceFindingTag[] = [];
  for (const tag of tags) {
    if (seen.has(tag.id)) continue;
    seen.add(tag.id);
    out.push(tag);
  }
  return out;
}

