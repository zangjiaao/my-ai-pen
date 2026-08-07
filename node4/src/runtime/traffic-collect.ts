/**
 * Spec #309 — Case traffic audit collect (Node Runtime hook side).
 *
 * Passive instrumentation on `http` + browser network. No Agent traffic tools.
 * Platform Case store is panel SoT; act-observation memory remains booking-only.
 */

import { createHash } from "node:crypto";
import type { PlatformSink, TaskEnvelope, ToolRuntime } from "../types.js";

export type TrafficSource = "http" | "browser" | "shell" | "mitm";
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

/**
 * Always returns a local pending exchange so a later complete/fail can land
 * even when the pending platform emit fails (Spec #309 review: terminal must not
 * depend on pending emit success).
 */
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
  await emitTrafficExchange(runtime.platform, exchange).catch(() => {});
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
  await emitTrafficExchange(runtime.platform, done).catch(() => {});
  return done;
}

export async function emitHttpFail(
  runtime: ToolRuntime,
  pending: TrafficExchange,
  error: string,
): Promise<TrafficExchange> {
  const done = failExchange(pending, error);
  await emitTrafficExchange(runtime.platform, done).catch(() => {});
  return done;
}

// ---------------------------------------------------------------------------
// Spec #309 expansion: shell HTTP best-effort (curl / wget / httpie)
// ---------------------------------------------------------------------------

