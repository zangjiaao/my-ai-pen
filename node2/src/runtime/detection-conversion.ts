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
const VERIFIED_STATUSES = new Set(["passed", "failed", "blocked"]);

/** Minimum notes length for a skip/block to count as resolving high-priority coverage. */
export const SUBSTANTIVE_NOTE_MIN = 24;

/**
 * Skip/block notes must explain a real constraint. Generic placeholders do not satisfy finish gates.
 * Patterns are generic harness language — not target-specific challenge answers.
 */
const SUBSTANTIVE_SKIP_REASON_RE =
  /credential|auth|scope|login|mfa|captcha|rate.?limit|tooling|timeout|not.?applicable|\bn\/a\b|no\s+(endpoint|surface|param|signal)|false.?positive|cannot|unable|blocked|risk.?family|family-skip|out.?of.?scope|duplicate|same.?class|covered.?by|browser|playwright|unavailable|not.?testable|no.?write|read.?only|static|spa\b|404|403|401|denied|missing|unsupported|no.?traffic|recon|inventory|multi.?actor|dual.?actor|already.?verified|same.?authz|pattern.?covered/i;

const STATIC_ASSET_RE = /\.(?:css|js|mjs|map|png|jpe?g|gif|ico|svg|woff2?|ttf|eot|mp4|webm|webp|avif)(?:$|\?)/i;

/** Scanner placeholders, bare API roots, SPA shells — not real testable resources. */
const NOISE_ENDPOINT_RE =
  /(?:^|\/)(?:fuzz|\{fuzz\}|placeholder|wordlist|null|undefined)(?:\/|$)|\/\.\.?$|^\/\.?$/i;
const BARE_API_ROOT_RE = /^\/(?:api|rest|graphql|v\d+)\/?$/i;

const ACCESS_CONTROL_CLASSES = new Set([
  "idor",
  "access-control",
  "horizontal-access",
  "vertical-access",
  "business-logic",
  "auth-bypass",
]);

/**
 * Paths that should not seed high-priority coverage or multi-actor breadth.
 * Generic (not product-specific): fuzz placeholders, bare API prefixes, static assets.
 */
export function isNoiseEndpoint(endpoint: string): boolean {
  const path = normalizeEndpointKey(endpoint);
  if (!path || path === "-" || path.startsWith("/family/")) return true;
  if (STATIC_ASSET_RE.test(path)) return true;
  if (NOISE_ENDPOINT_RE.test(path)) return true;
  if (BARE_API_ROOT_RE.test(path)) return true;
  // Single-segment junk like "/." or truncated fragments from scanners.
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return true;
  if (segments.length === 1 && segments[0]!.length <= 2) return true;
  if (segments.some((seg) => /^fuzz$/i.test(seg) || seg === "*" || seg === "%2a")) return true;
  return false;
}

/** Prefer object-like API collections for dual-actor / IDOR breadth counting. */
export function isObjectLikeResourcePath(endpoint: string): boolean {
  if (isNoiseEndpoint(endpoint)) return false;
  const path = normalizeEndpointKey(endpoint).toLowerCase();
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2) return false;
  // Drop pure search/login/auth utility paths from "object resource" breadth.
  if (/(?:^|\/)(?:search|login|register|signup|whoami|auth|oauth|token|metrics|health|version)(?:\/|$)/i.test(path)) {
    return false;
  }
  if (/(?:users?|accounts?|profiles?|baskets?|carts?|orders?|feedbacks?|reviews?|comments?|products?|items?|files?|documents?|messages?|tickets?)/i.test(path)) {
    return true;
  }
  // /api|rest/<Collection>(/<id>)?
  if (/^\/(?:api|rest|graphql)\//i.test(path) && segments.length >= 2) return true;
  return false;
}

/** Optional traffic inventory used for attack-surface quality gates (assess only). */
export type SurfaceInventory = {
  trafficCount?: number;
  trafficEndpointCount?: number;
  trafficCandidateCount?: number;
  /** Distinct meaningful paths from traffic.endpoints() when available. */
  trafficPaths?: string[];
  /** Sample high-value candidate URLs from traffic.candidates(). */
  trafficCandidateUrls?: string[];
};

/** One mid-run live-probe work item (discovery queue), independent of finish eligibility. */
export type DiscoveryWorkItem = {
  id: string;
  priority: number;
  kind: "multi_actor" | "risk_family" | "coverage_candidate" | "traffic_expand" | "post_confirm_breadth";
  title: string;
  toolHint: string;
  endpoint?: string;
  vulnClass?: string;
  family?: string;
  rationale: string;
};

