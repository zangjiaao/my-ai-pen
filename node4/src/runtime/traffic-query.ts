/**
 * Spec #378 — Agent traffic raw-material query (latest + paginated).
 *
 * Session ring buffer filled by Runtime collect hooks (#309). Query only —
 * never writes surface ledger. Prefer summary rows (no bodies by default).
 */

import type { ToolRuntime } from "../types.js";
import type { TrafficExchange } from "./traffic-collect.js";

/** Soft cap matches platform DEFAULT_ROW_CAP for session material. */
export const TRAFFIC_STORE_CAP = 500;

export type TrafficStoreHost = {
  trafficById?: Map<string, TrafficExchange>;
};

export type TrafficSummaryRow = {
  exchange_id: string;
  sequence: number | null;
  method: string;
  host: string;
  path: string;
  status_code: number | null;
  source: string;
  phase: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  browser_resource_class?: string | null;
  error?: string | null;
  content_type?: string | null;
  is_websocket?: boolean;
};

export type TrafficPathAgg = {
  origin: string;
  path: string;
  methods: string[];
  sources: string[];
  status_codes: number[];
  count: number;
  last_sequence: number | null;
  last_at: string | null;
};

export type TrafficListQuery = {
  /** Max rows to return (default 20, max 200). */
  limit?: number;
  /** Skip first N after sort (default 0). */
  offset?: number;
  /** Delta: only rows with sequence > since_sequence. */
  since_sequence?: number;
  /** Include request/response bodies (default false). */
  include_bodies?: boolean;
  /** Attach path aggregation over the filtered set (default false). */
  aggregate_paths?: boolean;
  /** Fetch one exchange by id (ignores offset; bodies only if include_bodies). */
  exchange_id?: string;
};

export type TrafficListResult = {
  ok: true;
  total: number;
  offset: number;
  limit: number;
  has_more: boolean;
  next_offset: number | null;
  max_sequence: number | null;
  exchanges: Array<TrafficSummaryRow | TrafficExchange>;
  path_summary?: TrafficPathAgg[];
  note: string;
};

export function getTrafficStore(host: TrafficStoreHost | ToolRuntime): Map<string, TrafficExchange> {
  const life = ("lifecycle" in host ? host.lifecycle : host) as TrafficStoreHost;
  if (life.trafficById instanceof Map) return life.trafficById;
  const map = new Map<string, TrafficExchange>();
  life.trafficById = map;
  return map;
}

/**
 * Upsert exchange into session store. Does not touch surface ledger or platform.
 * Cap by dropping lowest sequence / oldest started_at first.
 */
export function rememberTrafficExchange(
  host: TrafficStoreHost | ToolRuntime,
  exchange: TrafficExchange,
): void {
  if (!exchange?.exchange_id) return;
  const store = getTrafficStore(host);
  const prev = store.get(exchange.exchange_id);
  store.set(exchange.exchange_id, prev ? mergeLocalExchange(prev, exchange) : { ...exchange });

  if (store.size <= TRAFFIC_STORE_CAP) return;
  const ordered = [...store.values()].sort(compareTrafficAsc);
  const dropN = store.size - TRAFFIC_STORE_CAP;
  for (let i = 0; i < dropN; i += 1) {
    const id = ordered[i]?.exchange_id;
    if (id) store.delete(id);
  }
}

