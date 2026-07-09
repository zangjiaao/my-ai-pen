/**
 * Pure helpers for observed→verify→confirm conversion steering and finish eligibility.
 * Separated from I/O so unit/smoke tests can drive the same shipped predicates.
 */

export type CoverageLikeRow = {
  endpoint?: string;
  param?: string;
  vulnClass?: string;
  status?: string;
  notes?: string;
  count?: number;
  priority?: number;
};

export type ConversionCandidate = {
  endpoint: string;
  param: string;
  vulnClass: string;
  status: string;
  priority: number;
  notes?: string;
  highPriority: boolean;
};

/** Classes that material high-value web checks should not leave as bare `observed`. */
export const HIGH_PRIORITY_VULN_CLASSES = new Set([
  "command-injection",
  "sql-injection",
  "blind-sql-injection",
  "xss-reflected",
  "xss-stored",
  "xss-dom",
  "file-inclusion",
  "file-upload",
  "path-traversal",
  "csrf",
  "brute-force",
  "weak-session-id",
  "javascript-logic",
  "insecure-captcha",
  "csp-bypass",
  "ssrf",
  "idor",
  "auth-bypass",
  "jwt-alg-none",
  "open-redirect",
  "mass-assignment",
  "business-logic",
  "workflow-bypass",
  "access-control",
  "horizontal-access",
  "vertical-access",
]);

/**
 * Generic risk families used for breadth gates. Derived from observed surface shape,
 * never from target product names or benchmark case IDs.
 */
export const RISK_FAMILIES: Array<{
  id: string;
  label: string;
  classes: string[];
  surfaceHints: RegExp;
}> = [
  {
    id: "injection",
    label: "Input injection",
    classes: ["sql-injection", "blind-sql-injection", "command-injection"],
    surfaceHints: /search|query|q=|filter|sort|email|login|id=|user|product|comment/i,
  },
  {
    id: "access_control",
    label: "Access control / object isolation",
    classes: ["idor", "auth-bypass", "mass-assignment"],
    surfaceHints: /\/api\/|\/rest\/|users?|basket|order|account|profile|admin|role|feedback|complaint/i,
  },
  {
    id: "auth_session",
    label: "Authentication / session / token",
    classes: ["jwt-alg-none", "weak-session-id", "brute-force", "auth-bypass"],
    surfaceHints: /login|auth|token|session|jwt|whoami|register|password|oauth/i,
  },
  {
    id: "xss",
    label: "Client-side script sinks",
    classes: ["xss-reflected", "xss-stored", "xss-dom"],
    surfaceHints: /search|q=|name|message|comment|feedback|track|redirect/i,
  },
  {
    id: "file_path",
    label: "File / path handling",
    classes: ["file-inclusion", "file-upload", "path-traversal"],
    surfaceHints: /file|upload|download|ftp|static|image|path|page|include|document/i,
  },
  {
    id: "redirect",
    label: "Open redirect / URL fetch",
    classes: ["open-redirect", "ssrf"],
    surfaceHints: /redirect|returnurl|next=|url=|link=|imageurl|to=/i,
  },
  {
    id: "csrf",
    label: "CSRF / state-changing forms",
    classes: ["csrf"],
    surfaceHints: /password|profile|change|update|delete|post/i,
  },
  {
    id: "business_logic",
    label: "Business logic / workflow abuse",
    classes: ["business-logic", "workflow-bypass", "price-tampering", "javascript-logic"],
    surfaceHints: /order|cart|basket|checkout|payment|coupon|discount|feedback|captcha|quantity|price|rating|review|wallet|transfer|step|quantity/i,
  },
];

const RESOLVED_STATUSES = new Set(["passed", "failed", "blocked", "skipped"]);
const ATTEMPTED_STATUSES = new Set(["tried", "passed", "failed", "blocked", "skipped"]);

