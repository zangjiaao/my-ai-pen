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
  "csrf",
  "brute-force",
  "weak-session-id",
  "javascript-logic",
  "insecure-captcha",
  "csp-bypass",
  "ssrf",
  "idor",
  "auth-bypass",
]);

const RESOLVED_STATUSES = new Set(["passed", "failed", "blocked", "skipped"]);
const ATTEMPTED_STATUSES = new Set(["tried", "passed", "failed", "blocked", "skipped"]);

export function candidatePriority(vulnClass: string, endpoint = ""): number {
  const klass = String(vulnClass || "").toLowerCase();
  const path = String(endpoint || "").toLowerCase();
  let score = 100;
  if (HIGH_PRIORITY_VULN_CLASSES.has(klass)) score += 100;
  if (["command-injection", "sql-injection", "blind-sql-injection", "file-upload", "file-inclusion"].includes(klass)) {
    score += 40;
  }
  if (["xss-reflected", "xss-stored", "xss-dom", "csrf", "brute-force"].includes(klass)) score += 25;
  if (path.includes("/admin") || path.includes("login") || path.includes("upload")) score += 15;
  if (/\.(?:css|js|png|jpe?g|gif|ico|svg|woff2?)$/i.test(path)) score -= 200;
  if (["unknown", "info", "technology"].includes(klass)) score -= 150;
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

export type FinishEligibility = {
  allowed: boolean;
  reason: string;
  untestedHighPriority: ConversionCandidate[];
  verifiedAwaitingConfirm: ConversionCandidate[];
};

/**
 * finish_scan(status='completed') is allowed only when no material high-priority
 * observed candidates remain without a tried/resolved/blocked/skipped outcome.
 */
export function finishCompletedEligibility(
  coverageRows: CoverageLikeRow[],
  options: { status?: string; confirmedFindings?: string[] } = {},
): FinishEligibility {
  const status = String(options.status || "completed").toLowerCase();
  const untested = materialUntestedHighPriority(coverageRows);
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
    };
  }

  return {
    allowed: true,
    reason: "no material high-priority observed candidates remain untested",
    untestedHighPriority: untested,
    verifiedAwaitingConfirm,
  };
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
  };
}

export function formatCandidate(row: ConversionCandidate): string {
  return `${row.vulnClass} @ ${row.endpoint} (${row.param}) p=${row.priority}`;
}

export function nextVerifyGuidance(candidates: ConversionCandidate[], confirmedEvidenceIds: string[] = []): string {
  const lines: string[] = [];
  if (candidates.length) {
    lines.push(
      `Convert high-priority observed coverage next (${candidates.length} remaining). Prefer verifier for supported classes, else scan/poc/traffic(mutate) with baseline repeat first.`,
    );
    for (const row of candidates.slice(0, 8)) {
      lines.push(`- ${formatCandidate(row)}`);
    }
  }
  if (confirmedEvidenceIds.length) {
    lines.push(
      `After verifier confirmed=true, call finding(action='confirm') immediately with evidence_ids=[${confirmedEvidenceIds.join(", ")}] and full reproduction details. Do not batch confirmations for the end.`,
    );
  }
  return lines.join("\n");
}

function percent(value: number, total: number): number {
  if (!total) return 0;
  return Math.round((value / total) * 1000) / 10;
}
