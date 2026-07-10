/**
 * Human-readable evidence presentation for cards and detail dialogs.
 * Prefers HTTP request/response and tool scan summaries over raw JSON dumps.
 */

export type EvidenceLike = {
  evidence_id?: string | null;
  id?: string | null;
  type?: string | null;
  source_tool?: string | null;
  summary?: string | null;
  raw_ref?: string | null;
  hash?: string | null;
  properties?: Record<string, unknown> | null;
  created_at?: string | null;
  data?: unknown;
};

export type ParsedEvidenceView = {
  /** http | scan | browser | tool | generic */
  kind: "http" | "scan" | "browser" | "tool" | "generic";
  /** Short badge e.g. HTTP, SCAN, BROWSER */
  badge: string;
  /** One-line title for cards */
  title: string;
  /** Optional second line under title */
  subtitle?: string;
  /** Structured HTTP view */
  http?: {
    method?: string;
    url?: string;
    status?: string;
    requestHeaders?: string;
    requestBody?: string;
    responseHeaders?: string;
    responseBody?: string;
  };
  /** Scan / tool body lines (already truncated) */
  bodyPreview?: string;
  toolName?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function pick(obj: Record<string, unknown> | undefined, keys: string[]): string {
  if (!obj) return "";
  for (const key of keys) {
    const v = str(obj[key]);
    if (v) return v;
  }
  return "";
}

function headersToText(headers: unknown): string {
  if (!headers) return "";
  if (typeof headers === "string") return headers.trim();
  const rec = asRecord(headers);
  if (!rec) return "";
  return Object.entries(rec)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
}

function truncate(text: string, max = 1200): string {
  const t = text.replace(/\r\n/g, "\n").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function stripHtmlNoise(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Try parse summary if it is JSON string. */
function parseSummaryBlob(summary: string | null | undefined): Record<string, unknown> | undefined {
  const raw = str(summary);
  if (!raw.startsWith("{") && !raw.startsWith("[")) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

function gatherData(ev: EvidenceLike): Record<string, unknown> {
  const props = asRecord(ev.properties) || {};
  const nested = asRecord(props.data) || asRecord(ev.data) || {};
  const fromSummary = parseSummaryBlob(ev.summary);
  return { ...fromSummary, ...nested, ...props };
}

function looksHttp(data: Record<string, unknown>, summary: string, tool: string): boolean {
  if (pick(data, ["method", "url", "request_url", "status", "status_code", "statusCode", "trafficId", "traffic_id"])) {
    return true;
  }
  if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i.test(summary)) return true;
  if (/->\s*\d{3}/.test(summary)) return true;
  if (["http", "traffic", "verifier"].includes(tool)) return true;
  return false;
}

function looksScan(data: Record<string, unknown>, summary: string, tool: string): boolean {
  if (["scan", "nuclei", "nmap", "ffuf", "httpx", "katana", "sqlmap"].includes(tool)) return true;
  if (pick(data, ["findings", "matches", "results", "scanner", "scan"])) return true;
  if (/\b(nuclei|nmap|ffuf|sqlmap|scan)\b/i.test(summary)) return true;
  return false;
}

function looksBrowser(data: Record<string, unknown>, summary: string, tool: string): boolean {
  if (tool === "browser" || tool.includes("browser")) return true;
  if (pick(data, ["html", "screenshot_base64", "screenshot"])) return true;
  if (/^browser\b/i.test(summary)) return true;
  return false;
}

export function parseEvidenceView(ev: EvidenceLike): ParsedEvidenceView {
  const tool = str(ev.source_tool || pick(asRecord(ev.properties), ["sourceTool", "source_tool", "tool"])).toLowerCase();
  const summary = str(ev.summary);
  const data = gatherData(ev);
  const type = str(ev.type).toLowerCase();

  if (looksHttp(data, summary, tool) || type.includes("http") || type.includes("traffic")) {
    return parseHttpView(ev, data, summary, tool);
  }
  if (looksScan(data, summary, tool)) {
    return parseScanView(ev, data, summary, tool);
  }
  if (looksBrowser(data, summary, tool)) {
    return parseBrowserView(ev, data, summary, tool);
  }
  return parseGenericToolView(ev, data, summary, tool);
}

function parseHttpView(
  ev: EvidenceLike,
  data: Record<string, unknown>,
  summary: string,
  tool: string,
): ParsedEvidenceView {
  let method = pick(data, ["method", "http_method", "request_method"]).toUpperCase();
  let url = pick(data, ["url", "request_url", "uri", "target", "path"]);
  let status = pick(data, ["status", "status_code", "statusCode", "response_status"]);

  // "POST http://… -> 302"
  const m = summary.match(/^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)(?:\s*->\s*(\d{3}))?/i);
  if (m) {
    method = method || m[1].toUpperCase();
    url = url || m[2];
    status = status || m[3] || "";
  }

  const reqHeaders = headersToText(data.requestHeaders || data.request_headers || data.req_headers);
  const resHeaders = headersToText(data.responseHeaders || data.response_headers || data.headers || data.res_headers);
  const reqBody = truncate(str(data.requestBody || data.request_body || data.body || data.payload), 800);
  let resBody = str(data.responseBody || data.response_body || data.response || data.html);
  if (resBody.includes("<") && resBody.includes(">")) {
    resBody = truncate(stripHtmlNoise(resBody), 600);
  } else {
    resBody = truncate(resBody, 800);
  }

  const titleParts = [method, url].filter(Boolean);
  const title = titleParts.length ? titleParts.join(" ") : summary || "HTTP request";
  const subtitle = status ? `Status ${status}` : tool ? `via ${tool}` : undefined;

  return {
    kind: "http",
    badge: "HTTP",
    title,
    subtitle,
    toolName: tool || undefined,
    http: {
      method: method || undefined,
      url: url || undefined,
      status: status || undefined,
      requestHeaders: reqHeaders || undefined,
      requestBody: reqBody || undefined,
      responseHeaders: resHeaders || undefined,
      responseBody: resBody || undefined,
    },
    bodyPreview: [method && url ? `${method} ${url}` : "", status ? `→ ${status}` : "", summary && !title.includes(summary) ? summary : ""]
      .filter(Boolean)
      .join("\n"),
  };
}

function parseScanView(
  ev: EvidenceLike,
  data: Record<string, unknown>,
  summary: string,
  tool: string,
): ParsedEvidenceView {
  const scanner = pick(data, ["scanner", "tool", "sourceTool"]) || tool || "scan";
  const findings = data.findings || data.matches || data.results || data.issues;
  let body = "";
  if (Array.isArray(findings)) {
    body = findings
      .slice(0, 12)
      .map((item, i) => {
        const rec = asRecord(item);
        if (!rec) return `${i + 1}. ${truncate(str(item), 160)}`;
        const name = pick(rec, ["name", "template", "title", "vuln", "id", "type"]);
        const sev = pick(rec, ["severity", "level"]);
        const loc = pick(rec, ["matched-at", "url", "host", "path", "endpoint"]);
        return [sev && `[${sev}]`, name, loc].filter(Boolean).join(" ");
      })
      .join("\n");
  } else if (typeof findings === "string") {
    body = truncate(findings, 1000);
  } else {
    const output = pick(data, ["output", "stdout", "result", "result_text", "text"]);
    body = truncate(output || summary, 1000);
  }

  return {
    kind: "scan",
    badge: "SCAN",
    title: summary || `${scanner} scan result`,
    subtitle: scanner ? `Tool: ${scanner}` : undefined,
    toolName: scanner,
    bodyPreview: body || summary || "Scan result",
  };
}

function parseBrowserView(
  ev: EvidenceLike,
  data: Record<string, unknown>,
  summary: string,
  tool: string,
): ParsedEvidenceView {
  const url = pick(data, ["url", "requested_url", "target"]);
  const hasShot = Boolean(data.screenshot_base64 || data.screenshot);
  const html = str(data.html || data.content);
  const textPreview = html ? truncate(stripHtmlNoise(html), 500) : "";
  const action = summary.replace(/^browser\s+/i, "").split(/\s+/)[0] || "page";

  return {
    kind: "browser",
    badge: "BROWSER",
    title: summary || (url ? `Browser ${url}` : "Browser observation"),
    subtitle: [url, hasShot ? "screenshot" : "", action].filter(Boolean).join(" · ") || undefined,
    toolName: tool || "browser",
    bodyPreview: textPreview || (hasShot ? "Page screenshot captured" : url || summary),
  };
}

function parseGenericToolView(
  ev: EvidenceLike,
  data: Record<string, unknown>,
  summary: string,
  tool: string,
): ParsedEvidenceView {
  const output = pick(data, ["output", "stdout", "result_text", "result", "text", "message", "detail"]);
  let body = output;
  if (!body) {
    // Avoid dumping entire JSON; pick a few useful keys.
    const useful = ["url", "status", "error", "note", "notes", "path", "command", "action"];
    const lines = useful.map((k) => (data[k] !== undefined ? `${k}: ${truncate(str(data[k]), 200)}` : "")).filter(Boolean);
    body = lines.join("\n");
  }
  if (!body && summary && !summary.trim().startsWith("{")) body = summary;
  if (!body) body = "Tool output recorded";

  return {
    kind: "tool",
    badge: (tool || str(ev.type) || "TOOL").toUpperCase().slice(0, 12),
    title: summary && !summary.trim().startsWith("{") ? summary : `${tool || "tool"} output`,
    subtitle: tool ? `Tool: ${tool}` : undefined,
    toolName: tool || undefined,
    bodyPreview: truncate(body, 900),
  };
}

/** Card-friendly one/two line preview. */
export function evidenceCardPreview(ev: EvidenceLike): { badge: string; title: string; detail: string } {
  const view = parseEvidenceView(ev);
  const detail =
    view.kind === "http"
      ? [view.http?.status ? `HTTP ${view.http.status}` : "", view.http?.url || "", view.toolName ? `via ${view.toolName}` : ""]
          .filter(Boolean)
          .join(" · ")
      : truncate(view.bodyPreview || view.subtitle || "", 220);
  return {
    badge: view.badge,
    title: truncate(view.title, 120),
    detail: detail || view.subtitle || "Evidence",
  };
}