/** Build surface inventory from a traffic-store-like object (avoids tool-layer coupling). */
export function surfaceInventoryFromTraffic(traffic?: {
  list?: (filter?: { limit?: number }) => unknown[];
  endpoints?: () => unknown[];
  candidates?: (limit?: number) => unknown[];
} | null): SurfaceInventory {
  if (!traffic) {
    return { trafficCount: 0, trafficEndpointCount: 0, trafficCandidateCount: 0, trafficPaths: [], trafficCandidateUrls: [] };
  }
  const list = typeof traffic.list === "function" ? traffic.list({ limit: 500 }) : [];
  const endpoints = typeof traffic.endpoints === "function" ? traffic.endpoints() : [];
  const candidates = typeof traffic.candidates === "function" ? traffic.candidates(50) : [];
  const trafficPaths = uniqueStrings(
    (Array.isArray(endpoints) ? endpoints : [])
      .map((row: any) => String(row?.endpoint || row?.path || "").trim())
      .filter((path) => path && !isNoiseEndpoint(path)),
  );
  const trafficCandidateUrls = uniqueStrings(
    (Array.isArray(candidates) ? candidates : [])
      .map((row: any) => String(row?.url || "").trim())
      .filter(Boolean)
      .slice(0, 20),
  );
  return {
    trafficCount: Array.isArray(list) ? list.length : 0,
    trafficEndpointCount: Array.isArray(endpoints) ? endpoints.length : trafficPaths.length,
    trafficCandidateCount: Array.isArray(candidates) ? candidates.length : 0,
    trafficPaths,
    trafficCandidateUrls,
  };
}

export function isSubstantiveSkipNotes(notes?: string): boolean {
  const text = String(notes || "").trim();
  if (text.length < SUBSTANTIVE_NOTE_MIN) return false;
  return SUBSTANTIVE_SKIP_REASON_RE.test(text);
}

/** High-priority skip/block that is allowed to close a candidate for finish eligibility. */
export function isEffectivelyResolved(row: ConversionCandidate): boolean {
  if (VERIFIED_STATUSES.has(row.status)) return true;
  if (row.status === "skipped") return isSubstantiveSkipNotes(row.notes);
  return false;
}

export function isEffectivelyAttempted(row: ConversionCandidate): boolean {
  if (row.status === "tried" || VERIFIED_STATUSES.has(row.status)) return true;
  if (row.status === "skipped") return isSubstantiveSkipNotes(row.notes);
  return false;
}

export function isMeaningfulEndpoint(endpoint: string): boolean {
  const path = String(endpoint || "").trim();
  if (!path || path === "-" || path.startsWith("/family/")) return false;
  if (isNoiseEndpoint(path)) return false;
  return true;
}

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
  if (isNoiseEndpoint(endpoint)) return false;
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
 * High-priority candidates that are not effectively resolved.
 * Includes bare `observed` and weak `skipped` (missing substantive notes/reason).
 * These must be verified, blocked, or skipped with real notes before finish_scan(completed).
 */
export function untestedHighPriorityCandidates(rows: CoverageLikeRow[]): ConversionCandidate[] {
  return rows
    .map(normalizeCoverageRow)
    .filter((row): row is ConversionCandidate => Boolean(row))
    .filter((row) => row.highPriority && !isEffectivelyResolved(row) && row.status !== "tried")
    .sort((a, b) => b.priority - a.priority || a.endpoint.localeCompare(b.endpoint));
}

/** High-priority rows still only observed (never attempted). */
export function observedOnlyHighPriority(rows: CoverageLikeRow[]): ConversionCandidate[] {
  return rows
    .map(normalizeCoverageRow)
    .filter((row): row is ConversionCandidate => Boolean(row))
    .filter((row) => row.highPriority && row.status === "observed")
    .sort((a, b) => b.priority - a.priority || a.endpoint.localeCompare(b.endpoint));
}

/** High-priority skips that lack substantive notes — do not satisfy finish gates. */
export function weakSkipHighPriority(rows: CoverageLikeRow[]): ConversionCandidate[] {
  return rows
    .map(normalizeCoverageRow)
    .filter((row): row is ConversionCandidate => Boolean(row))
    .filter((row) => row.highPriority && row.status === "skipped" && !isSubstantiveSkipNotes(row.notes))
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
  weakSkips?: ConversionCandidate[];
  surfaceGaps?: RiskFamilyGap[];
};

/**
 * finish_scan(status='completed') eligibility depends on engagement:
 * - assess (default): high-priority resolved (not weak-skipped), risk families attempted,
 *   multi-actor when surface needs it, attack-surface/traffic quality, no bulk-skip-only resolution
 * - verify / retest / consult: do not require full-site conversion; hypothesis-scoped completion is allowed
 */
