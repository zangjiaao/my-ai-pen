/**
 * Spec #309 — Case traffic audit panel projection (S3/S4 pure seams).
 *
 * N3 default view filter is FE-only; store may keep fuller browser rows (F2).
 */

export type TrafficSource = "http" | "browser" | "mitm" | string;
export type TrafficPhase = "pending" | "completed" | "failed" | string;

export type TrafficExchange = {
  exchange_id?: string;
  conversation_id?: string;
  sequence?: number | null;
  source?: TrafficSource;
  phase?: TrafficPhase;
  method?: string;
  url?: string;
  request_headers?: Record<string, string> | null;
  request_body?: string | null;
  status_code?: number | null;
  response_headers?: Record<string, string> | null;
  response_body?: string | null;
  content_type?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  duration_ms?: number | null;
  error?: string | null;
  request_body_truncated?: boolean;
  response_body_truncated?: boolean;
  request_body_bytes?: number | null;
  response_body_bytes?: number | null;
  request_body_hash?: string | null;
  response_body_hash?: string | null;
  request_body_binary?: boolean;
  response_body_binary?: boolean;
  browser_resource_class?: string | null;
  is_websocket?: boolean;
  [key: string]: unknown;
};

/** L1 list row for the Traffic tab. */
export type TrafficListRow = {
  exchange_id: string;
  /** Capture order (higher = newer); list is newest-first. */
  index: number;
  method: string;
  domain: string;
  path: string;
  status: string;
  /** Display source: http | browser | curl (shell mapped to curl). */
  source: string;
  /** Duration label (耗时), e.g. "42ms" / "1.2s" / "…". */
  duration: string;
  phase: string;
  url: string;
  pending: boolean;
  /** Raw store source for filtering (http|browser|shell|…). */
  sourceRaw: string;
};

/** Source filter options in the Traffic toolbar. */
export type TrafficSourceFilter = "all" | "http" | "browser" | "curl";

export const TRAFFIC_EMPTY_COPY = "No captured exchanges yet.";
/** Browser resource classes shown under N3 default view. */
const N3_BROWSER_CLASSES = new Set([
  "document",
  "xhr",
  "fetch",
  "websocket",
  "xmlhttprequest",
  "main_frame",
  "mainframe",
]);

export function isN3DefaultVisible(exchange: TrafficExchange): boolean {
  const source = String(exchange.source || "http").toLowerCase();
  if (source === "http" || source === "shell" || source === "mitm") return true;
  if (source !== "browser") return true;
  if (exchange.is_websocket) return true;
  const cls = String(exchange.browser_resource_class || "").toLowerCase();
  if (!cls) {
    // Unknown class: show (do not hide real API traffic missing type metadata).
    return true;
  }
  return N3_BROWSER_CLASSES.has(cls);
}

export function filterTrafficDefaultView(exchanges: TrafficExchange[]): TrafficExchange[] {
  return exchanges.filter(isN3DefaultVisible);
}

/** Split URL into domain (host[:port]) and path+query for list columns. */
export function domainPathFromUrl(url: string): { domain: string; path: string } {
  const raw = String(url || "").trim();
  if (!raw) return { domain: "", path: "" };
  try {
    const u = new URL(raw);
    const path = `${u.pathname || "/"}${u.search || ""}` || "/";
    return { domain: u.host || "", path };
  } catch {
    // Bare path or non-URL
    if (raw.startsWith("/")) return { domain: "", path: raw };
    const slash = raw.indexOf("/");
    if (slash > 0) {
      return { domain: raw.slice(0, slash), path: raw.slice(slash) };
    }
    return { domain: raw, path: "/" };
  }
}

/** Shell capture surfaces as curl in Source column / detail chrome. */
export function trafficSourceDisplay(source: string | null | undefined): string {
  const s = String(source || "http").toLowerCase();
  if (s === "shell") return "curl";
  return s || "http";
}

