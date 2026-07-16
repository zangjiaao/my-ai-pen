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
  /** http | scan | browser | shell | file | tool | generic */
  kind: "http" | "scan" | "browser" | "shell" | "file" | "tool" | "generic";
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
  /** Shell / script structured view */
  shell?: {
    command?: string;
    exitCode?: string;
    /** Proving observation (preferred for humans / next experts) */
    observation?: string;
    stdout?: string;
    stderr?: string;
    path?: string;
  };
  /** File / source material (code-audit collab) */
  file?: {
    path?: string;
    preview?: string;
    hash?: string;
    bytes?: string;
  };
  /**
   * Plain-language causality: how the agent obtained the proving observation.
   * Prefer this over dumping path/exit under a vague "How captured" label.
   */
  how?: {
    /** shell | http | script | browser | unknown */
    type: "shell" | "http" | "script" | "browser" | "unknown";
    /** e.g. "Shell command", "HTTP request" */
    typeLabel: string;
    /** Human one-liner */
    summary?: string;
    command?: string;
    method?: string;
    url?: string;
    status?: string;
    requestBody?: string;
    scriptPath?: string;
    scriptPreview?: string;
    /** When we only have the result, not the request/command */
    missingNote?: string;
  };
  /** role proof|trace when present */
  role?: string;
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
  const kindHint = str(data.kind).toLowerCase();
  const role = str(data.role).toLowerCase() || undefined;

  let view: ParsedEvidenceView;
  // Book-time finding proof: observation + how captured (command / HTTP / script).
  if (kindHint === "proof" || (tool === "finding" && pick(data, ["observation", "proof", "how_captured", "capture_via"]))) {
    view = parseBookTimeProofView(ev, data, summary, tool);
  } else if (
    kindHint === "file" ||
    kindHint === "source_excerpt" ||
    type.includes("file_artifact") ||
    tool === "write" ||
    tool === "file"
  ) {
    // Script probes often set kind=source_excerpt when path looks like source; prefer shell
    // layout when stdout/command dominate and path is a .py probe script.
    const pathHint = pick(data, ["path", "path_or_url", "file"]);
    const hasStdout = Boolean(pick(data, ["stdout", "excerpt"]) && pick(data, ["command"]));
    if (hasStdout && (tool === "script" || tool === "shell") && /\.py$/i.test(pathHint)) {
      view = parseShellView(ev, data, summary, tool);
    } else {
      view = parseFileMaterialView(ev, data, summary, tool);
    }
  } else if (kindHint === "http" || looksHttp(data, summary, tool) || type.includes("http") || type.includes("traffic")) {
    view = parseHttpView(ev, data, summary, tool);
  } else if (kindHint === "shell" || tool === "shell" || tool === "script") {
    view = parseShellView(ev, data, summary, tool);
  } else if (looksScan(data, summary, tool)) {
    view = parseScanView(ev, data, summary, tool);
  } else if (kindHint === "browser" || looksBrowser(data, summary, tool)) {
    view = parseBrowserView(ev, data, summary, tool);
  } else {
    view = parseGenericToolView(ev, data, summary, tool);
  }
  if (role) view.role = role;
  return view;
}

/** Prefer readable curl lines over multi-hundred-line shell heredocs. */
function formatCommandForDisplay(command: string): string {
  const raw = command.replace(/\r\n/g, "\n").trim();
  if (!raw) return "";
  if (raw.length <= 500) return raw;
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const interesting = lines.filter((l) =>
    /\b(curl|wget|http|python|node|bash|nmap|sqlmap)\b/i.test(l) && !/^#/.test(l) && l.length > 8,
  );
  if (interesting.length) {
    const shown = interesting.slice(0, 8).join("\n");
    return truncate(shown + (interesting.length > 8 ? "\n…" : ""), 2000);
  }
  return truncate(raw, 2000);
}

