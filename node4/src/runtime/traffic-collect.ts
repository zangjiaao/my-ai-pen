/**
 * Spec #309 — Case traffic audit collect (Node Runtime hook side).
 *
 * Passive instrumentation on `http` + browser network. No Agent traffic tools.
 * Platform Case store is panel SoT; act-observation memory remains booking-only.
 */

import { createHash } from "node:crypto";
import type { PlatformSink, TaskEnvelope, ToolRuntime } from "../types.js";

export type TrafficSource = "http" | "browser" | "mitm";
export type TrafficPhase = "pending" | "completed" | "failed";
export type BrowserResourceClass =
  | "document"
  | "xhr"
  | "fetch"
  | "websocket"
  | "stylesheet"
  | "script"
  | "image"
  | "font"
  | "media"
  | "other";

/** Capture-time body ceiling (product default; Spec allows ≤1 MiB research start). */
export const DEFAULT_BODY_BUDGET = 64 * 1024;

export type TrafficExchange = {
  type: "traffic_exchange";
  exchange_id: string;
  conversation_id: string;
  task_id?: string;
  sequence?: number;
  source: TrafficSource;
  phase: TrafficPhase;
  method: string;
  url: string;
  request_headers?: Record<string, string> | null;
  request_body?: string | null;
  status_code?: number | null;
  response_headers?: Record<string, string> | null;
  response_body?: string | null;
  content_type?: string | null;
  started_at: string;
  completed_at?: string | null;
  duration_ms?: number | null;
  error?: string | null;
  request_body_truncated?: boolean;
  response_body_truncated?: boolean;
  request_body_bytes?: number;
  response_body_bytes?: number;
  request_body_hash?: string | null;
  response_body_hash?: string | null;
  request_body_binary?: boolean;
  response_body_binary?: boolean;
  browser_resource_class?: BrowserResourceClass | null;
  is_websocket?: boolean;
};

export type BodyCapture = {
  text: string | null;
  truncated: boolean;
  bytes: number;
  hash: string | null;
  binary: boolean;
};

export function newExchangeId(source: TrafficSource = "http"): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `tx_${source}_${Date.now().toString(36)}_${rand}`;
}

export function nextSequence(runtime: ToolRuntime): number {
  const life = runtime.lifecycle as { trafficSequence?: number };
  const n = Math.max(0, Number(life.trafficSequence || 0)) + 1;
  life.trafficSequence = n;
  return n;
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

export function isLikelyBinary(contentType: string | null | undefined, sample: string): boolean {
  const ct = String(contentType || "").toLowerCase();
  if (
    ct.includes("octet-stream") ||
    ct.includes("image/") ||
    ct.includes("audio/") ||
    ct.includes("video/") ||
    ct.includes("font/") ||
    ct.includes("application/pdf") ||
    ct.includes("application/zip") ||
    ct.includes("application/gzip") ||
    ct.includes("wasm")
  ) {
    return true;
  }
  if (sample.includes("\u0000")) return true;
  return false;
}

export function captureBody(
  raw: string | null | undefined,
  options?: {
    budget?: number;
    contentType?: string | null;
  },
): BodyCapture {
  if (raw == null) {
    return { text: null, truncated: false, bytes: 0, hash: null, binary: false };
  }
  const full = String(raw);
  const bytes = Buffer.byteLength(full, "utf8");
  const budget = Math.max(0, options?.budget ?? DEFAULT_BODY_BUDGET);
  const binary = isLikelyBinary(options?.contentType, full.slice(0, 512));
  if (binary) {
    return {
      text: null,
      truncated: true,
      bytes,
      hash: contentHash(full),
      binary: true,
    };
  }
  if (bytes <= budget) {
    return {
      text: full,
      truncated: false,
      bytes,
      hash: contentHash(full),
      binary: false,
    };
  }
  let cut = full.slice(0, budget);
  while (Buffer.byteLength(cut, "utf8") > budget && cut.length > 0) {
    cut = cut.slice(0, Math.floor(cut.length * 0.9));
  }
  return {
    text: cut,
    truncated: true,
    bytes,
    hash: contentHash(full),
    binary: false,
  };
}

export function headersToRecord(
  headers: Headers | Record<string, string> | null | undefined,
): Record<string, string> | null {
  if (!headers) return null;
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (typeof headers === "object") {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (v != null) out[String(k)] = String(v);
    }
    return out;
  }
  return null;
}