/** Format duration_ms as human 耗时; pending/missing → "…". */
export function formatTrafficDuration(durationMs: number | null | undefined, pending?: boolean): string {
  if (pending) return "…";
  if (durationMs == null || !Number.isFinite(Number(durationMs))) return "—";
  const ms = Math.max(0, Number(durationMs));
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}
/**
 * L1 list: newest first (sequence desc, then started_at desc).
 * Columns: index, method, domain, path, status, source, duration.
 */
export function projectTrafficListRows(
  exchanges: TrafficExchange[],
  options?: { applyN3?: boolean },
): TrafficListRow[] {
  const applyN3 = options?.applyN3 !== false;
  const list = applyN3 ? filterTrafficDefaultView(exchanges) : exchanges.slice();
  const sorted = list.slice().sort((a, b) => {
    const sa = Number(a.sequence ?? 0);
    const sb = Number(b.sequence ?? 0);
    if (sa !== sb) return sb - sa; // newest (higher sequence) first
    return String(b.started_at || "").localeCompare(String(a.started_at || ""));
  });
  const maxSeq = sorted.reduce((m, ex) => Math.max(m, Number(ex.sequence || 0)), 0);
  return sorted.map((ex, i) => {
    const phase = String(ex.phase || "pending");
    const pending = phase === "pending";
    let status = "…";
    if (pending) status = "pending";
    else if (phase === "failed") status = ex.error ? "err" : "failed";
    else if (ex.status_code != null) status = String(ex.status_code);
    const url = String(ex.url || "");
    const { domain, path } = domainPathFromUrl(url);
    const sourceRaw = String(ex.source || "http").toLowerCase();
    const seq = Number(ex.sequence);
    const index = Number.isFinite(seq) && seq > 0 ? seq : maxSeq > 0 ? maxSeq - i : sorted.length - i;
    return {
      exchange_id: String(ex.exchange_id || ""),
      index,
      method: String(ex.method || "GET").toUpperCase(),
      domain,
      path,
      status,
      source: trafficSourceDisplay(sourceRaw),
      duration: formatTrafficDuration(ex.duration_ms, pending),
      phase,
      url,
      pending,
      sourceRaw,
    };
  });
}