export function finishCompletedEligibility(
  coverageRows: CoverageLikeRow[],
  options: {
    status?: string;
    confirmedFindings?: string[];
    actorCount?: number;
    /** Actors that actually hold Authorization/Cookie material. */
    actorAuthCount?: number;
    /** assess | verify | retest | consult — from explicit task field or workflow actually run */
    engagement?: string;
    surfaceInventory?: SurfaceInventory;
  } = {},
): FinishEligibility {
  const status = String(options.status || "completed").toLowerCase();
  const engagement = String(options.engagement || "assess").toLowerCase();
  const untested = materialUntestedHighPriority(coverageRows);
  const weakSkips = weakSkipHighPriority(coverageRows);
  const missingRiskFamilies = missingRiskFamiliesFromCoverage(coverageRows);
  const applyAssessGates = engagement === "assess";
  const multiActorGaps = applyAssessGates
    ? multiActorTestingGaps(coverageRows, options.actorCount ?? 0, options.actorAuthCount)
    : [];
  const surfaceGaps = applyAssessGates ? attackSurfaceGaps(coverageRows, options.surfaceInventory) : [];
  const bulkSkipGaps = applyAssessGates ? bulkSkipResolutionGaps(coverageRows) : [];
  const assessExtraGaps = [...surfaceGaps, ...bulkSkipGaps, ...multiActorGaps];
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
      missingRiskFamilies: [...missingRiskFamilies, ...assessExtraGaps],
      weakSkips,
      surfaceGaps,
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
      weakSkips,
      surfaceGaps: [],
    };
  }

  if (untested.length > 0) {
    const weakCount = weakSkips.length;
    const observedCount = observedOnlyHighPriority(coverageRows).length;
    return {
      allowed: false,
      reason:
        `${untested.length} high-priority candidate(s) remain unresolved ` +
        `(${observedCount} observed-only, ${weakCount} weak skip(s) without substantive notes). ` +
        `Run verifier/scan/poc/traffic mutate, or mark blocked/skipped with a concrete reason (≥${SUBSTANTIVE_NOTE_MIN} chars). ` +
        `Examples: ${untested.slice(0, 5).map(formatCandidate).join("; ")}`,
      untestedHighPriority: untested,
      verifiedAwaitingConfirm,
      missingRiskFamilies: [...missingRiskFamilies, ...assessExtraGaps],
      weakSkips,
      surfaceGaps,
    };
  }

  if (missingRiskFamilies.length > 0) {
    return {
      allowed: false,
      reason:
        `${missingRiskFamilies.length} risk family gap(s) remain for observed attack surface. ` +
        `Test or explicitly skip with substantive notes: ${missingRiskFamilies.map((item) => item.family).join(", ")}. ` +
        `Use verifier for suggested classes or coverage(mark status=blocked/skipped) with notes explaining why.`,
      untestedHighPriority: untested,
      verifiedAwaitingConfirm,
      missingRiskFamilies: [...missingRiskFamilies, ...assessExtraGaps],
      weakSkips,
      surfaceGaps,
    };
  }

  if (assessExtraGaps.length > 0) {
    return {
      allowed: false,
      reason:
        `${assessExtraGaps.length} assess-quality gap(s) remain (attack surface / multi-actor / skip discipline). ` +
        assessExtraGaps.map((item) => item.reason).join(" "),
      untestedHighPriority: untested,
      verifiedAwaitingConfirm,
      missingRiskFamilies: assessExtraGaps,
      weakSkips,
      surfaceGaps,
    };
  }

  return {
    allowed: true,
    reason: "no material high-priority, risk-family, multi-actor, surface, or bulk-skip gaps remain",
    untestedHighPriority: untested,
    verifiedAwaitingConfirm,
    missingRiskFamilies,
    weakSkips,
    surfaceGaps,
  };
}

/**
 * When observed surface looks multi-user/API, require real dual-actor access-control probes.
 * Skipped-only IDOR rows do not satisfy this gate. Prefer actors that hold auth material.
 */
