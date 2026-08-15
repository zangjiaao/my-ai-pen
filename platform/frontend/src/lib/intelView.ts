/** Owner-ledger Intel projection helpers — Spec owner-intel.md. */

export type IntelStatus = "active" | "forgotten" | "sealed";

export type IntelRow = {
  id?: string;
  asset_id?: string;
  port?: string | null;
  kind?: string;
  summary?: string;
  body?: string;
  status?: string;
  forget_count?: number;
  access_count?: number;
  is_new?: boolean;
  created_task_id?: string | null;
  source?: string;
  created_at?: string | null;
  updated_at?: string | null;
};

export function statusFromForgetCount(count: unknown): IntelStatus {
  const n = Number(count || 0);
  if (!Number.isFinite(n) || n <= 0) return "active";
  if (n === 1) return "forgotten";
  return "sealed";
}

export function intelStatus(row: IntelRow): IntelStatus {
  const raw = String(row.status || "").trim().toLowerCase();
  if (raw === "active" || raw === "forgotten" || raw === "sealed") return raw;
  return statusFromForgetCount(row.forget_count);
}

export function isIntelNew(row: IntelRow, currentTaskId?: string | null): boolean {
  if (row.is_new === true) return true;
  const cur = String(currentTaskId || "").trim();
  const created = String(row.created_task_id || "").trim();
  if (cur && created && cur === created) return true;
  return false;
}

export function accessCount(row: IntelRow | null | undefined): number {
  const n = Number(row?.access_count ?? 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

export function hangLabel(row: IntelRow): string {
  const port = String(row.port || "").trim();
  const asset = String(row.asset_id || "").trim();
  if (asset && port) return `${asset}:${port}`;
  if (port) return `:${port}`;
  return asset || "";
}

export function filterIntelRows(rows: IntelRow[] | undefined | null, view: IntelStatus | "all"): IntelRow[] {
  const list = Array.isArray(rows) ? rows : [];
  if (view === "all") return list;
  return list.filter((row) => intelStatus(row) === view);
}

export function upsertIntelRow(prev: IntelRow[], incoming: IntelRow): IntelRow[] {
  const id = String(incoming.id || "").trim();
  if (!id) return prev;
  const next = prev.filter((row) => String(row.id || "") !== id);
  next.unshift(incoming);
  return next;
}

/**
 * Snapshot is SoT for ids it includes. Keep live-only rows (intel_upsert that
 * raced a refresh) so 线索 does not flash New and then vanish.
 */
export function mergeIntelSnapshot(prev: IntelRow[], incoming: IntelRow[]): IntelRow[] {
  const next = Array.isArray(incoming) ? incoming.filter((row) => String(row.id || "").trim()) : [];
  const seen = new Set(next.map((row) => String(row.id || "").trim()));
  const extras = (Array.isArray(prev) ? prev : []).filter((row) => {
    const id = String(row.id || "").trim();
    return Boolean(id && !seen.has(id));
  });
  return extras.length ? [...extras, ...next] : next;
}