/** Toolbar search + source filter over projected rows (client-side). */
export function filterTrafficListRows(
  rows: TrafficListRow[],
  options?: { query?: string; source?: TrafficSourceFilter },
): TrafficListRow[] {
  const q = String(options?.query || "")
    .trim()
    .toLowerCase();
  const source = (options?.source || "all") as TrafficSourceFilter;
  return rows.filter((row) => {
    if (source !== "all") {
      if (source === "curl") {
        if (row.sourceRaw !== "shell" && row.source !== "curl") return false;
      } else if (row.sourceRaw !== source && row.source !== source) {
        return false;
      }
    }
    if (!q) return true;
    const hay = [
      String(row.index),
      row.method,
      row.domain,
      row.path,
      row.status,
      row.source,
      row.url,
      row.duration,
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}
/** Align with platform merge_exchange: pending < completed|failed. */
const PHASE_RANK: Record<string, number> = {
  pending: 0,
  completed: 1,
  failed: 1,
};

function phaseRank(phase: string | null | undefined): number {
  const p = String(phase || "pending").toLowerCase();
  return PHASE_RANK[p] ?? 0;
}

/**
 * Upsert by exchange_id with phase-ranked merge (Spec #309 R2 / platform merge_exchange).
 * Terminal wins over pending; stale pending must not clobber completed response fields.
 */
export function upsertTrafficExchange(
  list: TrafficExchange[],
  incoming: TrafficExchange,
): TrafficExchange[] {
  const id = String(incoming.exchange_id || "").trim();
  if (!id) return list;
  const idx = list.findIndex((row) => String(row.exchange_id || "") === id);
  if (idx < 0) return [...list, incoming];
  const existing = list[idx];
  const out: TrafficExchange = { ...existing };
  out.exchange_id = id;
  if (incoming.conversation_id != null) {
    out.conversation_id = existing.conversation_id || incoming.conversation_id;
  }
  if (incoming.sequence != null) out.sequence = incoming.sequence;

  const requestKeys = [
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
  ] as const;
  for (const key of requestKeys) {
    const val = incoming[key];
    if (val === undefined) continue;
    if (
      (key === "request_body" || key === "request_headers") &&
      existing[key] &&
      (val === null || val === undefined)
    ) {
      continue;
    }
    if (val !== null) (out as Record<string, unknown>)[key] = val;
  }

  const oldRank = phaseRank(existing.phase);
  const newRank = phaseRank(incoming.phase);
  // Only advance or equal phase may overwrite response/terminal fields.
  if (newRank >= oldRank) {
    if (incoming.phase != null) out.phase = incoming.phase;
    const responseKeys = [
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
    ] as const;
    for (const key of responseKeys) {
      if (key in incoming) {
        (out as Record<string, unknown>)[key] = incoming[key];
      }
    }
  }
  // newRank < oldRank: keep existing terminal phase/response; request-side merge above still applied.

  const next = list.slice();
  next[idx] = out;
  return next;
}

export type TrafficDetailView = {
  exchange_id: string;
  method: string;
  url: string;
  status_code: number | null;
  phase: string;
  source: string;
  waiting_response: boolean;
  request_headers: Record<string, string> | null;
  request_body: string | null;
  response_headers: Record<string, string> | null;
  response_body: string | null;
  request_truncated: boolean;
  response_truncated: boolean;
  request_bytes: number | null;
  response_bytes: number | null;
  request_hash: string | null;
  response_hash: string | null;
  request_binary: boolean;
  response_binary: boolean;
  error: string | null;
  content_type: string | null;
};

export function projectTrafficDetail(exchange: TrafficExchange | null | undefined): TrafficDetailView | null {
  if (!exchange || !exchange.exchange_id) return null;
  const phase = String(exchange.phase || "pending");
  return {
    exchange_id: String(exchange.exchange_id),
    method: String(exchange.method || "GET").toUpperCase(),
    url: String(exchange.url || ""),
    status_code: exchange.status_code == null ? null : Number(exchange.status_code),
    phase,
    source: String(exchange.source || "http"),
    waiting_response: phase === "pending",
    request_headers: (exchange.request_headers as Record<string, string> | null) ?? null,
    request_body: exchange.request_body ?? null,
    response_headers: (exchange.response_headers as Record<string, string> | null) ?? null,
    response_body: exchange.response_body ?? null,
    request_truncated: Boolean(exchange.request_body_truncated),
    response_truncated: Boolean(exchange.response_body_truncated),
    request_bytes: exchange.request_body_bytes == null ? null : Number(exchange.request_body_bytes),
    response_bytes: exchange.response_body_bytes == null ? null : Number(exchange.response_body_bytes),
    request_hash: exchange.request_body_hash ? String(exchange.request_body_hash) : null,
    response_hash: exchange.response_body_hash ? String(exchange.response_body_hash) : null,
    request_binary: Boolean(exchange.request_body_binary),
    response_binary: Boolean(exchange.response_body_binary),
    error: exchange.error != null ? String(exchange.error) : null,
    content_type: exchange.content_type != null ? String(exchange.content_type) : null,
  };
}

export function formatHeadersBlock(headers: Record<string, string> | null | undefined): string {
  if (!headers || !Object.keys(headers).length) return "(no headers)";
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

export function bodyDisplayText(options: {
  body: string | null;
  binary?: boolean;
  truncated?: boolean;
  bytes?: number | null;
  hash?: string | null;
  waiting?: boolean;
  emptyLabel?: string;
}): string {
  if (options.waiting) return "(waiting for response…)";
  if (options.binary) {
    const meta = [
      "binary body omitted",
      options.bytes != null ? `${options.bytes} bytes` : null,
      options.hash ? `sha256:${options.hash}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return `(${meta})`;
  }
  if (options.body == null || options.body === "") {
    return options.emptyLabel || "(empty)";
  }
  let text = options.body;
  if (options.truncated) {
    const meta = [
      "truncated",
      options.bytes != null ? `full ${options.bytes} bytes` : null,
      options.hash ? `sha256:${options.hash}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    text = `${text}\n\n… [${meta}]`;
  }
  return text;
}