export function candidatePriority(vulnClass: string, endpoint = ""): number {
  const klass = String(vulnClass || "").toLowerCase();
  const path = String(endpoint || "").toLowerCase();
  let score = 100;
  if (HIGH_PRIORITY_VULN_CLASSES.has(klass)) score += 100;
  if (["command-injection", "sql-injection", "blind-sql-injection", "file-upload", "file-inclusion", "path-traversal"].includes(klass)) {
    score += 40;
  }
  if (["idor", "jwt-alg-none", "mass-assignment", "auth-bypass"].includes(klass)) score += 35;
  if (["xss-reflected", "xss-stored", "xss-dom", "csrf", "brute-force", "open-redirect"].includes(klass)) score += 25;
  if (path.includes("/admin") || path.includes("login") || path.includes("upload") || path.includes("/api/") || path.includes("/rest/")) {
    score += 15;
  }
  if (/\.(?:css|js|png|jpe?g|gif|ico|svg|woff2?)$/i.test(path)) score -= 200;
  if (["unknown", "info", "technology", "injection", "xss"].includes(klass)) score -= 150;
  return score;
}

export function isHighPriorityCandidate(row: CoverageLikeRow): boolean {
  const endpoint = String(row.endpoint || "");
  const vulnClass = String(row.vulnClass || "");
  if (!endpoint || !vulnClass) return false;
  if (/\.(?:css|js|png|jpe?g|gif|ico|svg|woff2?)$/i.test(endpoint)) return false;
  if (["unknown", "info", "technology"].includes(vulnClass.toLowerCase())) return false;
  const explicit = Number(row.priority);
  if (Number.isFinite(explicit) && explicit > 0) return explicit >= 200;
  return candidatePriority(vulnClass, endpoint) >= 200;
}

export function normalizeCoverageRow(row: CoverageLikeRow): ConversionCandidate | undefined {
  const endpoint = String(row.endpoint || "").trim();
  const param = String(row.param || "").trim() || "-";
  const vulnClass = String(row.vulnClass || "").trim();
  const status = String(row.status || "").trim().toLowerCase();
  if (!endpoint || !vulnClass) return undefined;
  const priority = Number.isFinite(Number(row.priority)) && Number(row.priority) > 0
    ? Number(row.priority)
    : candidatePriority(vulnClass, endpoint);
  return {
    endpoint,
    param,
    vulnClass,
    status,
    priority,
    notes: typeof row.notes === "string" ? row.notes : undefined,
    highPriority: isHighPriorityCandidate({ ...row, priority }),
  };
}

/**
 * High-priority candidates still only `observed` (never tried / resolved).
 * These must be verified or explicitly blocked/skipped before finish_scan(completed).
 */
export function untestedHighPriorityCandidates(rows: CoverageLikeRow[]): ConversionCandidate[] {
  return rows
    .map(normalizeCoverageRow)
    .filter((row): row is ConversionCandidate => Boolean(row))
    .filter((row) => row.highPriority && row.status === "observed")
    .sort((a, b) => b.priority - a.priority || a.endpoint.localeCompare(b.endpoint));
}

export function materialUntestedHighPriority(rows: CoverageLikeRow[]): ConversionCandidate[] {
  return untestedHighPriorityCandidates(rows);
}

export type RiskFamilyGap = {
  family: string;
  label: string;
  suggestedClasses: string[];
  exampleSurfaces: string[];
  reason: string;
};

export type FinishEligibility = {
  allowed: boolean;
  reason: string;
  untestedHighPriority: ConversionCandidate[];
  verifiedAwaitingConfirm: ConversionCandidate[];
  missingRiskFamilies: RiskFamilyGap[];
};

/**
 * finish_scan(status='completed') eligibility depends on engagement:
 * - assess (default): high-priority observed cleared, risk families attempted, multi-actor when surface needs it
 * - verify / retest / consult: do not require full-site conversion; hypothesis-scoped completion is allowed
 */
