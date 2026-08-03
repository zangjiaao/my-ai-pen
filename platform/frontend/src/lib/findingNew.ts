/**
 * Whether a finding row should show the operator-facing **New** chrome.
 *
 * Chat cards use {@link isTruthyNewFlag} on `content.created` only.
 * Panel / ledger rows use {@link isFindingNew} (explicit flags + rediscovery/first-seen).
 */

/** Accept true / "true" / 1 / "1" as a positive boolean on the wire. */
export function isTruthyNewFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "true" || value === "1";
}

/** Accept false / "false" / 0 / "0" as an explicit negative. */
export function isFalsyNewFlag(value: unknown): boolean {
  return value === false || value === 0 || value === "false" || value === "0";
}

function parseTimeMs(value: unknown): number | null {
  if (value == null || value === "") return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function hasOwnSignal(finding: Record<string, unknown>, key: string): boolean {
  const v = finding[key];
  return v !== undefined && v !== null && v !== "";
}

export type FindingNewOptions = {
  /** Case / engagement start (caseRun.started_at or conversation start). */
  caseStartedAt?: string | null;
};

/**
 * True when this row is a true new ledger identity for the engagement.
 *
 * Priority:
 * 1. Explicit `created` / `is_new` when present
 * 2. Rediscovery signals → not New
 * 3. first_seen vs case start when both available
 * 4. first-ever heuristic (first_seen == discovered; or rediscovery 0/missing inside engagement)
 *
 * Outside engagement (no `caseStartedAt`), only explicit create flags or equal
 * first/discovered times light New — avoids marking every historical list row.
 */
export function isFindingNew(
  finding: Record<string, unknown>,
  options?: FindingNewOptions,
): boolean {
  if (hasOwnSignal(finding, "created")) {
    if (isTruthyNewFlag(finding.created)) return true;
    if (isFalsyNewFlag(finding.created)) return false;
  }

  if (hasOwnSignal(finding, "is_new")) {
    if (isTruthyNewFlag(finding.is_new)) return true;
    if (isFalsyNewFlag(finding.is_new)) return false;
  }

  if (isTruthyNewFlag(finding.multiple_discoveries)) return false;

  const rediscoveryRaw = finding.rediscovery_count;
  const rediscovery =
    rediscoveryRaw === undefined || rediscoveryRaw === null || rediscoveryRaw === ""
      ? null
      : Number(rediscoveryRaw);
  if (rediscovery != null && Number.isFinite(rediscovery) && rediscovery > 0) return false;

  const firstSeen = finding.first_seen_at ?? finding.first_seen;
  const firstMs = parseTimeMs(firstSeen);
  const caseMs = parseTimeMs(options?.caseStartedAt);
  const inEngagement = options?.caseStartedAt != null && String(options.caseStartedAt).trim() !== "";

  if (firstMs != null && caseMs != null) {
    return firstMs >= caseMs;
  }

  const discovered = finding.discovered_at ?? finding.discovered;
  const discoveredMs = parseTimeMs(discovered);
  if (firstMs != null && discoveredMs != null) {
    return firstMs === discoveredMs;
  }
  if (
    firstSeen != null &&
    firstSeen !== "" &&
    discovered != null &&
    discovered !== "" &&
    String(firstSeen) === String(discovered)
  ) {
    return true;
  }

  // Conversation Findings panel: first-ever rows when rediscovery is 0 / missing.
  if (inEngagement && (rediscovery == null || rediscovery === 0)) return true;

  return false;
}