/** Later phase wins response fields; preserve request side (mirror platform merge). */
export function mergeLocalExchange(existing: TrafficExchange, incoming: TrafficExchange): TrafficExchange {
  const out: TrafficExchange = { ...existing };
  out.exchange_id = existing.exchange_id || incoming.exchange_id;
  out.conversation_id = existing.conversation_id || incoming.conversation_id;
  if (incoming.sequence != null) out.sequence = incoming.sequence;
  for (const key of [
    "task_id",
    "source",
    "method",
    "url",
    "started_at",
    "browser_resource_class",
    "is_websocket",
    "request_headers",
    "request_body",
    "request_body_truncated",
    "request_body_bytes",
    "request_body_hash",
    "request_body_binary",
  ] as const) {
    const v = incoming[key];
    if (v === undefined || v === null) continue;
    if (
      (key === "request_body" || key === "request_headers") &&
      existing[key] &&
      (incoming[key] === null || incoming[key] === undefined)
    ) {
      continue;
    }
    (out as any)[key] = v;
  }
  const phaseRank = (p: string | null | undefined) =>
    p === "completed" || p === "failed" ? 1 : 0;
  const oldPhase = String(existing.phase || "pending");
  const newPhase = String(incoming.phase || oldPhase);
  if (phaseRank(newPhase) >= phaseRank(oldPhase)) {
    out.phase = newPhase as TrafficExchange["phase"];
    for (const key of [
      "status_code",
      "response_headers",
      "response_body",
      "content_type",
      "completed_at",
      "duration_ms",
      "error",
      "response_body_truncated",
      "response_body_bytes",
      "response_body_hash",
      "response_body_binary",
    ] as const) {
      if (key in incoming) (out as any)[key] = (incoming as any)[key];
    }
  }
  out.type = "traffic_exchange";
  return out;
}

export function compareTrafficAsc(a: TrafficExchange, b: TrafficExchange): number {
  const sa = Number(a.sequence ?? 0);
  const sb = Number(b.sequence ?? 0);
  if (sa !== sb) return sa - sb;
  const ta = String(a.started_at || "");
  const tb = String(b.started_at || "");
  if (ta !== tb) return ta < tb ? -1 : ta > tb ? 1 : 0;
  return String(a.exchange_id).localeCompare(String(b.exchange_id));
}

/** Newest-first for agent "latest" reads. */
export function compareTrafficDesc(a: TrafficExchange, b: TrafficExchange): number {
  return -compareTrafficAsc(a, b);
}

