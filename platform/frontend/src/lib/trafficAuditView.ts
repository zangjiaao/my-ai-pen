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
  method: string;
  status: string;
  hostPath: string;
  time: string;
  source: string;
  phase: string;
  url: string;
  pending: boolean;
};

export const TRAFFIC_HONESTY_LINE =
  "Tool-channel capture (http + browser network). Default hides static assets. Not full-site MITM; shell/other egress excluded.";

export const TRAFFIC_EMPTY_COPY =
  "No captured exchanges yet. Traffic appears when the Agent runs the http tool or browser network is observed — not MITM, not shell/curl.";

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
  if (source === "http" || source === "mitm") return true;
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

export function hostPathFromUrl(url: string): string {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    return `${u.host}${u.pathname}${u.search}`;
  } catch {
    return raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
  }
}

export function formatTrafficTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(11, 19) || String(iso);
  return d.toLocaleTimeString(undefined, { hour12: false });
}

export function projectTrafficListRows(
  exchanges: TrafficExchange[],
  options?: { applyN3?: boolean },
): TrafficListRow[] {
  const applyN3 = options?.applyN3 !== false;
  const list = applyN3 ? filterTrafficDefaultView(exchanges) : exchanges.slice();
  const sorted = list.slice().sort((a, b) => {
    const sa = Number(a.sequence || 0);
    const sb = Number(b.sequence || 0);
    if (sa !== sb) return sa - sb;
    return String(a.started_at || "").localeCompare(String(b.started_at || ""));
  });
  return sorted.map((ex) => {
    const phase = String(ex.phase || "pending");
    const pending = phase === "pending";
    let status = "…";
    if (pending) status = "pending";
    else if (phase === "failed") status = ex.error ? `err` : "failed";
    else if (ex.status_code != null) status = String(ex.status_code);
    return {
      exchange_id: String(ex.exchange_id || ""),
      method: String(ex.method || "GET").toUpperCase(),
      status,
      hostPath: hostPathFromUrl(String(ex.url || "")),
      time: formatTrafficTime(ex.started_at || ex.completed_at),
      source: String(ex.source || "http"),
      phase,
      url: String(ex.url || ""),
      pending,
    };
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