const HTTP_SHELL_CLIENT_RE = /\b(curl|wget|http(?:ie)?)\b/i;
const ABSOLUTE_URL_RE = /https?:\/\/[^\s"'\\]+/gi;

/** True when command likely performs HTTP via common CLI clients. */
export function looksLikeHttpShellCommand(command: string): boolean {
  const c = String(command || "");
  if (!HTTP_SHELL_CLIENT_RE.test(c)) return false;
  // Require at least one absolute URL, or curl relative with scheme-less host:port
  if (ABSOLUTE_URL_RE.test(c)) return true;
  // Reset lastIndex after global test
  ABSOLUTE_URL_RE.lastIndex = 0;
  // curl http:// already covered; allow curl host/path with -X rarely without scheme — skip
  return /curl\s+[^\n]*https?:\/\//i.test(c);
}

/** Extract absolute http(s) URLs from a shell command (deduped, order preserved). */
export function extractUrlsFromShellCommand(command: string): string[] {
  const c = String(command || "");
  const found: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  const re = /https?:\/\/[^\s"'\\]+/gi;
  while ((m = re.exec(c)) !== null) {
    let u = m[0].replace(/[),.;]+$/, "");
    // Strip trailing quotes artifacts
    u = u.replace(/['"]+$/, "");
    if (!u || seen.has(u)) continue;
    seen.add(u);
    found.push(u);
  }
  return found;
}

/** Infer HTTP method from curl/wget flags (best-effort). */
export function inferShellHttpMethod(command: string): string {
  const c = String(command || "");
  const x = c.match(/(?:^|\s)(?:-X|--request)\s+([A-Za-z]+)/i);
  if (x?.[1]) return x[1].toUpperCase();
  // curl -sI / -I / --head (short flags may be clustered: -sIk)
  if (/(?:^|\s)--head(?:\s|$)/i.test(c) || /(?:^|\s)-[A-Za-z]*I[A-Za-z]*(?:\s|$|=)/.test(c)) {
    return "HEAD";
  }
  if (/(?:^|\s)(?:-d|--data(?:-raw|-binary|-urlencode)?|--json)\b/i.test(c)) return "POST";
  if (/\bwget\b/i.test(c) && /--method\s+(\S+)/i.test(c)) {
    const wm = c.match(/--method\s+(\S+)/i);
    if (wm?.[1]) return wm[1].toUpperCase();
  }
  if (/\bhttp(?:ie)?\b/i.test(c)) {
    const hm = c.match(/\bhttp(?:ie)?\s+(?:--\S+\s+)*([A-Z]+)\s+https?:\/\//i);
    if (hm?.[1] && ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(hm[1])) {
      return hm[1];
    }
  }
  return "GET";
}

/** Best-effort -H / --header parse from curl. */
export function parseShellRequestHeaders(command: string): Record<string, string> | null {
  const c = String(command || "");
  const out: Record<string, string> = {};
  const re = /(?:^|\s)(?:-H|--header)\s+(['"]?)([^'"\n]+)\1/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(c)) !== null) {
    const raw = String(m[2] || "").trim();
    const idx = raw.indexOf(":");
    if (idx <= 0) continue;
    const k = raw.slice(0, idx).trim();
    const v = raw.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** Best-effort -d / --data / --json body from curl. */
export function parseShellRequestBody(command: string): string | null {
  const c = String(command || "");
  const patterns = [
    /(?:^|\s)--json\s+(['"])([\s\S]*?)\1/,
    /(?:^|\s)--json\s+(\S+)/,
    /(?:^|\s)(?:-d|--data(?:-raw|-binary|-urlencode)?)\s+(['"])([\s\S]*?)\1/,
    /(?:^|\s)(?:-d|--data(?:-raw|-binary|-urlencode)?)\s+(\S+)/,
  ];
  for (const re of patterns) {
    const m = c.match(re);
    if (!m) continue;
    const body = m[2] != null ? m[2] : m[1];
    if (body != null && String(body).trim()) return String(body);
  }
  return null;
}

/**
 * Parse status / headers / body from curl-like stdout.
 * Handles: `HTTP/1.1 200 OK` + headers; bare status; multi-line `200 /path`.
 */
export function parseShellHttpStdout(stdout: string): {
  statusCode: number | null;
  responseHeaders: Record<string, string> | null;
  responseBody: string | null;
  contentType: string | null;
  /** Path→status when agent used multi-path probe listing */
  pathStatuses: Array<{ status: number; path: string }>;
} {
  const text = String(stdout || "");
  const pathStatuses: Array<{ status: number; path: string }> = [];
  // Multi-line "200 /api/Products" style probes
  for (const line of text.split(/\r?\n/)) {
    const pm = line.trim().match(/^(\d{3})\s+(\/\S*)/);
    if (pm) pathStatuses.push({ status: Number(pm[1]), path: pm[2] });
  }

  const statusMatch = text.match(/HTTP\/\d(?:\.\d)?\s+(\d{3})\b/i);
  let statusCode: number | null = statusMatch ? Number(statusMatch[1]) : null;
  if (statusCode == null && pathStatuses.length === 1) statusCode = pathStatuses[0]!.status;

  let responseHeaders: Record<string, string> | null = null;
  let responseBody: string | null = text || null;
  let contentType: string | null = null;

  if (statusMatch) {
    const after = text.slice(statusMatch.index! + statusMatch[0].length);
    // Header block until blank line
    const parts = after.split(/\r?\n\r?\n/);
    const headerBlock = parts[0] || "";
    const bodyPart = parts.slice(1).join("\n\n");
    const headers: Record<string, string> = {};
    for (const line of headerBlock.split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (k) headers[k] = v;
    }
    if (Object.keys(headers).length) {
      responseHeaders = headers;
      contentType = headers["content-type"] || headers["Content-Type"] || null;
    }
    responseBody = bodyPart.trim() ? bodyPart : text;
  }

  return { statusCode, responseHeaders, responseBody, contentType, pathStatuses };
}

/**
 * Pure: build completed/failed shell-sourced exchanges from one shell tool result.
 * Returns [] when command is not HTTP-like or no URL can be recovered.
 */
export function buildShellHttpExchanges(input: {
  conversationId: string;
  taskId?: string;
  sequenceStart?: number;
  command: string;
  stdout: string;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  aborted?: boolean;
  durationMs?: number | null;
  bodyBudget?: number;
  startedAt?: string;
}): TrafficExchange[] {
  const command = String(input.command || "");
  if (!looksLikeHttpShellCommand(command)) return [];
  const urls = extractUrlsFromShellCommand(command);
  if (!urls.length) return [];

  const method = inferShellHttpMethod(command);
  const reqHeaders = parseShellRequestHeaders(command);
  const reqBody = parseShellRequestBody(command);
  const parsed = parseShellHttpStdout(input.stdout || "");
  const started = input.startedAt || new Date().toISOString();
  const completed = new Date().toISOString();
  const budget = input.bodyBudget ?? DEFAULT_BODY_BUDGET;
  const failed = Boolean(input.aborted || input.timedOut);
  const error = input.aborted
    ? "aborted"
    : input.timedOut
      ? "timeout"
      : input.exitCode != null && input.exitCode !== 0 && parsed.statusCode == null
        ? `exit=${input.exitCode}`
        : null;

  // Multi path-status listing with single base URL → one row per path when base is origin
  if (parsed.pathStatuses.length > 1 && urls.length === 1) {
    try {
      const base = new URL(urls[0]!);
      const origin = base.origin;
      return parsed.pathStatuses.map((ps, i) => {
        const url = `${origin}${ps.path.startsWith("/") ? ps.path : `/${ps.path}`}`;
        const res = captureBody(null, { budget });
        const emptyReq = captureBody(null, { budget });
        return {
          type: "traffic_exchange" as const,
          exchange_id: newExchangeId("shell"),
          conversation_id: input.conversationId,
          task_id: input.taskId,
          sequence: (input.sequenceStart || 0) + i + 1,
          source: "shell" as const,
          phase: "completed" as const,
          method: "GET",
          url,
          request_headers: null,
          request_body: emptyReq.text,
          status_code: ps.status,
          response_headers: null,
          response_body: null,
          content_type: null,
          started_at: started,
          completed_at: completed,
          duration_ms: input.durationMs ?? null,
          error: null,
          request_body_truncated: false,
          response_body_truncated: false,
          request_body_bytes: 0,
          response_body_bytes: 0,
          request_body_hash: null,
          response_body_hash: null,
          request_body_binary: false,
          response_body_binary: false,
        };
      });
    } catch {
      // fall through to URL-based rows
    }
  }

  const out: TrafficExchange[] = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]!;
    const req = captureBody(i === 0 ? reqBody : null, { budget });
    const res = captureBody(i === 0 ? parsed.responseBody : null, { budget });
    const status =
      urls.length === 1
        ? parsed.statusCode
        : parsed.pathStatuses.find((p) => url.endsWith(p.path))?.status ??
          (i === 0 ? parsed.statusCode : null);
    const phase: TrafficPhase = failed && status == null ? "failed" : "completed";
    out.push({
      type: "traffic_exchange",
      exchange_id: newExchangeId("shell"),
      conversation_id: input.conversationId,
      task_id: input.taskId,
      sequence: (input.sequenceStart || 0) + i + 1,
      source: "shell",
      phase,
      method: i === 0 ? method : "GET",
      url,
      request_headers: i === 0 ? reqHeaders : null,
      request_body: req.text,
      status_code: status,
      response_headers: i === 0 ? parsed.responseHeaders : null,
      response_body: res.text,
      content_type: i === 0 ? parsed.contentType : null,
      started_at: started,
      completed_at: completed,
      duration_ms: input.durationMs ?? null,
      error: phase === "failed" ? error : null,
      request_body_truncated: req.truncated,
      response_body_truncated: res.truncated,
      request_body_bytes: req.bytes,
      response_body_bytes: res.bytes,
      request_body_hash: req.hash,
      response_body_hash: res.hash,
      request_body_binary: req.binary,
      response_body_binary: res.binary,
    });
  }
  return out;
}

/**
 * After shell tool completes: if command looks like HTTP CLI, emit completed
 * exchanges (best-effort; never throws into shell execute).
 */
export async function emitShellHttpTraffic(
  runtime: ToolRuntime,
  input: {
    command: string;
    stdout: string;
    stderr?: string;
    exitCode?: number | null;
    timedOut?: boolean;
    aborted?: boolean;
    durationMs?: number | null;
  },
): Promise<TrafficExchange[]> {
  const seq0 = Number((runtime.lifecycle as { trafficSequence?: number }).trafficSequence || 0);
  const exchanges = buildShellHttpExchanges({
    conversationId: runtime.task.conversationId,
    taskId: runtime.task.taskId,
    sequenceStart: seq0,
    command: input.command,
    stdout: input.stdout,
    stderr: input.stderr,
    exitCode: input.exitCode,
    timedOut: input.timedOut,
    aborted: input.aborted,
    durationMs: input.durationMs,
  });
  if (!exchanges.length) return [];
  // Advance sequence counter past emitted rows
  (runtime.lifecycle as { trafficSequence?: number }).trafficSequence = seq0 + exchanges.length;
  for (const ex of exchanges) {
    await emitTrafficExchange(runtime.platform, ex).catch(() => {});
  }
  return exchanges;
}

/** Phase rank for browser same-id upgrade (R2). */
export function trafficPhaseRank(phase: string | null | undefined): number {
  const p = String(phase || "pending").toLowerCase();
  if (p === "completed" || p === "failed") return 1;
  return 0;
}

/** Richer row score: allow re-emit of same id when later drain has more fields. */
export function browserExchangeRichness(exchange: TrafficExchange): number {
  let score = trafficPhaseRank(exchange.phase) * 100;
  if (exchange.status_code != null) score += 10;
  if (exchange.response_body) score += 5;
  if (exchange.response_headers && Object.keys(exchange.response_headers).length) score += 3;
  if (exchange.request_body) score += 2;
  if (exchange.request_headers && Object.keys(exchange.request_headers).length) score += 1;
  if (exchange.error) score += 2;
  if (exchange.duration_ms != null) score += 1;
  return score;
}

export type BrowserSeenEntry = {
  phase: TrafficPhase;
  richness: number;
};

/** Map key → last emitted state (not a permanent drop set). */
export type BrowserSeenMap = Map<string, BrowserSeenEntry>;

/**
 * Whether a browser row for this key should re-emit (first sight, phase upgrade,
 * or richer fields). Same-id terminal must never be permanently dropped after pending.
 */
export function shouldEmitBrowserRow(
  seen: BrowserSeenMap,
  key: string,
  exchange: TrafficExchange,
): boolean {
  const prev = seen.get(key) || seen.get(exchange.exchange_id);
  if (!prev) return true;
  const newRank = trafficPhaseRank(exchange.phase);
  const oldRank = trafficPhaseRank(prev.phase);
  if (newRank > oldRank) return true;
  if (newRank < oldRank) return false;
  return browserExchangeRichness(exchange) > prev.richness;
}

export function rememberBrowserEmit(
  seen: BrowserSeenMap,
  key: string,
  exchange: TrafficExchange,
): void {
  const entry: BrowserSeenEntry = {
    phase: exchange.phase,
    richness: browserExchangeRichness(exchange),
  };
  if (key) seen.set(key, entry);
  seen.set(exchange.exchange_id, entry);
}

/**
 * Best-effort drain of agent-browser `network requests` rows.
 * Same browser request id may appear first as in-flight (pending) then complete —
 * re-emit upgrades (R2). Residual: if CLI only returns terminal rows, no pending
 * phase is inventable; still upserts later fuller completions for the same id.
 */
export async function drainBrowserNetworkRows(options: {
  platform: PlatformSink;
  task: TaskEnvelope;
  rows: Record<string, unknown>[];
  seenIds: BrowserSeenMap;
  sequenceStart?: number;
  bodyBudget?: number;
}): Promise<TrafficExchange[]> {
  const emitted: TrafficExchange[] = [];
  let seq = options.sequenceStart ?? 0;
  for (const row of options.rows) {
    const key = String(row.id || row.requestId || row.request_id || row.url || "").trim();
    const exchange = browserNetworkRowToExchange({
      conversationId: options.task.conversationId,
      taskId: options.task.taskId,
      sequence: seq + 1,
      row,
      bodyBudget: options.bodyBudget,
    });
    if (!exchange) continue;
    const mapKey = key || exchange.exchange_id;
    if (!shouldEmitBrowserRow(options.seenIds, mapKey, exchange)) continue;
    seq += 1;
    exchange.sequence = seq;
    rememberBrowserEmit(options.seenIds, mapKey, exchange);
    await emitTrafficExchange(options.platform, exchange).catch(() => {});
    emitted.push(exchange);
  }
  return emitted;
}

export function getBrowserSeenIds(runtime: ToolRuntime): BrowserSeenMap {
  const life = runtime.lifecycle as {
    trafficBrowserSeen?: BrowserSeenMap | Set<string> | string[] | Map<string, BrowserSeenEntry>;
  };
  if (life.trafficBrowserSeen instanceof Map) {
    return life.trafficBrowserSeen as BrowserSeenMap;
  }
  // Migrate legacy Set/array (id-only permanent drop) → empty Map so upgrades work.
  const map: BrowserSeenMap = new Map();
  if (life.trafficBrowserSeen instanceof Set) {
    for (const id of life.trafficBrowserSeen) {
      map.set(String(id), { phase: "completed", richness: 0 });
    }
  } else if (Array.isArray(life.trafficBrowserSeen)) {
    for (const id of life.trafficBrowserSeen) {
      map.set(String(id), { phase: "completed", richness: 0 });
    }
  }
  life.trafficBrowserSeen = map;
  return map;
}