export function parseUrlParts(url: string): { host: string; path: string; origin: string } {
  try {
    const u = new URL(String(url || ""));
    return {
      host: u.host || u.hostname || "",
      path: u.pathname || "/",
      origin: u.origin || "",
    };
  } catch {
    const raw = String(url || "");
    const m = raw.match(/^(https?:\/\/[^/?#]+)(\/[^?#]*)?/i);
    if (m) {
      try {
        const u = new URL(m[1] + (m[2] || "/"));
        return { host: u.host, path: u.pathname || "/", origin: u.origin };
      } catch {
        /* fall through */
      }
    }
    return { host: "", path: raw || "/", origin: "" };
  }
}

export function projectTrafficSummary(ex: TrafficExchange): TrafficSummaryRow {
  const parts = parseUrlParts(ex.url || "");
  return {
    exchange_id: ex.exchange_id,
    sequence: ex.sequence ?? null,
    method: ex.method || "GET",
    host: parts.host,
    path: parts.path,
    status_code: ex.status_code ?? null,
    source: ex.source,
    phase: ex.phase,
    started_at: ex.started_at,
    completed_at: ex.completed_at ?? null,
    duration_ms: ex.duration_ms ?? null,
    browser_resource_class: ex.browser_resource_class ?? null,
    error: ex.error ?? null,
    content_type: ex.content_type ?? null,
    is_websocket: Boolean(ex.is_websocket),
  };
}

export function aggregateTrafficByPath(exchanges: TrafficExchange[]): TrafficPathAgg[] {
  const map = new Map<string, TrafficPathAgg>();
  for (const ex of exchanges) {
    const parts = parseUrlParts(ex.url || "");
    const key = `${parts.origin}\0${parts.path}`;
    let row = map.get(key);
    if (!row) {
      row = {
        origin: parts.origin,
        path: parts.path,
        methods: [],
        sources: [],
        status_codes: [],
        count: 0,
        last_sequence: null,
        last_at: null,
      };
      map.set(key, row);
    }
    row.count += 1;
    const method = String(ex.method || "GET").toUpperCase();
    if (method && !row.methods.includes(method)) row.methods.push(method);
    const source = String(ex.source || "");
    if (source && !row.sources.includes(source)) row.sources.push(source);
    if (ex.status_code != null && !row.status_codes.includes(ex.status_code)) {
      row.status_codes.push(ex.status_code);
    }
    const seq = ex.sequence ?? null;
    if (seq != null && (row.last_sequence == null || seq >= row.last_sequence)) {
      row.last_sequence = seq;
      row.last_at = ex.completed_at || ex.started_at || row.last_at;
    } else if (row.last_sequence == null) {
      row.last_at = ex.completed_at || ex.started_at || row.last_at;
    }
  }
  return [...map.values()].sort((a, b) => {
    const ca = b.count - a.count;
    if (ca !== 0) return ca;
    return `${a.origin}${a.path}`.localeCompare(`${b.origin}${b.path}`);
  });
}

/**
 * Pure list/query over a store. Newest-first page; summary rows unless include_bodies.
 * Does not write surface ledger or mutate store.
 */
export function queryTrafficExchanges(
  store: Map<string, TrafficExchange> | Iterable<TrafficExchange> | TrafficExchange[],
  query: TrafficListQuery = {},
): TrafficListResult {
  const limit = Math.min(200, Math.max(1, Number(query.limit ?? 20) || 20));
  const offset = Math.max(0, Number(query.offset ?? 0) || 0);
  const since =
    query.since_sequence != null && query.since_sequence !== ("" as any)
      ? Number(query.since_sequence)
      : null;
  const includeBodies = Boolean(query.include_bodies);
  const wantAgg = Boolean(query.aggregate_paths);
  const wantId = String(query.exchange_id || "").trim();

  let rows: TrafficExchange[];
  if (store instanceof Map) {
    rows = [...store.values()];
  } else if (Array.isArray(store)) {
    rows = [...store];
  } else {
    rows = [...store];
  }

  if (wantId) {
    const one = rows.find((r) => r.exchange_id === wantId);
    const exchanges = one
      ? [includeBodies ? { ...one } : projectTrafficSummary(one)]
      : [];
    return {
      ok: true,
      total: exchanges.length,
      offset: 0,
      limit: 1,
      has_more: false,
      next_offset: null,
      max_sequence: one?.sequence ?? null,
      exchanges,
      note: one
        ? includeBodies
          ? "Single exchange with bodies (raw material; not surface ledger)."
          : "Single exchange summary (set include_bodies=true for raw bodies)."
        : "exchange_id not found in session traffic store.",
    };
  }

  if (since != null && Number.isFinite(since)) {
    rows = rows.filter((r) => Number(r.sequence ?? 0) > since);
  }

  rows.sort(compareTrafficDesc);
  const total = rows.length;
  const page = rows.slice(offset, offset + limit);
  const maxSeq = rows.reduce<number | null>((acc, r) => {
    const s = r.sequence;
    if (s == null) return acc;
    if (acc == null || s > acc) return s;
    return acc;
  }, null);

  const has_more = offset + page.length < total;
  const result: TrafficListResult = {
    ok: true,
    total,
    offset,
    limit,
    has_more,
    next_offset: has_more ? offset + page.length : null,
    max_sequence: maxSeq,
    exchanges: page.map((ex) => (includeBodies ? { ...ex } : projectTrafficSummary(ex))),
    note:
      "Session capture raw material (Runtime hook store). Summaries omit bodies by default. " +
      "Does not deposit surface ledger — use surface(op=upsert) after analysis.",
  };
  if (wantAgg) {
    // Aggregate over the filtered set (not only the page) for recon overview.
    result.path_summary = aggregateTrafficByPath(rows);
  }
  return result;
}

/** Tool-facing entry: read session store from runtime. */
export function listRuntimeTraffic(
  runtime: ToolRuntime,
  query: TrafficListQuery = {},
): TrafficListResult {
  return queryTrafficExchanges(getTrafficStore(runtime), query);
}