export function finishCompletedEligibility(
  coverageRows: CoverageLikeRow[],
  options: {
    status?: string;
    confirmedFindings?: string[];
    actorCount?: number;
    /** assess | verify | retest | consult — from explicit task field or workflow actually run */
    engagement?: string;
  } = {},
): FinishEligibility {
  const status = String(options.status || "completed").toLowerCase();
  const engagement = String(options.engagement || "assess").toLowerCase();
  const untested = materialUntestedHighPriority(coverageRows);
  const missingRiskFamilies = missingRiskFamiliesFromCoverage(coverageRows);
  const applyMultiActor = engagement === "assess";
  const multiActorGaps = applyMultiActor ? multiActorTestingGaps(coverageRows, options.actorCount ?? 0) : [];
  const verifiedAwaitingConfirm = coverageRows
    .map(normalizeCoverageRow)
    .filter((row): row is ConversionCandidate => Boolean(row))
    .filter((row) => row.status === "failed" && row.highPriority);

  if (status !== "completed") {
    return {
      allowed: true,
      reason: `finish status ${status} does not require full high-priority conversion`,
      untestedHighPriority: untested,
      verifiedAwaitingConfirm,
      missingRiskFamilies: [...missingRiskFamilies, ...multiActorGaps],
    };
  }

  // Narrow engagements: full-site coverage/family/multi-actor gates do not apply.
  if (engagement === "verify" || engagement === "retest" || engagement === "consult") {
    return {
      allowed: true,
      reason:
        engagement === "consult"
          ? "consult engagement: completed allowed after the question is answered (no full-assessment conversion gates)"
          : `${engagement} engagement: completed allowed when the stated hypothesis/retest outcome is resolved with evidence (no full-site conversion gates)`,
      untestedHighPriority: untested,
      verifiedAwaitingConfirm,
      missingRiskFamilies: [],
    };
  }

  if (untested.length > 0) {
    return {
      allowed: false,
      reason:
        `${untested.length} high-priority observed candidate(s) remain untested. ` +
        `Run verifier/scan/poc/traffic mutate, or mark blocked/skipped with notes before finish_scan(completed). ` +
        `Examples: ${untested.slice(0, 5).map(formatCandidate).join("; ")}`,
      untestedHighPriority: untested,
      verifiedAwaitingConfirm,
      missingRiskFamilies: [...missingRiskFamilies, ...multiActorGaps],
    };
  }

  if (missingRiskFamilies.length > 0) {
    return {
      allowed: false,
      reason:
        `${missingRiskFamilies.length} risk family gap(s) remain for observed attack surface. ` +
        `Test or explicitly skip: ${missingRiskFamilies.map((item) => item.family).join(", ")}. ` +
        `Use verifier for suggested classes or coverage(mark status=blocked/skipped) with notes.`,
      untestedHighPriority: untested,
      verifiedAwaitingConfirm,
      missingRiskFamilies: [...missingRiskFamilies, ...multiActorGaps],
    };
  }

  if (multiActorGaps.length > 0) {
    return {
      allowed: false,
      reason:
        `${multiActorGaps.length} multi-actor / privilege-testing gap(s) remain. ` +
        multiActorGaps.map((item) => item.reason).join(" "),
      untestedHighPriority: untested,
      verifiedAwaitingConfirm,
      missingRiskFamilies: multiActorGaps,
    };
  }

  return {
    allowed: true,
    reason: "no material high-priority observed candidates, risk-family, or multi-actor gaps remain",
    untestedHighPriority: untested,
    verifiedAwaitingConfirm,
    missingRiskFamilies,
  };
}

/**
 * When observed surface looks multi-user/API, require real dual-actor access-control probes.
 * Skipped-only IDOR rows do not satisfy this gate.
 */