export function multiActorTestingGaps(
  coverageRows: CoverageLikeRow[],
  actorCount: number,
  actorAuthCount?: number,
): RiskFamilyGap[] {
  const normalized = coverageRows
    .map(normalizeCoverageRow)
    .filter((row): row is ConversionCandidate => Boolean(row));
  if (!normalized.length) return [];

  const surfaceText = normalized.map((row) => `${row.endpoint} ${row.param} ${row.vulnClass}`).join("\n");
  const needsMultiUser = /\/api\/|\/rest\/|users?|basket|order|account|profile|admin|role|feedback|complaint|cart|review/i.test(surfaceText);
  if (!needsMultiUser) return [];

  const gaps: RiskFamilyGap[] = [];
  const authCount = Number.isFinite(Number(actorAuthCount)) ? Number(actorAuthCount) : actorCount;
  const exampleSurfaces = normalized
    .filter((row) => /\/api\/|\/rest\/|basket|order|users?|account|profile|feedback|review/i.test(row.endpoint))
    .map((row) => row.endpoint)
    .filter((value, index, arr) => arr.indexOf(value) === index)
    .slice(0, 5);

  if (actorCount < 2 || authCount < 2) {
    gaps.push({
      family: "multi_actor",
      label: "Multi-identity privilege contexts",
      suggestedClasses: ["idor", "access-control", "business-logic"],
      exampleSurfaces,
      reason:
        actorCount < 2
          ? "Observed multi-user/API surface but fewer than two actors were registered. " +
            "Create two identities with actor(upsert/capture) after distinct logins, then retest access-control."
          : "Two actor ids exist but fewer than two hold Authorization/Cookie material. " +
            "Capture real session headers for both identities before dual-actor probes.",
    });
    return gaps;
  }

  const dualActorRows = normalized.filter(
    (row) =>
      ACCESS_CONTROL_CLASSES.has(row.vulnClass.toLowerCase()) &&
      (row.status === "passed" || row.status === "failed") &&
      /dual.?actor|alt_actor|cross.?actor|horizontal|vertical|owner-actor|alt-actor/i.test(row.notes || ""),
  );
  if (!dualActorRows.length) {
    gaps.push({
      family: "multi_actor_probe",
      label: "Dual-actor access-control proof",
      suggestedClasses: ["idor", "access-control", "business-logic"],
      exampleSurfaces,
      reason:
        "Two or more actors exist, but no dual-actor access-control/business-logic verifier result was recorded. " +
        "Run verifier(vuln_class='idor', actor=A, alt_actor=B, object_id=...) or a business-logic probe with two identities.",
    });
    return gaps;
  }

  // Breadth: when several real object resources appear, require dual-actor on ≥2 distinct
  // collections OR dual-actor on ≥1 plus substantive pattern-covered skip/block on the rest.
  // Noise paths (FUZZ, bare /api/, SPA catch-alls) must not inflate this count.
  const objectLikeEndpoints = uniqueStrings(
    normalized
      .filter((row) => ACCESS_CONTROL_CLASSES.has(row.vulnClass.toLowerCase()))
      .map((row) => normalizeEndpointKey(row.endpoint))
      .filter(isObjectLikeResourcePath),
  );
  if (objectLikeEndpoints.length >= 3) {
    const dualEndpoints = uniqueStrings(dualActorRows.map((row) => normalizeEndpointKey(row.endpoint)));
    const dualSet = new Set(dualEndpoints);
    const patternCoveredEndpoints = uniqueStrings(
      normalized
        .filter((row) => ACCESS_CONTROL_CLASSES.has(row.vulnClass.toLowerCase()))
        .filter((row) => isPatternCoveredAccessControl(row))
        .map((row) => normalizeEndpointKey(row.endpoint))
        .filter(isObjectLikeResourcePath),
    );
    const openObjectEndpoints = objectLikeEndpoints.filter(
      (endpoint) => !dualSet.has(endpoint) && !patternCoveredEndpoints.includes(endpoint),
    );
    const breadthSatisfied =
      dualEndpoints.length >= 2 || (dualEndpoints.length >= 1 && openObjectEndpoints.length === 0);
    if (!breadthSatisfied) {
      gaps.push({
        family: "multi_actor_breadth",
        label: "Dual-actor resource breadth",
        suggestedClasses: ["idor", "access-control", "business-logic"],
        exampleSurfaces: (openObjectEndpoints.length ? openObjectEndpoints : objectLikeEndpoints).slice(0, 5),
        reason:
          `Observed ${objectLikeEndpoints.length} access-control resources; dual-actor covers ${dualEndpoints.length}, ` +
          `${openObjectEndpoints.length} still open (not dual-probed and not pattern-covered). ` +
          "Run dual-actor idor/access-control on at least two distinct endpoints, " +
          "or after one dual-actor proof mark remaining object resources blocked/skipped with notes that the same authz pattern was already proven.",
      });
    }
  }
  return gaps;
}

/** Substantive skip/block notes claiming the same authz pattern was already dual-actor proven. */
export function isPatternCoveredAccessControl(row: ConversionCandidate): boolean {
  if (row.status !== "skipped" && row.status !== "blocked") return false;
  if (!isSubstantiveSkipNotes(row.notes)) return false;
  return /same.?authz|pattern.?covered|already.?verified|already.?proven|same.?class|same.?pattern|covered.?by|dual.?actor/i.test(
    row.notes || "",
  );
}

/**
 * Attack-surface quality for assess: thin inventories and unused traffic truth block completed.
 * Never keyed off product names — only observed coverage shape + optional traffic stats.
 */