function buildHowFromData(data: Record<string, unknown>): NonNullable<ParsedEvidenceView["how"]> {
  const via = pick(data, ["capture_via", "source_tool_act"]).toLowerCase();
  let command = pick(data, ["command"]);
  // Do not treat vulnerability location as a "command" or script path.
  const location = pick(data, ["location"]);
  let url = pick(data, ["url"]);
  const pathOrUrl = pick(data, ["path_or_url"]);
  // path_or_url on book-time proof is often the *finding location*, not how it was captured.
  if (!url && pathOrUrl && /^https?:\/\//i.test(pathOrUrl) && via === "http") {
    url = pathOrUrl;
  }
  const method = pick(data, ["method"]).toUpperCase();
  const status = pick(data, ["status", "status_code", "statusCode"]);
  const reqBody = pick(data, ["request_body", "requestBody"]);
  const scriptPath = pick(data, ["script_path"]);
  // Only treat `path` as script path when capture says script/write — never the vuln URL.
  const rawPath = pick(data, ["path"]);
  const scriptPathResolved =
    scriptPath ||
    (rawPath && !/^https?:\/\//i.test(rawPath) && !/\/vulnerabilities\//i.test(rawPath) ? rawPath : "");
  const scriptPreview = pick(data, ["script_preview", "preview"]);
  const howLabel = pick(data, ["how_captured"]);

  // Infer HTTP from a simple curl one-liner when method/url missing.
  if ((!method || !url) && command) {
    const curlUrl = command.match(/curl\b[^'\n"]*['"](https?:\/\/[^'"]+)['"]/i)
      || command.match(/curl\b[^\n]*\s(https?:\/\/\S+)/i);
    if (curlUrl) {
      return {
        type: "http",
        typeLabel: "HTTP request (via shell)",
        summary: `Agent requested: ${curlUrl[1]}`,
        method: /\s-X\s+(GET|POST|PUT|PATCH|DELETE)\b/i.test(command)
          ? command.match(/\s-X\s+(GET|POST|PUT|PATCH|DELETE)\b/i)![1].toUpperCase()
          : /\s-d\b|\s--data\b/i.test(command)
            ? "POST"
            : "GET",
        url: curlUrl[1],
        command: formatCommandForDisplay(command),
      };
    }
  }

  if (method && (url || pathOrUrl)) {
    const u = url || pathOrUrl;
    return {
      type: "http",
      typeLabel: "HTTP request",
      summary: status ? `${method} ${u} → ${status}` : `${method} ${u}`,
      method,
      url: u,
      status: status || undefined,
      requestBody: reqBody ? truncate(reqBody, 1200) : undefined,
      command: command ? formatCommandForDisplay(command) : undefined,
    };
  }

  if (scriptPathResolved && (via === "script" || via === "write" || scriptPreview || /\.(py|js|mjs|sh)$/i.test(scriptPathResolved))) {
    return {
      type: "script",
      typeLabel: "Script",
      summary: `Agent ran script: ${scriptPathResolved}`,
      scriptPath: scriptPathResolved,
      scriptPreview: scriptPreview ? truncate(scriptPreview, 4000) : undefined,
      command: command ? formatCommandForDisplay(command) : undefined,
    };
  }

  if (command) {
    return {
      type: "shell",
      typeLabel: "Shell command",
      summary: `Agent ran a shell command`,
      command: formatCommandForDisplay(command),
    };
  }

  if (via === "browser" && (url || pathOrUrl)) {
    return {
      type: "browser",
      typeLabel: "Browser",
      summary: `Agent opened page: ${url || pathOrUrl}`,
      url: url || pathOrUrl,
    };
  }

  // No usable how — do NOT invent path=location as "how"
  return {
    type: "unknown",
    typeLabel: "Not recorded",
    summary: howLabel && !/quoted from recent/i.test(howLabel) ? howLabel : undefined,
    missingNote: location
      ? `Only the proving result was saved. The exact command/request was not recorded. Finding location: ${location}`
      : "Only the proving result was saved. The exact command/request was not recorded for this evidence.",
  };
}

/**
 * Book-time Case evidence: proving observation first, then a plain-language "how".
 */
function parseBookTimeProofView(
  _ev: EvidenceLike,
  data: Record<string, unknown>,
  summary: string,
  tool: string,
): ParsedEvidenceView {
  const observation =
    pick(data, ["observation", "proof", "excerpt", "stdout", "body_preview"]) ||
    (summary && !summary.trim().startsWith("{") ? summary : "");
  const how = buildHowFromData(data);
  const via = pick(data, ["capture_via", "source_tool_act"]).toLowerCase() || tool || "probe";

  const obsFirst = observation
    ? observation
        .split("\n")
        .map((l) => l.trim())
        .find((l) => Boolean(l) && !/^={3,}/.test(l))
    : "";
  const title =
    obsFirst && obsFirst.length >= 8
      ? truncate(obsFirst.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), 120)
      : summary || "Proving observation";

  return {
    kind: "shell", // detail body uses custom how + observation, not raw shell dump
    badge: "PROOF",
    title,
    subtitle: how.summary || how.typeLabel,
    role: str(data.role) || "proof",
    toolName: via !== "finding" ? via : how.type !== "unknown" ? how.type : undefined,
    shell: {
      observation: observation ? truncate(observation, 4000) : undefined,
      stdout: observation ? truncate(observation, 8000) : undefined,
      // Keep structured fields for fallback; primary UI uses `how`.
      command: how.command,
      path: how.scriptPath,
    },
    http:
      how.type === "http"
        ? {
            method: how.method,
            url: how.url,
            status: how.status,
            requestBody: how.requestBody,
            responseBody: observation ? truncate(observation, 4000) : undefined,
          }
        : undefined,
    file:
      how.scriptPreview || how.scriptPath
        ? { path: how.scriptPath, preview: how.scriptPreview }
        : undefined,
    how,
    bodyPreview: truncate(
      [
        observation && `Result:\n${observation}`,
        how.command && `Command:\n${how.command}`,
        how.method && how.url && `Request:\n${how.method} ${how.url}`,
        how.missingNote,
      ]
        .filter(Boolean)
        .join("\n\n"),
      1200,
    ),
  };
}

function parseShellView(
  _ev: EvidenceLike,
  data: Record<string, unknown>,
  summary: string,
  tool: string,
): ParsedEvidenceView {
  const command = pick(data, ["command", "file"]) || (summary.startsWith("shell:") ? summary.slice(6).trim() : "");
  const fullStdout = pick(data, ["stdout", "output"]) || str(asRecord(data.proof)?.stdout_excerpt);
  const observation =
    pick(data, ["observation", "proof_highlight", "excerpt"]) ||
    str(asRecord(data.proof)?.observation) ||
    fullStdout;
  const stderr = pick(data, ["stderr"]);
  const exitCode = pick(data, ["exitCode", "exit_code"]) || str(asRecord(data.proof)?.exitCode);
  const path = pick(data, ["path", "path_or_url"]);
  // Title should describe the *proof*, not the wrapper script path.
  const obsFirst = observation ? observation.split("\n").map((l) => l.trim()).find((l) => l && !/^={3,}/.test(l)) : "";
  const shortCmd = command ? truncate(command.replace(/\s+/g, " "), 80) : "";
  const title =
    obsFirst && obsFirst.length >= 12
      ? truncate(obsFirst, 120)
      : summary && !summary.trim().startsWith("{")
        ? truncate(summary, 120)
        : shortCmd
          ? `${tool || "shell"}: ${shortCmd}`
          : `${tool || "shell"} output`;

  return {
    kind: "shell",
    badge: (tool || "SHELL").toUpperCase().slice(0, 10),
    title,
    subtitle: [exitCode !== "" ? `exit ${exitCode}` : "", tool === "script" ? "probe" : ""].filter(Boolean).join(" · ") || undefined,
    toolName: tool || "shell",
    shell: {
      command: command ? truncate(command, 2000) : undefined,
      exitCode: exitCode || undefined,
      observation: observation ? truncate(observation, 4000) : undefined,
      // Keep full stdout for expand; prefer observation when distinct
      stdout: fullStdout ? truncate(fullStdout, 8000) : observation ? truncate(observation, 8000) : undefined,
      stderr: stderr ? truncate(stderr, 2000) : undefined,
      path: path && !/\/scripts\//.test(path) ? path : undefined,
    },
    // Cards: show proving observation first, not "$ python scripts/..."
    bodyPreview: truncate([observation || fullStdout, command && `(via ${shortCmd || tool || "probe"})`].filter(Boolean).join("\n"), 1200),
  };
}

function parseFileMaterialView(
  _ev: EvidenceLike,
  data: Record<string, unknown>,
  summary: string,
  tool: string,
): ParsedEvidenceView {
  const path = pick(data, ["path", "path_or_url", "file"]);
  const preview = pick(data, ["preview", "excerpt", "content", "text", "stdout"]);
  const hash = pick(data, ["hash"]);
  const bytes = pick(data, ["bytes"]);
  const kindHint = str(data.kind).toLowerCase();
  const badge = kindHint === "source_excerpt" ? "SOURCE" : "FILE";
  const title =
    path ||
    (summary && !summary.trim().startsWith("{") ? truncate(summary, 120) : `${tool || "file"} material`);

  return {
    kind: "file",
    badge,
    title: truncate(title, 140),
    subtitle: [hash, bytes && `${bytes} bytes`, tool].filter(Boolean).join(" · ") || undefined,
    toolName: tool || undefined,
    file: {
      path: path || undefined,
      preview: preview ? truncate(preview, 6000) : undefined,
      hash: hash || undefined,
      bytes: bytes || undefined,
    },
    bodyPreview: truncate([path && `path: ${path}`, preview].filter(Boolean).join("\n\n"), 1200),
  };
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
  // Prefer explicit request body fields; do not steal response body_preview into request.
  const reqBody = truncate(
    str(data.requestBody || data.request_body || data.payload || (method && method !== "GET" ? data.body : "")),
    800,
  );
  // Node4 Case properties use body_preview / excerpt heavily.
  let resBody = str(
    data.responseBody ||
      data.response_body ||
      data.body_preview ||
      data.excerpt ||
      data.response ||
      data.html ||
      data.text ||
      "",
  );
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
  const url = pick(data, ["url", "requested_url", "target", "path_or_url", "open_url"]);
  const hasShot = Boolean(data.screenshot_base64 || data.screenshot);
  const html = str(data.html || data.content || data.snapshot || "");
  const text = str(data.text || data.excerpt || data.cli || "");
  const textPreview = html
    ? truncate(stripHtmlNoise(html), 500)
    : text
      ? truncate(text, 500)
      : "";
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
  // If summary is a tool JSON dump, prefer nested stdout/command over raw blob.
  const nested = parseSummaryBlob(summary) || {};
  const merged = { ...nested, ...data };
  const output = pick(merged, [
    "output",
    "stdout",
    "result_text",
    "result",
    "text",
    "message",
    "detail",
    "excerpt",
    "preview",
    "body_preview",
  ]);
  let body = output;
  if (!body) {
    const useful = [
      "url",
      "path",
      "path_or_url",
      "status",
      "error",
      "note",
      "notes",
      "command",
      "action",
      "exitCode",
      "role",
    ];
    const lines = useful
      .map((k) => (merged[k] !== undefined && str(merged[k]) ? `${k}: ${truncate(str(merged[k]), 200)}` : ""))
      .filter(Boolean);
    body = lines.join("\n");
  }
  if (!body && summary && !summary.trim().startsWith("{")) body = summary;
  if (!body) body = "Tool output recorded";

  const title =
    summary && !summary.trim().startsWith("{")
      ? truncate(summary, 120)
      : pick(merged, ["command", "url", "path", "path_or_url"])
        ? truncate(pick(merged, ["command", "url", "path", "path_or_url"]), 100)
        : `${tool || "tool"} output`;

  return {
    kind: "tool",
    badge: (tool || str(ev.type) || "TOOL").toUpperCase().slice(0, 12),
    title,
    subtitle: tool ? `Tool: ${tool}` : undefined,
    toolName: tool || undefined,
    bodyPreview: truncate(body, 900),
  };
}

/** Card-friendly one/two line preview. */
export function evidenceCardPreview(ev: EvidenceLike): { badge: string; title: string; detail: string } {
  const view = parseEvidenceView(ev);
  let detail = "";
  if (view.kind === "http") {
    detail = [view.http?.status ? `HTTP ${view.http.status}` : "", view.http?.url || "", view.toolName ? `via ${view.toolName}` : ""]
      .filter(Boolean)
      .join(" · ");
    // Prefer a short response snippet when present so cards are not "status only".
    if (view.http?.responseBody) {
      detail = [detail, truncate(view.http.responseBody, 140)].filter(Boolean).join(" — ");
    }
  } else if (view.kind === "file") {
    detail = [view.file?.path, view.file?.preview ? truncate(view.file.preview, 140) : ""].filter(Boolean).join(" — ");
  } else if (view.kind === "shell") {
    detail = truncate(
      view.shell?.observation || view.shell?.stdout || view.bodyPreview || view.subtitle || "",
      220,
    );
  } else {
    detail = truncate(view.bodyPreview || view.subtitle || "", 220);
  }
  if (view.role) {
    detail = detail ? `[${view.role}] ${detail}` : view.role;
  }
  return {
    badge: view.badge,
    title: truncate(view.title, 120),
    detail: detail || view.subtitle || "Evidence",
  };
}

export type EvidenceProofStep = {
  n: number;
  label: string;
  text: string;
};

/**
 * Compact steps for inline display inside a finding panel (not a separate evidence dialog).
 * 1 command · 2 script/request · 3 result
 */
export function evidenceProofSteps(ev: EvidenceLike): EvidenceProofStep[] {
  const view = parseEvidenceView(ev);
  const how = view.how;
  const result =
    view.shell?.observation ||
    view.http?.responseBody ||
    view.bodyPreview ||
    str(asRecord(ev.properties)?.observation) ||
    str(asRecord(ev.properties)?.excerpt) ||
    "";

  let command = "";
  let script = "";

  if (how) {
    if (how.type === "http" && how.method && how.url) {
      command = [how.method, how.url, how.status ? `→ ${how.status}` : ""].filter(Boolean).join(" ");
      if (how.requestBody) script = how.requestBody;
      else if (how.command && how.command.length > 80) script = how.command;
    } else if (how.command) {
      const cmd = how.command;
      const preview = how.scriptPreview || "";
      if (preview && preview !== cmd) {
        command = how.scriptPath ? `${cmd.split("\n")[0] || cmd}` : cmd.length <= 200 ? cmd : `${cmd.slice(0, 160)}…`;
        script = preview;
      } else if (cmd.length > 200 || cmd.includes("\n")) {
        const first = cmd.split("\n").map((l) => l.trim()).find(Boolean) || cmd;
        command = first.length > 140 ? `${first.slice(0, 140)}…` : first;
        script = cmd;
      } else {
        command = cmd;
      }
    } else if (how.scriptPreview) {
      script = how.scriptPreview;
    } else if (how.missingNote) {
      command = how.missingNote;
    }
  } else {
    // Legacy shell/http without book-time how
    command = view.shell?.command || (view.http ? [view.http.method, view.http.url].filter(Boolean).join(" ") : "");
    script = view.file?.preview || view.http?.requestBody || "";
  }

  const steps: EvidenceProofStep[] = [];
  if (command.trim()) steps.push({ n: 1, label: "Command", text: truncate(command, 2500) });
  if (script.trim() && script.trim() !== command.trim()) {
    steps.push({ n: 2, label: "Script / request", text: truncate(script, 4000) });
  }
  if (result.trim()) steps.push({ n: steps.length ? 3 : 1, label: "Result", text: truncate(result, 4000) });
  // renumber 1..n for display when result was only step
  return steps.map((s, i) => ({ ...s, n: i + 1 }));
}
