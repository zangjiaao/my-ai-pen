/**
 * Authoritative confirmed findings from disk for finish_scan.
 * LLM-supplied title lists are optional hints only.
 *
 * Dedupe is class + endpoint-family based so near-duplicate titles from
 * main agent + worker double-confirms collapse to one independent finding.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type PersistedFindingRecord = {
  action?: string;
  title?: string;
  severity?: string;
  url?: string;
  location?: string;
  affected_asset?: string;
  evidence_ids?: string[];
  description?: string;
  impact?: string;
  created_at?: string;
  [key: string]: unknown;
};

export type AggregatedFindings = {
  titles: string[];
  evidenceIds: string[];
  records: PersistedFindingRecord[];
  rawCount: number;
  dedupedCount: number;
};

/** Normalize free text for fuzzy dedupe. */
export function normalizeFindingText(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strip scheme/host/port noise so the same endpoint under different hosts collapses.
 */
export function normalizeLocationFingerprint(value: unknown): string {
  let raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  raw = raw.replace(/^https?:\/\//, "");
  // Drop host:port prefix when a path follows (host.docker.internal:3000/api/...).
  raw = raw.replace(/^[^/\s]+:\d+(?=\/)/, "");
  raw = raw.replace(/^[^/\s]+(?=\/)/, "");
  raw = raw.replace(/^host\.docker\.internal(?::\d+)?/, "");
  raw = raw.replace(/[?#].*$/, "");
  return normalizeFindingText(raw);
}

/**
 * Deterministic dedupe key: vulnerability class + endpoint family.
 * Near-duplicate titles on the same logical surface collapse regardless of host/wording.
 */
export function findingDedupeKey(record: PersistedFindingRecord): string {
  const title = normalizeFindingText(record.title || "");
  const classHint = extractClassHint(title);
  const location = normalizeLocationFingerprint(record.location || record.url || record.affected_asset || "");
  const family = endpointFamily(location, title, classHint);
  if (classHint) return `${classHint}|${family}`;
  if (location) return `loc|${location}|${title.slice(0, 60)}`;
  return title || "finding";
}

/** Map free-form location/title into a coarse endpoint family for dedupe. */
export function endpointFamily(locationNorm: string, titleNorm: string, classHint: string): string {
  const blob = `${locationNorm} ${titleNorm}`;
  if (classHint === "jwt" || /\bjwt\b|\balg\s*none\b|\btoken forgery\b/.test(blob)) return "jwt-global";
  if (classHint === "cors" || /\bcors\b|\baccess control allow origin\b/.test(blob)) return "cors-global";
  if (/\blogin\b|\bauth(?:entication)?\b|\bwhoami\b/.test(blob)) return "login";
  if (/\bsearch\b|\bproducts\s*search\b|\brest\s*products\s*search\b/.test(blob)) return "search";
  if (/\breview/.test(blob)) return "reviews";
  if (/\bftp\b/.test(blob)) return "ftp";
  if (/\bprofile\s*image\b|\bprofileimage\b/.test(blob)) return "profile-image";
  if (/\badmin\b.*\bconfig|\bapplication\s*configuration\b|\bprometheus\b|\bmetrics\b/.test(blob)) {
    return "admin-config";
  }
  if (/\bapi\s*users\b|\busers\b|\bregistration\b|\bregister\b/.test(blob)) return "api-users";
  if (/\bbasket|\bcart\b|\border\b/.test(blob)) return "basket-order";
  // Fallback: first path-like token from location, else title token slice.
  const pathToken = locationNorm.split(" ").filter(Boolean)[0] || "";
  if (pathToken && pathToken.length > 1) return pathToken.slice(0, 64);
  return titleNorm.split(" ").filter(Boolean).slice(0, 3).join("-") || "global";
}

export function extractClassHint(titleNorm: string): string {
  const checks: Array<[RegExp, string]> = [
    [/\bsql\s*injection\b|\bsqli\b/, "sqli"],
    [/\bnosql\b/, "nosql"],
    [/\bjwt\b|\balg\s*none\b/, "jwt"],
    [/\bmass\s*assignment\b|\brole\b.*\badmin\b/, "mass-assignment"],
    [/\bidor\b|\binsecure direct object\b/, "idor"],
    [/\bxss\b|cross site scripting/, "xss"],
    [/\bcsrf\b/, "csrf"],
    [/\bssrf\b/, "ssrf"],
    [/\bcors\b/, "cors"],
    [/\bmetrics\b|prometheus/, "metrics"],
    [/\bheader\b/, "headers"],
    [/\bpath\s*traversal\b|\blfi\b|\bnull\s*byte\b/, "path-traversal"],
    [/\bdirectory\s*listing\b/, "dir-listing"],
    [/\bsensitive\s*data\b|\binformation\s*disclosure\b|\bunauthenticated\b.*\bconfig/, "info-disclosure"],
    [/\bupload\b/, "upload"],
    [/\bprivilege\b|\bvertical\b/, "priv-esc"],
    [/\bbusiness\s*logic\b|\bprice\b|\bquantity\b/, "business-logic"],
    [/\brace\b/, "race"],
  ];
  for (const [re, label] of checks) {
    if (re.test(titleNorm)) return label;
  }
  return "";
}

export function isConfirmedFindingAction(action: unknown): boolean {
  const value = String(action || "").toLowerCase();
  return value === "confirm" || value === "confirmed";
}

/** Dedupe confirmed records; keep highest severity then most evidence. */
export function aggregateConfirmedFindings(records: PersistedFindingRecord[]): AggregatedFindings {
  const confirmed = records.filter((row) => isConfirmedFindingAction(row.action) && String(row.title || "").trim());
  const byKey = new Map<string, PersistedFindingRecord>();
  for (const row of confirmed) {
    const key = findingDedupeKey(row);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      continue;
    }
    byKey.set(key, preferFindingRecord(existing, row));
  }
  const deduped = [...byKey.values()].sort((a, b) => {
    const sev = severityRank(b.severity) - severityRank(a.severity);
    if (sev !== 0) return sev;
    return String(a.title || "").localeCompare(String(b.title || ""));
  });
  const evidenceIds = uniqueStrings(
    deduped.flatMap((row) => (Array.isArray(row.evidence_ids) ? row.evidence_ids.map(String) : [])),
  );
  return {
    titles: deduped.map((row) => String(row.title || "").trim()).filter(Boolean),
    evidenceIds,
    records: deduped,
    rawCount: confirmed.length,
    dedupedCount: deduped.length,
  };
}

/** Prefer higher severity, then more evidence ids, then longer description. */
export function preferFindingRecord(a: PersistedFindingRecord, b: PersistedFindingRecord): PersistedFindingRecord {
  if (severityRank(b.severity) > severityRank(a.severity)) return mergeEvidence(b, a);
  if (severityRank(a.severity) > severityRank(b.severity)) return mergeEvidence(a, b);
  const aEv = Array.isArray(a.evidence_ids) ? a.evidence_ids.length : 0;
  const bEv = Array.isArray(b.evidence_ids) ? b.evidence_ids.length : 0;
  if (bEv > aEv) return mergeEvidence(b, a);
  if (aEv > bEv) return mergeEvidence(a, b);
  const aDesc = String(a.description || a.impact || "").length;
  const bDesc = String(b.description || b.impact || "").length;
  return mergeEvidence(bDesc > aDesc ? b : a, bDesc > aDesc ? a : b);
}

function mergeEvidence(primary: PersistedFindingRecord, secondary: PersistedFindingRecord): PersistedFindingRecord {
  const evidence = uniqueStrings([
    ...(Array.isArray(primary.evidence_ids) ? primary.evidence_ids.map(String) : []),
    ...(Array.isArray(secondary.evidence_ids) ? secondary.evidence_ids.map(String) : []),
  ]);
  return { ...primary, evidence_ids: evidence };
}

export async function loadPersistedFindings(findingsDir: string): Promise<PersistedFindingRecord[]> {
  let names: string[] = [];
  try {
    names = await readdir(findingsDir);
  } catch {
    return [];
  }
  const out: PersistedFindingRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(findingsDir, name), "utf8");
      const parsed = JSON.parse(raw) as PersistedFindingRecord;
      if (parsed && typeof parsed === "object") out.push({ ...parsed, _file: name });
    } catch {
      // skip corrupt files
    }
  }
  return out;
}