export function buildPendingHttpExchange(input: {
  conversationId: string;
  taskId?: string;
  sequence?: number;
  method: string;
  url: string;
  requestHeaders?: Record<string, string> | null;
  requestBody?: string | null;
  bodyBudget?: number;
  startedAt?: string;
}): TrafficExchange {
  const req = captureBody(input.requestBody, { budget: input.bodyBudget });
  return {
    type: "traffic_exchange",
    exchange_id: newExchangeId("http"),
    conversation_id: input.conversationId,
    task_id: input.taskId,
    sequence: input.sequence,
    source: "http",
    phase: "pending",
    method: String(input.method || "GET").toUpperCase(),
    url: String(input.url || ""),
    request_headers: input.requestHeaders ?? null,
    request_body: req.text,
    status_code: null,
    response_headers: null,
    response_body: null,
    content_type: null,
    started_at: input.startedAt || new Date().toISOString(),
    completed_at: null,
    duration_ms: null,
    error: null,
    request_body_truncated: req.truncated,
    response_body_truncated: false,
    request_body_bytes: req.bytes,
    response_body_bytes: 0,
    request_body_hash: req.hash,
    response_body_hash: null,
    request_body_binary: req.binary,
    response_body_binary: false,
  };
}

export function completeExchange(
  pending: TrafficExchange,
  input: {
    statusCode: number;
    responseHeaders?: Record<string, string> | null;
    responseBody?: string | null;
    contentType?: string | null;
    bodyBudget?: number;
    completedAt?: string;
  },
): TrafficExchange {
  const contentType =
    input.contentType ||
    (input.responseHeaders &&
      (input.responseHeaders["content-type"] || input.responseHeaders["Content-Type"])) ||
    null;
  const res = captureBody(input.responseBody, {
    budget: input.bodyBudget,
    contentType,
  });
  const completedAt = input.completedAt || new Date().toISOString();
  const startedMs = Date.parse(pending.started_at);
  const completedMs = Date.parse(completedAt);
  const duration_ms =
    Number.isFinite(startedMs) && Number.isFinite(completedMs)
      ? Math.max(0, completedMs - startedMs)
      : null;
  return {
    ...pending,
    phase: "completed",
    status_code: Number(input.statusCode),
    response_headers: input.responseHeaders ?? null,
    response_body: res.text,
    content_type: contentType,
    completed_at: completedAt,
    duration_ms,
    error: null,
    response_body_truncated: res.truncated,
    response_body_bytes: res.bytes,
    response_body_hash: res.hash,
    response_body_binary: res.binary,
  };
}

export function failExchange(
  pending: TrafficExchange,
  error: string,
  completedAt?: string,
): TrafficExchange {
  const done = completedAt || new Date().toISOString();
  const startedMs = Date.parse(pending.started_at);
  const completedMs = Date.parse(done);
  const duration_ms =
    Number.isFinite(startedMs) && Number.isFinite(completedMs)
      ? Math.max(0, completedMs - startedMs)
      : null;
  return {
    ...pending,
    phase: "failed",
    status_code: null,
    completed_at: done,
    duration_ms,
    error: String(error || "request failed").slice(0, 2000),
  };
}

export function mapBrowserResourceClass(raw: string | null | undefined): BrowserResourceClass {
  const t = String(raw || "").toLowerCase();
  if (t === "document" || t === "main_frame" || t === "mainframe") return "document";
  if (t === "xhr" || t === "xmlhttprequest") return "xhr";
  if (t === "fetch") return "fetch";
  if (t === "websocket" || t === "web_socket" || t === "ws") return "websocket";
  if (t === "stylesheet" || t === "css") return "stylesheet";
  if (t === "script" || t === "js") return "script";
  if (t === "image" || t === "img" || t === "imageset") return "image";
  if (t === "font") return "font";
  if (t === "media" || t === "audio" || t === "video") return "media";
  return "other";
}