export function multiActorTestingGaps(coverageRows: CoverageLikeRow[], actorCount: number): RiskFamilyGap[] {
  const normalized = coverageRows
    .map(normalizeCoverageRow)
    .filter((row): row is ConversionCandidate => Boolean(row));
  if (!normalized.length) return [];

  const surfaceText = normalized.map((row) => `${row.endpoint} ${row.param} ${row.vulnClass}`).join("\n");
  const needsMultiUser = /\/api\/|\/rest\/|users?|basket|order|account|profile|admin|role|feedback|complaint|cart/i.test(surfaceText);
  if (!needsMultiUser) return [];

  const gaps: RiskFamilyGap[] = [];
  if (actorCount < 2) {
    gaps.push({
      family: "multi_actor",
      label: "Multi-identity privilege contexts",
      suggestedClasses: ["idor", "access-control", "business-logic"],
      exampleSurfaces: normalized
        .filter((row) => /\/api\/|\/rest\/|basket|order|users?/i.test(row.endpoint))
        .map((row) => row.endpoint)
        .filter((value, index, arr) => arr.indexOf(value) === index)
        .slice(0, 5),
      reason:
        "Observed multi-user/API surface but fewer than two actors were registered. " +
        "Create two identities with actor(upsert/capture) then retest access-control.",
    });
    return gaps;
  }

  const dualActorProbe = normalized.some(
    (row) =>
      ["idor", "access-control", "horizontal-access", "vertical-access", "business-logic", "auth-bypass"].includes(row.vulnClass.toLowerCase()) &&
      (row.status === "passed" || row.status === "failed") &&
      /dual.?actor|alt_actor|cross.?actor|horizontal|vertical|owner-actor|alt-actor/i.test(row.notes || ""),
  );
  if (!dualActorProbe) {
    gaps.push({
      family: "multi_actor_probe",
      label: "Dual-actor access-control proof",
      suggestedClasses: ["idor", "access-control", "business-logic"],
      exampleSurfaces: normalized
        .filter((row) => /basket|order|users?|account|profile|feedback/i.test(row.endpoint))
        .map((row) => row.endpoint)
        .filter((value, index, arr) => arr.indexOf(value) === index)
        .slice(0, 5),
      reason:
        "Two or more actors exist, but no dual-actor access-control/business-logic verifier result was recorded. " +
        "Run verifier(vuln_class='idor', actor=A, alt_actor=B, object_id=...) or a business-logic probe with two identities.",
    });
  }
  return gaps;
}

/** Infer which risk families the observed endpoints/params suggest, then find unattempted ones. */
export function missingRiskFamiliesFromCoverage(coverageRows: CoverageLikeRow[]): RiskFamilyGap[] {
  const normalized = coverageRows
    .map(normalizeCoverageRow)
    .filter((row): row is ConversionCandidate => Boolean(row));
  if (!normalized.length) return [];

  const surfaceText = normalized
    .map((row) => `${row.endpoint} ${row.param} ${row.vulnClass} ${row.notes || ""}`)
    .join("\n");
  const suggested = RISK_FAMILIES.filter((family) => family.surfaceHints.test(surfaceText));
  if (!suggested.length) return [];

  const attemptedClasses = new Set(
    normalized
      .filter((row) => ATTEMPTED_STATUSES.has(row.status))
      .map((row) => row.vulnClass.toLowerCase()),
  );
  // Explicit family-level skip: coverage row with param="family" or notes containing family id.
  const familyResolved = new Set(
    normalized
      .filter((row) => RESOLVED_STATUSES.has(row.status))
      .filter((row) => row.param === "family" || /risk.?family|family-skip/i.test(row.notes || ""))
      .map((row) => row.vulnClass.toLowerCase()),
  );

  const gaps: RiskFamilyGap[] = [];
  for (const family of suggested) {
    const hit = family.classes.some((klass) => attemptedClasses.has(klass) || familyResolved.has(klass) || familyResolved.has(family.id));
    if (hit) continue;
    const examples = normalized
      .filter((row) => family.surfaceHints.test(`${row.endpoint} ${row.param}`))
      .map((row) => `${row.endpoint}`)
      .filter((value, index, arr) => arr.indexOf(value) === index)
      .slice(0, 5);
    gaps.push({
      family: family.id,
      label: family.label,
      suggestedClasses: family.classes,
      exampleSurfaces: examples,
      reason: `Observed surface suggests ${family.label}, but no coverage attempt was recorded for ${family.classes.join("/")}`,
    });
  }
  return gaps;
}

