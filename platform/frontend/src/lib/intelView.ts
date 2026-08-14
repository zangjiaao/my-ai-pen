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
  if (row.is_new === false) return false;
  const cur = String(currentTaskId || "").trim();
  const created = String(row.created_task_id || "").trim();
  return Boolean(cur && created && cur === created);
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