export async function loadAggregatedConfirmedFindings(findingsDir: string): Promise<AggregatedFindings> {
  const records = await loadPersistedFindings(findingsDir);
  return aggregateConfirmedFindings(records);
}

/** Find an existing confirmed finding on disk that matches the same dedupe key. */
export async function findExistingConfirmedByKey(
  findingsDir: string,
  record: PersistedFindingRecord,
): Promise<{ fileName: string; record: PersistedFindingRecord; key: string } | undefined> {
  const key = findingDedupeKey(record);
  const existing = await loadPersistedFindings(findingsDir);
  for (const row of existing) {
    if (!isConfirmedFindingAction(row.action)) continue;
    if (findingDedupeKey(row) !== key) continue;
    const fileName = String(row._file || "");
    if (!fileName) continue;
    return { fileName, record: row, key };
  }
  return undefined;
}

/**
 * Align free-text summary claim counts with the authoritative deduped finding count.
 * Does not invent report content — only rewrites numeric claim phrases when present.
 */
export function alignSummaryFindingCount(summary: string, dedupedCount: number): string {
  const text = String(summary || "");
  if (!text.trim()) return text;
  const n = Math.max(0, Math.floor(dedupedCount));
  let out = text;
  out = out.replace(
    /\*\*\s*\d+\s+confirmed vulnerabilities\s*\*\*/gi,
    `**${n} confirmed vulnerabilities**`,
  );
  out = out.replace(
    /\b\d+\s+confirmed vulnerabilities\b/gi,
    `${n} confirmed vulnerabilities`,
  );
  out = out.replace(/\b\d+\s+findings confirmed\b/gi, `${n} findings confirmed`);
  out = out.replace(/\*\*\s*\d+\s+findings confirmed\s*\*\*/gi, `**${n} findings confirmed**`);
  out = out.replace(
    /\b\d+\s+confirmed finding(?:s)?\b/gi,
    `${n} confirmed finding${n === 1 ? "" : "s"}`,
  );
  // Coverage blurb: "12 findings confirmed (12.5% ...)" — only the leading count.
  out = out.replace(
    /(\*\*\s*)\d+(\s+findings confirmed\s*\*\*)/gi,
    `$1${n}$2`,
  );
  return out;
}

function severityRank(value: unknown): number {
  const raw = String(value || "medium").toLowerCase();
  if (raw === "critical") return 5;
  if (raw === "high") return 4;
  if (raw === "medium") return 3;
  if (raw === "low") return 2;
  if (raw === "info" || raw === "informational") return 1;
  return 0;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}