export function attackSurfaceGaps(
  coverageRows: CoverageLikeRow[],
  inventory?: SurfaceInventory,
): RiskFamilyGap[] {
  const normalized = coverageRows
    .map(normalizeCoverageRow)
    .filter((row): row is ConversionCandidate => Boolean(row));
  if (!normalized.length) return [];

  const endpoints = uniqueStrings(
    normalized.map((row) => normalizeEndpointKey(row.endpoint)).filter(isMeaningfulEndpoint),
  );
  const surfaceText = normalized.map((row) => `${row.endpoint} ${row.param} ${row.vulnClass}`).join("\n");
  const hasApiShape = /\/api\/|\/rest\/|graphql|swagger|openapi/i.test(surfaceText);
  const hasAuthShape = /login|register|signup|whoami|oauth|session|jwt|token/i.test(surfaceText);
  const highValueShape = hasApiShape || hasAuthShape;
  if (!highValueShape) return [];

  const gaps: RiskFamilyGap[] = [];
  const trafficCount = Number(inventory?.trafficCount ?? -1);
  const trafficEndpointCount = Number(inventory?.trafficEndpointCount ?? -1);
  const trafficCandidateCount = Number(inventory?.trafficCandidateCount ?? -1);

  // Empty traffic on a multi-endpoint API/auth inventory is a recon quality failure.
  // Small unit/smoke inventories without live http remain allowed.
  if (trafficCount === 0 && endpoints.length >= 4) {
    gaps.push({
      family: "traffic_inventory",
      label: "Traffic capture / inventory",
      suggestedClasses: ["idor", "sql-injection", "mass-assignment"],
      exampleSurfaces: endpoints.slice(0, 5),
      reason:
        "API/auth attack surface was marked across multiple endpoints but the traffic store is empty. " +
        "Use browser/http/scan to capture real requests, then traffic(action='analyze' or 'candidates') before finish_scan(completed).",
    });
  }

  if (trafficEndpointCount >= 8 && endpoints.length > 0 && endpoints.length < 4) {
    gaps.push({
      family: "traffic_to_coverage",
      label: "Traffic → coverage seeding",
      suggestedClasses: ["idor", "sql-injection", "xss-reflected", "business-logic"],
      exampleSurfaces: endpoints.slice(0, 5),
      reason:
        `Traffic inventory has ${trafficEndpointCount} endpoints but coverage only tracks ${endpoints.length} meaningful path(s). ` +
        "Seed coverage from traffic(endpoints)/candidates and expand recon before declaring the assessment complete.",
    });
  }

  if (trafficCandidateCount >= 5 && !normalized.some((row) => isEffectivelyAttempted(row) && row.highPriority)) {
    gaps.push({
      family: "traffic_candidates_untested",
      label: "High-value traffic candidates",
      suggestedClasses: ["idor", "sql-injection", "mass-assignment", "business-logic"],
      exampleSurfaces: endpoints.slice(0, 5),
      reason:
        `Traffic has ${trafficCandidateCount} high-value replay candidates but no high-priority coverage attempt was recorded. ` +
        "Baseline with traffic(repeat), then verifier/mutate against candidates before finish_scan(completed).",
    });
  }

  // Thin coverage relative to a rich traffic inventory (requires inventory to be supplied by finish path).
  if (hasApiShape && trafficEndpointCount >= 10 && endpoints.length > 0 && endpoints.length < 5) {
    gaps.push({
      family: "attack_surface_breadth",
      label: "Attack surface breadth",
      suggestedClasses: ["idor", "mass-assignment", "sql-injection", "business-logic"],
      exampleSurfaces: endpoints.slice(0, 5),
      reason:
        `Traffic shows ${trafficEndpointCount} endpoints but coverage only inventories ${endpoints.length} meaningful path(s). ` +
        "Expand recon from traffic(endpoints/candidates) and browser navigation before finish_scan(completed), " +
        "or mark recon blocked with notes if inventory cannot grow.",
    });
  }

  return gaps;
}

/**
 * Prevent finish_scan(completed) when high-priority work is almost entirely closed by skips.
 */
export function bulkSkipResolutionGaps(coverageRows: CoverageLikeRow[]): RiskFamilyGap[] {
  const high = coverageRows
    .map(normalizeCoverageRow)
    .filter((row): row is ConversionCandidate => Boolean(row))
    .filter((row) => row.highPriority)
    .filter((row) => row.param !== "family" && !row.endpoint.startsWith("/family/"));

  if (high.length < 8) return [];

  const verified = high.filter((row) => VERIFIED_STATUSES.has(row.status));
  const substantiveSkips = high.filter((row) => row.status === "skipped" && isSubstantiveSkipNotes(row.notes));
  const resolved = high.filter(isEffectivelyResolved);
  if (resolved.length < 8) return [];

  const skipRatio = substantiveSkips.length / resolved.length;
  if (substantiveSkips.length >= 8 && skipRatio >= 0.7 && verified.length < 4) {
    return [
      {
        family: "bulk_skip",
        label: "Skip-heavy resolution",
        suggestedClasses: uniqueStrings(high.map((row) => row.vulnClass)).slice(0, 6),
        exampleSurfaces: uniqueStrings(high.map((row) => row.endpoint)).slice(0, 5),
        reason:
          `${substantiveSkips.length}/${resolved.length} high-priority rows were closed by skip ` +
          `with only ${verified.length} real pass/fail/blocked result(s). ` +
          "Convert more high-priority candidates with verifier/http (or mark incomplete). " +
          "Bulk skip is not a substitute for testing multi-user API surfaces.",
      },
    ];
  }
  return [];
}