export function browserNetworkRowToExchange(input: {
  conversationId: string;
  taskId?: string;
  sequence?: number;
  row: Record<string, unknown>;
  bodyBudget?: number;
}): TrafficExchange | null {
  const row = input.row;
  const url = String(row.url || row.requestUrl || row.request_url || "").trim();
  if (!url) return null;
  const method = String(row.method || row.httpMethod || "GET").toUpperCase() || "GET";
  const resourceType = String(
    row.resourceType || row.resource_type || row.type || row.resource || "",
  );
  const resourceClass = mapBrowserResourceClass(resourceType);
  const isWs =
    resourceClass === "websocket" ||
    Boolean(row.isWebSocket || row.is_websocket) ||
    /^wss?:\/\//i.test(url);

  const reqHeaders = (row.requestHeaders || row.request_headers || row.headers) as
    | Record<string, string>
    | null
    | undefined;
  const resHeaders = (row.responseHeaders || row.response_headers) as
    | Record<string, string>
    | null
    | undefined;
  const reqBodyRaw =
    row.requestBody != null
      ? String(row.requestBody)
      : row.request_body != null
        ? String(row.request_body)
        : row.postData != null
          ? String(row.postData)
          : null;
  const resBodyRaw =
    row.responseBody != null
      ? String(row.responseBody)
      : row.response_body != null
        ? String(row.response_body)
        : row.body != null
          ? String(row.body)
          : null;

  const statusRaw = row.status ?? row.statusCode ?? row.status_code;
  const status =
    statusRaw != null && statusRaw !== "" && Number.isFinite(Number(statusRaw))
      ? Number(statusRaw)
      : null;

  const started =
    String(row.started_at || row.startedAt || row.timestamp || "") || new Date().toISOString();
  const failed = Boolean(row.failed || row.error || row.failure);
  const errorText =
    row.error != null ? String(row.error) : row.failure != null ? String(row.failure) : null;

  const req = captureBody(reqBodyRaw, { budget: input.bodyBudget });
  const contentType =
    (resHeaders && (resHeaders["content-type"] || resHeaders["Content-Type"])) ||
    (row.contentType != null ? String(row.contentType) : null) ||
    (row.mimeType != null ? String(row.mimeType) : null);
  const res = captureBody(resBodyRaw, {
    budget: input.bodyBudget,
    contentType,
  });

  const phase: TrafficPhase = failed
    ? "failed"
    : status != null || resBodyRaw != null || resHeaders
      ? "completed"
      : "pending";

  const idFromBrowser = String(row.id || row.requestId || row.request_id || "").trim();
  const exchangeId = idFromBrowser
    ? `tx_browser_${idFromBrowser.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64)}`
    : newExchangeId("browser");

  return {
    type: "traffic_exchange",
    exchange_id: exchangeId,
    conversation_id: input.conversationId,
    task_id: input.taskId,
    sequence: input.sequence,
    source: "browser",
    phase,
    method,
    url,
    request_headers: headersToRecord(reqHeaders as any),
    request_body: req.text,
    status_code: status,
    response_headers: headersToRecord(resHeaders as any),
    response_body: res.text,
    content_type: contentType,
    started_at: started,
    completed_at: phase === "pending" ? null : new Date().toISOString(),
    duration_ms:
      row.duration != null && Number.isFinite(Number(row.duration))
        ? Number(row.duration)
        : row.duration_ms != null && Number.isFinite(Number(row.duration_ms))
          ? Number(row.duration_ms)
          : null,
    error: errorText,
    request_body_truncated: req.truncated,
    response_body_truncated: res.truncated,
    request_body_bytes: req.bytes,
    response_body_bytes: res.bytes,
    request_body_hash: req.hash,
    response_body_hash: res.hash,
    request_body_binary: req.binary,
    response_body_binary: res.binary,
    browser_resource_class: resourceClass,
    is_websocket: isWs,
  };
}