export type ConversionMetrics = {
  observedCount: number;
  attemptedCount: number;
  resolvedCount: number;
  confirmedCoverageCount: number;
  negativeCoverageCount: number;
  highPriorityObserved: number;
  highPriorityUntested: number;
  highPriorityAttempted: number;
  /** observed high-priority that reached tried/passed/failed/blocked/skipped */
  observedToAttemptedRate: number;
  /** among high-priority that were attempted, share that reached resolved statuses */
  attemptedToResolvedRate: number;
  /** confirmed coverage (status failed = vuln found in Node2 markVerified convention) over high-priority total */
  observedToConfirmedRate: number;
  missList: ConversionCandidate[];
  confirmedList: ConversionCandidate[];
  missingRiskFamilies: RiskFamilyGap[];
};

/**
 * Node2 verifier marks confirmed vulns as coverage status `failed` (security check failed)
 * and negatives as `passed`. Conversion metrics follow that shipped convention.
 */
export function conversionMetrics(coverageRows: CoverageLikeRow[]): ConversionMetrics {
  const normalized = coverageRows
    .map(normalizeCoverageRow)
    .filter((row): row is ConversionCandidate => Boolean(row));
  const high = normalized.filter((row) => row.highPriority);
  const highUntested = high.filter((row) => row.status === "observed");
  const highAttempted = high.filter((row) => ATTEMPTED_STATUSES.has(row.status));
  const highResolved = high.filter((row) => RESOLVED_STATUSES.has(row.status));
  const confirmed = high.filter((row) => row.status === "failed");
  const negatives = high.filter((row) => row.status === "passed");
  const observedCount = normalized.filter((row) => row.status === "observed" || ATTEMPTED_STATUSES.has(row.status)).length;
  const attemptedCount = normalized.filter((row) => ATTEMPTED_STATUSES.has(row.status)).length;
  const resolvedCount = normalized.filter((row) => RESOLVED_STATUSES.has(row.status)).length;

  return {
    observedCount,
    attemptedCount,
    resolvedCount,
    confirmedCoverageCount: confirmed.length,
    negativeCoverageCount: negatives.length,
    highPriorityObserved: high.length,
    highPriorityUntested: highUntested.length,
    highPriorityAttempted: highAttempted.length,
    observedToAttemptedRate: percent(highAttempted.length, high.length),
    attemptedToResolvedRate: percent(highResolved.length, highAttempted.length),
    observedToConfirmedRate: percent(confirmed.length, high.length),
    missList: highUntested.sort((a, b) => b.priority - a.priority),
    confirmedList: confirmed,
    missingRiskFamilies: missingRiskFamiliesFromCoverage(coverageRows),
  };
}

export function formatCandidate(row: ConversionCandidate): string {
  return `${row.vulnClass} @ ${row.endpoint} (${row.param}) p=${row.priority}`;
}

export function nextVerifyGuidance(
  candidates: ConversionCandidate[],
  confirmedEvidenceIds: string[] = [],
  familyGaps: RiskFamilyGap[] = [],
): string {
  const lines: string[] = [];
  if (candidates.length) {
    lines.push(
      `Convert high-priority observed coverage next (${candidates.length} remaining). Prefer verifier for supported classes, else scan/poc/traffic(mutate) with baseline repeat first.`,
    );
    for (const row of candidates.slice(0, 8)) {
      lines.push(`- ${formatCandidate(row)}`);
    }
  }
  if (familyGaps.length) {
    lines.push(`Close risk-family gaps before finish_scan(completed):`);
    for (const gap of familyGaps.slice(0, 8)) {
      lines.push(
        `- ${gap.family} (${gap.label}): try verifier vuln_class in [${gap.suggestedClasses.join(", ")}] on surfaces like ${gap.exampleSurfaces.join(", ") || "observed APIs"}`,
      );
    }
  }
  if (confirmedEvidenceIds.length) {
    lines.push(
      `After verifier confirmed=true, call finding(action='confirm') immediately with evidence_ids=[${confirmedEvidenceIds.join(", ")}] and full reproduction details. Do not batch confirmations for the end.`,
    );
  }
  lines.push(
    "After authentication succeeds, re-inventory authenticated APIs/resources and seed coverage before stopping. Prefer batching verifier calls across priority_candidates rather than stopping after the first confirmed finding.",
  );
  return lines.join("\n");
}

function percent(value: number, total: number): number {
  if (!total) return 0;
  return Math.round((value / total) * 1000) / 10;
}