function normalizeEndpointKey(endpoint: string): string {
  const raw = String(endpoint || "").trim();
  if (!raw) return "";
  try {
    if (/^https?:\/\//i.test(raw)) return new URL(raw).pathname || raw;
  } catch {
    // fall through
  }
  // Strip query/hash for grouping.
  return raw.split("?")[0]?.split("#")[0] || raw;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
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
      .filter((row) => isEffectivelyAttempted(row))
      .map((row) => row.vulnClass.toLowerCase()),
  );
  // Explicit family-level skip: coverage row with param="family" or notes containing family id.
  // Weak notes do not close a risk family.
  const familyResolved = new Set(
    normalized
      .filter((row) => isEffectivelyResolved(row))
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
  const highUntested = high.filter((row) => !isEffectivelyResolved(row) && row.status !== "tried");
  const highAttempted = high.filter((row) => isEffectivelyAttempted(row));
  const highResolved = high.filter((row) => isEffectivelyResolved(row));
  const confirmed = high.filter((row) => row.status === "failed");
  const negatives = high.filter((row) => row.status === "passed");
  const observedCount = normalized.filter((row) => row.status === "observed" || ATTEMPTED_STATUSES.has(row.status)).length;
  const attemptedCount = normalized.filter((row) => isEffectivelyAttempted(row)).length;
  const resolvedCount = normalized.filter((row) => isEffectivelyResolved(row)).length;

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

/**
 * Mid-run discovery queue: ordered live probes from coverage + risk-family gaps + traffic inventory.
 * Pure and unit-smokeable. Separate from finish eligibility (gates may still block completed).
 */
export function buildDiscoveryQueue(
  coverageRows: CoverageLikeRow[],
  options: {
    familyGaps?: RiskFamilyGap[];
    surfaceInventory?: SurfaceInventory;
    actorCount?: number;
    actorAuthCount?: number;
    limit?: number;
  } = {},
): DiscoveryWorkItem[] {
  const limit = Math.max(1, Math.min(options.limit ?? 12, 24));
  const inventory = options.surfaceInventory || {};
  const familyGaps =
    options.familyGaps ||
    [
      ...missingRiskFamiliesFromCoverage(coverageRows),
      ...attackSurfaceGaps(coverageRows, inventory),
      ...multiActorTestingGaps(coverageRows, options.actorCount ?? 0, options.actorAuthCount),
      ...bulkSkipResolutionGaps(coverageRows),
    ];
  const untested = materialUntestedHighPriority(coverageRows).filter((row) => !isNoiseEndpoint(row.endpoint));
  const items: DiscoveryWorkItem[] = [];
  const seen = new Set<string>();

  const push = (item: DiscoveryWorkItem) => {
    const key = `${item.kind}|${item.family || ""}|${item.vulnClass || ""}|${item.endpoint || ""}|${item.title}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  for (const gap of familyGaps) {
    if (gap.family === "multi_actor" || gap.family === "multi_actor_probe") {
      push({
        id: `multi-actor-${gap.family}`,
        priority: 400,
        kind: "multi_actor",
        family: gap.family,
        title: "Establish dual-actor access-control proof",
        toolHint: "actor(capture)×2 then verifier(vuln_class='idor', actor=A, alt_actor=B, object_id=…)",
        endpoint: gap.exampleSurfaces[0],
        vulnClass: "idor",
        rationale: gap.reason,
      });
    } else if (gap.family === "multi_actor_breadth") {
      push({
        id: "multi-actor-breadth",
        priority: 390,
        kind: "multi_actor",
        family: gap.family,
        title: "Dual-actor probe a second distinct object collection",
        toolHint: "verifier(vuln_class='idor', actor=A, alt_actor=B) on a different resource than the first dual-actor hit",
        endpoint: gap.exampleSurfaces.find((s) => isObjectLikeResourcePath(s)) || gap.exampleSurfaces[0],
        vulnClass: "idor",
        rationale: gap.reason,
      });
    } else if (
      gap.family === "traffic_inventory" ||
      gap.family === "traffic_to_coverage" ||
      gap.family === "traffic_candidates_untested" ||
      gap.family === "attack_surface_breadth"
    ) {
      push({
        id: `traffic-${gap.family}`,
        priority: 380,
        kind: "traffic_expand",
        family: gap.family,
        title: "Expand attack surface from traffic truth",
        toolHint: "traffic(action='analyze' or 'candidates') then http/verifier on new real endpoints (ignore FUZZ/bare API roots)",
        rationale: gap.reason,
      });
    } else if (gap.family === "bulk_skip") {
      push({
        id: "bulk-skip-recover",
        priority: 370,
        kind: "risk_family",
        family: gap.family,
        title: "Replace skip-only resolution with live pass/fail evidence",
        toolHint: "verifier/http on remaining high-priority classes instead of more coverage skips",
        rationale: gap.reason,
      });
    } else {
      // Risk-family gap (injection, xss, business_logic, …)
      const suggested = gap.suggestedClasses[0] || "sql-injection";
      push({
        id: `family-${gap.family}`,
        priority: 350 - Math.min(familyGaps.indexOf(gap), 10),
        kind: "risk_family",
        family: gap.family,
        title: `Probe untested risk family: ${gap.label}`,
        toolHint: familyToolHint(gap.family, suggested),
        endpoint: gap.exampleSurfaces[0],
        vulnClass: suggested,
        rationale: gap.reason,
      });
    }
  }

  // Untested high-priority candidates (noise already filtered).
  for (const row of [...untested].sort((a, b) => candidateSignalScore(b) - candidateSignalScore(a))) {
    push({
      id: `cand-${row.vulnClass}-${row.endpoint}-${row.param}`,
      priority: 300 + Math.min(candidateSignalScore(row), 80),
      kind: "coverage_candidate",
      title: `Live-test ${row.vulnClass} on ${row.endpoint}`,
      toolHint: suggestedToolForCandidate(row),
      endpoint: row.endpoint,
      vulnClass: row.vulnClass,
      rationale: `High-priority coverage still ${row.status}${row.notes ? ` (${row.notes.slice(0, 80)})` : ""}`,
    });
  }

  // Traffic paths not yet represented in meaningful coverage endpoints.
  const coveredPaths = new Set(
    coverageRows
      .map((row) => normalizeEndpointKey(String(row.endpoint || "")))
      .filter((path) => path && !isNoiseEndpoint(path)),
  );
  const trafficPaths = inventory.trafficPaths || [];
  for (const path of trafficPaths) {
    if (coveredPaths.has(normalizeEndpointKey(path))) continue;
    if (isNoiseEndpoint(path)) continue;
    push({
      id: `traffic-path-${path}`,
      priority: 280,
      kind: "traffic_expand",
      title: `Seed and probe traffic-discovered path ${path}`,
      toolHint: "http or traffic(repeat) baseline, then verifier for the most likely class from method/params",
      endpoint: path,
      rationale: "Present in traffic inventory but missing from coverage — mid-run expansion target",
    });
  }
  for (const url of inventory.trafficCandidateUrls || []) {
    try {
      const path = new URL(url).pathname;
      if (isNoiseEndpoint(path) || coveredPaths.has(normalizeEndpointKey(path))) continue;
      push({
        id: `traffic-cand-${path}`,
        priority: 275,
        kind: "traffic_expand",
        title: `Replay high-value traffic candidate ${path}`,
        toolHint: "traffic(repeat) then traffic(mutate)/verifier; preserve auth headers",
        endpoint: path,
        rationale: "High-value traffic candidate not yet converted into coverage/test results",
      });
    } catch {
      // ignore bad urls
    }
  }

  // After first confirmed findings, push breadth families not yet attempted even if surfaceHints were weak.
  const confirmedCount = coverageRows.filter((row) => String(row.status || "").toLowerCase() === "failed").length;
  const attemptedClasses = new Set(
    coverageRows
      .map(normalizeCoverageRow)
      .filter((row): row is ConversionCandidate => Boolean(row))
      .filter((row) => isEffectivelyAttempted(row))
      .map((row) => row.vulnClass.toLowerCase()),
  );
  if (confirmedCount >= 1) {
    const postConfirm: Array<{ klass: string; title: string; tool: string; priority: number }> = [
      {
        klass: "xss-reflected",
        title: "Browser XSS check on reflective/search sinks",
        tool: "browser navigation with benign DOM marker (not HTTP-only reflection)",
        priority: 260,
      },
      {
        klass: "business-logic",
        title: "Business-logic tamper on state-changing fields",
        tool: "verifier(vuln_class='business-logic') on cart/order/rating/quantity/price from traffic",
        priority: 255,
      },
      {
        klass: "sql-injection",
        title: "Injection on auth/search parameters not yet proven",
        tool: "verifier(vuln_class='sql-injection') on login email/username and search q with true/false pairs",
        priority: 250,
      },
      {
        klass: "path-traversal",
        title: "File/path handling probes when path-like params exist",
        tool: "verifier(vuln_class='path-traversal') on download/file/page parameters only",
        priority: 245,
      },
    ];
    for (const item of postConfirm) {
      if (attemptedClasses.has(item.klass)) continue;
      // Skip if same family already queued via risk_family gap.
      if (items.some((existing) => existing.vulnClass === item.klass && existing.kind === "risk_family")) continue;
      push({
        id: `post-confirm-${item.klass}`,
        priority: item.priority,
        kind: "post_confirm_breadth",
        title: item.title,
        toolHint: item.tool,
        vulnClass: item.klass,
        rationale:
          "At least one finding is confirmed — expand to other risk families before finish bookkeeping",
      });
    }
  }

  return items.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)).slice(0, limit);
}

function familyToolHint(family: string, suggestedClass: string): string {
  if (family === "xss") return "browser + xss marker on reflected/DOM sinks; JSON-only APIs are not enough for confirm";
  if (family === "business_logic") return "verifier(vuln_class='business-logic') on state-changing fields from traffic";
  if (family === "injection") return `verifier(vuln_class='${suggestedClass}') with baseline/true/false pairs on login and search`;
  if (family === "auth_session") return "verifier(vuln_class='jwt-alg-none') on protected whoami/API after capturing a real token";
  if (family === "file_path") return "verifier(vuln_class='path-traversal' or 'file-inclusion') on real path/file params only";
  if (family === "redirect") return "verifier(vuln_class='open-redirect') or ssrf probes on url/next/redirect params";
  if (family === "csrf") return "http state-changing request without CSRF token + prove durable state change";
  if (family === "access_control") return "verifier(vuln_class='idor', actor=A, alt_actor=B, object_id=…)";
  return `verifier(vuln_class='${suggestedClass}') or http/traffic(mutate) with evidence`;
}

/**
 * Guidance after finish_scan(completed) rejection or coverage conversion checks.
 * Front-loads the discovery queue so truncation still keeps next live probes.
 */
export function nextVerifyGuidance(
  candidates: ConversionCandidate[],
  confirmedEvidenceIds: string[] = [],
  familyGaps: RiskFamilyGap[] = [],
  options: {
    surfaceInventory?: SurfaceInventory;
    coverageRows?: CoverageLikeRow[];
    actorCount?: number;
    actorAuthCount?: number;
  } = {},
): string {
  const rows = options.coverageRows || candidates;
  const queue = buildDiscoveryQueue(rows, {
    familyGaps,
    surfaceInventory: options.surfaceInventory,
    actorCount: options.actorCount,
    actorAuthCount: options.actorAuthCount,
    limit: 8,
  });

  // Keep front section short so tool-result previews retain discovery priority.
  const lines: string[] = [
    "NEXT LIVE WORK (do these before more coverage skip/block marks):",
  ];
  if (queue.length) {
    for (const item of queue.slice(0, 6)) {
      lines.push(`${queue.indexOf(item) + 1}. [${item.kind}] ${item.title} → ${item.toolHint}`);
    }
  } else {
    lines.push("1. No open discovery queue — re-run traffic(analyze) and coverage(action='next_work') after recon.");
  }
  lines.push("RULE: finish_scan(completed) needs live proofs, not bulk skips. Weak skips still fail the gate.");

  if (confirmedEvidenceIds.length) {
    lines.push(
      `Confirm pending: finding(confirm) with evidence_ids=[${confirmedEvidenceIds.slice(0, 6).join(", ")}].`,
    );
  }

  const noiseOnly = candidates.length > 0 && candidates.every((row) => isNoiseEndpoint(row.endpoint));
  if (noiseOnly) {
    lines.push("Remaining candidates are noise (FUZZ/bare API roots) — ignore them; expand from traffic candidates.");
  }

  return lines.join("\n");
}

/** Compact machine-readable queue + short text for tool responses (finish / coverage). */
export function formatDiscoveryQueuePayload(
  coverageRows: CoverageLikeRow[],
  options: {
    familyGaps?: RiskFamilyGap[];
    surfaceInventory?: SurfaceInventory;
    actorCount?: number;
    actorAuthCount?: number;
    confirmedEvidenceIds?: string[];
    limit?: number;
  } = {},
): {
  next_work: DiscoveryWorkItem[];
  guidance: string;
  count: number;
} {
  const next_work = buildDiscoveryQueue(coverageRows, options);
  const untested = materialUntestedHighPriority(coverageRows);
  const familyGaps =
    options.familyGaps ||
    [
      ...missingRiskFamiliesFromCoverage(coverageRows),
      ...attackSurfaceGaps(coverageRows, options.surfaceInventory),
      ...multiActorTestingGaps(coverageRows, options.actorCount ?? 0, options.actorAuthCount),
      ...bulkSkipResolutionGaps(coverageRows),
    ];
  return {
    next_work,
    count: next_work.length,
    guidance: nextVerifyGuidance(untested, options.confirmedEvidenceIds || [], familyGaps, {
      surfaceInventory: options.surfaceInventory,
      coverageRows,
      actorCount: options.actorCount,
      actorAuthCount: options.actorAuthCount,
    }),
  };
}

function candidateSignalScore(row: ConversionCandidate): number {
  let score = row.priority || 0;
  if (isObjectLikeResourcePath(row.endpoint)) score += 40;
  if (isNoiseEndpoint(row.endpoint)) score -= 200;
  if (["idor", "sql-injection", "mass-assignment", "business-logic", "xss-dom", "xss-reflected", "jwt-alg-none"].includes(row.vulnClass.toLowerCase())) {
    score += 20;
  }
  if (row.param && row.param !== "-" && row.param !== "id" && row.param !== "q") score += 10;
  if (row.status === "skipped") score -= 15;
  return score;
}

function suggestedToolForCandidate(row: ConversionCandidate): string {
  const klass = row.vulnClass.toLowerCase();
  if (["idor", "access-control", "horizontal-access", "vertical-access"].includes(klass)) {
    return "verifier(vuln_class='idor', actor=A, alt_actor=B, object_id=…)";
  }
  if (["sql-injection", "blind-sql-injection", "command-injection", "jwt-alg-none", "mass-assignment", "business-logic", "open-redirect", "path-traversal", "file-inclusion"].includes(klass)) {
    return `verifier(vuln_class='${klass}') with baseline/attack pair`;
  }
  if (klass.includes("xss")) return "browser navigation + XSS marker (http reflection alone is not enough)";
  if (klass === "csrf") return "http state-changing request without token + prove state change";
  return "http/traffic(mutate) with baseline repeat, then evidence";
}

function percent(value: number, total: number): number {
  if (!total) return 0;
  return Math.round((value / total) * 1000) / 10;
}
