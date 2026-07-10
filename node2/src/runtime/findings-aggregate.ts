/**
 * Authoritative confirmed findings from disk for finish_scan.
 * LLM-supplied title lists are optional hints only.
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
 * Deterministic dedupe key: prefer location fingerprint + severity class tokens from title.
 * Near-duplicate titles on the same endpoint collapse.
 */
export function findingDedupeKey(record: PersistedFindingRecord): string {
  const location = normalizeFindingText(record.location || record.url || record.affected_asset || "");
  const title = normalizeFindingText(record.title || "");
  const classHint = extractClassHint(title);
  // Severity is not part of the key: near-dupes collapse; highest severity is kept.
  if (location && classHint) return `${classHint}|${location}`;
  if (location) return `${location}|${title.slice(0, 80)}`;
  return title || "finding";
}

function extractClassHint(titleNorm: string): string {
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
    [/\bpath\s*traversal\b|\blfi\b/, "path-traversal"],
    [/\bupload\b/, "upload"],
    [/\bprivilege\b|\bvertical\b/, "priv-esc"],
    [/\bbusiness\s*logic\b|\bprice\b|\bquantity\b/, "business-logic"],
    [/\brace\b/, "race"],
  ];
  for (const [re, label] of checks) {
    if (re.test(titleNorm)) return label;
  }
  // Fallback: first 4 content tokens of title.
  return titleNorm.split(" ").filter(Boolean).slice(0, 4).join("-") || "finding";
}

export function isConfirmedFindingAction(action: unknown): boolean {
  const value = String(action || "").toLowerCase();
  return value === "confirm" || value === "confirmed";
}

/** Dedupe confirmed records; keep highest severity then earliest created_at. */
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
    if (severityRank(row.severity) > severityRank(existing.severity)) {
      byKey.set(key, row);
      continue;
    }
    if (severityRank(row.severity) === severityRank(existing.severity)) {
      // Prefer the record with more evidence ids.
      const nextEv = Array.isArray(row.evidence_ids) ? row.evidence_ids.length : 0;
      const prevEv = Array.isArray(existing.evidence_ids) ? existing.evidence_ids.length : 0;
      if (nextEv > prevEv) byKey.set(key, row);
    }
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
      if (parsed && typeof parsed === "object") out.push(parsed);
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