export function parseBrowserNetworkList(raw: string): Record<string, unknown>[] {
  const text = String(raw || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const data = obj.data;
      if (Array.isArray(data)) {
        return data.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
      }
      if (data && typeof data === "object" && Array.isArray((data as any).requests)) {
        return ((data as any).requests as unknown[]).filter(
          (x) => x && typeof x === "object",
        ) as Record<string, unknown>[];
      }
      if (Array.isArray(obj.requests)) {
        return obj.requests.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
      }
      if (obj.url || obj.requestUrl) return [obj];
    }
  } catch {
    // fall through
  }
  return [];
}

export async function emitTrafficExchange(
  platform: PlatformSink,
  exchange: TrafficExchange,
): Promise<void> {
  await platform.send({
    ...exchange,
    type: "traffic_exchange",
  } as any);
}

export async function emitHttpPending(
  runtime: ToolRuntime,
  input: {
    method: string;
    url: string;
    requestHeaders?: Record<string, string> | null;
    requestBody?: string | null;
    bodyBudget?: number;
  },
): Promise<TrafficExchange> {
  const seq = nextSequence(runtime);
  const exchange = buildPendingHttpExchange({
    conversationId: runtime.task.conversationId,
    taskId: runtime.task.taskId,
    sequence: seq,
    method: input.method,
    url: input.url,
    requestHeaders: input.requestHeaders,
    requestBody: input.requestBody,
    bodyBudget: input.bodyBudget,
  });
  await emitTrafficExchange(runtime.platform, exchange);
  return exchange;
}

export async function emitHttpComplete(
  runtime: ToolRuntime,
  pending: TrafficExchange,
  input: {
    statusCode: number;
    responseHeaders?: Record<string, string> | null;
    responseBody?: string | null;
    contentType?: string | null;
    bodyBudget?: number;
  },
): Promise<TrafficExchange> {
  const done = completeExchange(pending, input);
  await emitTrafficExchange(runtime.platform, done);
  return done;
}

export async function emitHttpFail(
  runtime: ToolRuntime,
  pending: TrafficExchange,
  error: string,
): Promise<TrafficExchange> {
  const done = failExchange(pending, error);
  await emitTrafficExchange(runtime.platform, done);
  return done;
}

export async function drainBrowserNetworkRows(options: {
  platform: PlatformSink;
  task: TaskEnvelope;
  rows: Record<string, unknown>[];
  seenIds: Set<string>;
  sequenceStart?: number;
  bodyBudget?: number;
}): Promise<TrafficExchange[]> {
  const emitted: TrafficExchange[] = [];
  let seq = options.sequenceStart ?? 0;
  for (const row of options.rows) {
    const key = String(row.id || row.requestId || row.request_id || row.url || "").trim();
    if (key && options.seenIds.has(key)) continue;
    seq += 1;
    const exchange = browserNetworkRowToExchange({
      conversationId: options.task.conversationId,
      taskId: options.task.taskId,
      sequence: seq,
      row,
      bodyBudget: options.bodyBudget,
    });
    if (!exchange) continue;
    if (key) options.seenIds.add(key);
    options.seenIds.add(exchange.exchange_id);
    await emitTrafficExchange(options.platform, exchange);
    emitted.push(exchange);
  }
  return emitted;
}

export function getBrowserSeenIds(runtime: ToolRuntime): Set<string> {
  const life = runtime.lifecycle as { trafficBrowserSeen?: Set<string> | string[] };
  if (life.trafficBrowserSeen instanceof Set) return life.trafficBrowserSeen;
  if (Array.isArray(life.trafficBrowserSeen)) {
    const set = new Set(life.trafficBrowserSeen.map(String));
    life.trafficBrowserSeen = set;
    return set;
  }
  const set = new Set<string>();
  life.trafficBrowserSeen = set;
  return set;
}
