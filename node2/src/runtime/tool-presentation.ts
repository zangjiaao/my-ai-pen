/**
 * User-facing tool card presentation for platform messages.
 * Aligns with Node3: show valuable summaries (command/result, METHOD - url - status),
 * not raw JSON dumps in the chat timeline.
 */

export type ToolPresentation = {
  line: string;
  summary: string;
  display_title: string;
  category: string;
  target?: string;
  command?: string;
  result?: Record<string, unknown>;
  result_text?: string;
};

const MAX_LINE = 480;
const MAX_COMMAND = 360;

export function friendlyToolName(toolName: string): string {
  const known: Record<string, string> = {
    http: "HTTP",
    browser: "Browser",
    scan: "Scan",
    traffic: "Traffic",
    actor: "Actor",
    verifier: "Verifier",
    coverage: "Coverage",
    finding: "Finding",
    finish_scan: "Finish Scan",
    poc: "PoC",
    workflow_run: "Workflow",
    workflow_list: "Workflow",
    workflow_dynamic: "Workflow",
    read: "Read",
  };
  const key = String(toolName || "").trim();
  if (known[key]) return known[key];
  if (!key) return "Tool";
  return key
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function toolCategory(toolName: string): string {
  const name = String(toolName || "").toLowerCase();
  if (["browser", "scan", "traffic"].includes(name)) return "discovery";
  if (["http"].includes(name)) return "request";
  if (["scan", "poc"].includes(name) && name === "scan") return "search";
  if (["verifier", "finding", "finish_scan"].includes(name)) return "finding";
  if (["coverage", "actor", "workflow_run", "workflow_list", "workflow_dynamic", "read"].includes(name)) return "planning";
  if (/exec|shell|command|docker/.test(name)) return "command";
  return "tool";
}

export function presentToolStart(toolName: string, args: Record<string, unknown> = {}): ToolPresentation {
  const title = friendlyToolName(toolName);
  const target = extractTarget(toolName, args, null);
  const command = extractCommand(toolName, args, null);
  const line = toolStartLine(toolName, args, target, command);
  return {
    line,
    summary: line,
    display_title: title,
    category: toolCategory(toolName),
    target: target || undefined,
    command: command || undefined,
  };
}

export function presentToolResult(
  toolName: string,
  args: Record<string, unknown> = {},
  text: string,
  isError: boolean,
  details?: unknown,
): ToolPresentation {
  const title = friendlyToolName(toolName);
  const parsed =
    parseJsonObject(text) ||
    extractPartialFields(text) ||
    (isRecord(details) ? details : null);
  const target = extractTarget(toolName, args, parsed);
  const command = extractCommand(toolName, args, parsed);
  const result = enrichResult(toolName, args, compactResult(parsed), target, command);
  const line = isError
    ? `${title} failed${shortError(text, parsed) ? `: ${shortError(text, parsed)}` : ""}`
    : toolResultLine(toolName, args, parsed, text, target, command);
  return {
    line: clip(line, MAX_LINE),
    summary: clip(line, MAX_LINE),
    display_title: title,
    category: toolCategory(toolName),
    target: target || undefined,
    command: command ? clip(command, MAX_COMMAND) : undefined,
    result: result || undefined,
    result_text: !parsed && text.trim() ? clip(text.trim(), 600) : undefined,
  };
}

function toolStartLine(
  toolName: string,
  args: Record<string, unknown>,
  target: string,
  command: string,
): string {
  const name = String(toolName || "").toLowerCase();
  if (name === "http") {
    const method = String(args.method || "GET").toUpperCase();
    return joinParts([method, target || String(args.url || ""), "running"]);
  }
  if (name === "browser") {
    const action = String(args.action || "browser");
    return joinParts([action, target || String(args.url || ""), "running"]);
  }
  if (name === "scan") {
    return joinParts([String(args.scanner || "scan"), target || String(args.url || args.target || ""), "running"]);
  }
  if (command) return joinParts([command, "running"]);
  if (target) return joinParts([friendlyToolName(toolName), target, "running"]);
  return `${friendlyToolName(toolName)} running`;
}

function toolResultLine(
  toolName: string,
  args: Record<string, unknown>,
  parsed: Record<string, unknown> | null,
  text: string,
  target: string,
  command: string,
): string {
  const name = String(toolName || "").toLowerCase();
  const status = statusFrom(parsed, text);

  if (name === "http") {
    const method = String(parsed?.method || args.method || "GET").toUpperCase();
    const url = target || String(parsed?.url || args.url || "");
    return joinParts([method, url, status || "done"]);
  }

  if (name === "browser") {
    const action = String(parsed?.action || args.action || "browser").toLowerCase();
    const url = target || String(parsed?.url || parsed?.requested_url || args.url || "");
    const title = String(parsed?.title || "").trim();
    // Navigation / page load: show GET - url - status like Node3 request cards.
    if (action === "goto" || action === "open" || action === "content" || action === "snapshot" || action === "screenshot") {
      const outcome = /^\d{3}$/.test(status) ? status : status || "ok";
      if (url) return joinParts(["GET", url, outcome]);
    }
    if (/^\d{3}$/.test(status) && url) return joinParts(["GET", url, status]);
    if (title && url) return joinParts([action, url, title]);
    return joinParts([action, url, status || "done"]);
  }

  if (name === "scan") {
    const scanner = String(parsed?.scanner || args.scanner || "scan");
    const url = target || String(args.url || args.target || parsed?.target || "");
    const exit = parsed?.exitCode ?? parsed?.exit_code;
    const exitLabel = exit === 0 || exit === "0" ? "ok" : exit !== undefined && exit !== null ? `exit ${exit}` : status || "done";
    return joinParts([scanner, url, exitLabel]);
  }

  if (name === "verifier") {
    const klass = String(args.vuln_class || parsed?.vuln_class || "check");
    const url = target || String(args.url || parsed?.url || "");
    const confirmed = parsed?.confirmed;
    const outcome = confirmed === true ? "confirmed" : confirmed === false ? "not confirmed" : status || "done";
    return joinParts([klass, url, outcome]);
  }

  if (name === "actor") {
    const action = String(args.action || parsed?.action || "actor");
    const id = String(args.id || parsed?.actor?.id || parsed?.active || "");
    return joinParts([action, id, status || "done"]);
  }

  if (name === "traffic") {
    const action = String(args.action || parsed?.action || "traffic");
    return joinParts([action, target, status || "done"]);
  }

  if (name === "coverage") {
    const action = String(args.action || parsed?.action || "coverage");
    return joinParts([action, String(args.endpoint || parsed?.endpoint || ""), status || "done"]);
  }

  if (name === "finding") {
    const action = String(args.action || "finding");
    const title = String(args.title || parsed?.title || "");
    return joinParts([action, title, status || "done"]);
  }

  if (name === "finish_scan") {
    return joinParts(["finish_scan", String(args.status || parsed?.status || parsed?.finish_scan?.status || ""), status || "done"]);
  }

  if (name === "workflow_run" || name === "workflow_list" || name === "workflow_dynamic") {
    const wf = String(args.workflow || parsed?.name || parsed?.runId || "workflow");
    return joinParts([friendlyToolName(toolName), wf, status || "done"]);
  }

  if (command) {
    const out = firstNonJsonLine(text) || status || "done";
    return joinParts([command, out === command ? status || "done" : clip(out, 160)]);
  }

  if (target) return joinParts([friendlyToolName(toolName), target, status || "done"]);

  const message = String(parsed?.summary || parsed?.message || parsed?.reason || firstNonJsonLine(text) || "done");
  return joinParts([friendlyToolName(toolName), clip(message, 200)]);
}

function extractTarget(toolName: string, args: Record<string, unknown>, parsed: Record<string, unknown> | null): string {
  const name = String(toolName || "").toLowerCase();
  if (name === "http") return String(parsed?.url || args.url || "");
  if (name === "browser") return String(parsed?.url || parsed?.requested_url || args.url || "");
  if (name === "scan") return String(args.url || args.target || parsed?.target || "");
  if (name === "verifier") return String(args.url || parsed?.url || "");
  return String(args.url || args.target || parsed?.url || parsed?.target || "");
}

function extractCommand(toolName: string, args: Record<string, unknown>, parsed: Record<string, unknown> | null): string {
  const name = String(toolName || "").toLowerCase();
  if (name === "scan") {
    const scanner = String(args.scanner || parsed?.scanner || "scan");
    const argv = Array.isArray(parsed?.argv)
      ? (parsed!.argv as unknown[]).map(String)
      : Array.isArray(parsed?.execution) && false
        ? []
        : Array.isArray((parsed?.execution as any)?.argv)
          ? ((parsed!.execution as any).argv as unknown[]).map(String)
          : Array.isArray(args.args)
            ? (args.args as unknown[]).map(String)
            : [];
    const target = String(args.url || args.target || "");
    if (argv.length) return clip(`${scanner} ${argv.join(" ")}`, MAX_COMMAND);
    return clip([scanner, target].filter(Boolean).join(" "), MAX_COMMAND);
  }
  if (typeof args.command === "string") return args.command;
  if (typeof parsed?.command === "string") return String(parsed.command);
  const execution = parsed?.execution as Record<string, unknown> | undefined;
  if (execution && Array.isArray(execution.argv)) {
    const cmd = String(execution.command || toolName);
    return clip(`${cmd} ${(execution.argv as unknown[]).map(String).join(" ")}`, MAX_COMMAND);
  }
  return "";
}

function statusFrom(parsed: Record<string, unknown> | null, text: string): string {
  if (parsed) {
    const code = parsed.status ?? parsed.status_code ?? parsed.statusCode;
    // Prefer numeric HTTP codes; ignore free-form "status":"done" from non-HTTP tools when code-like.
    if (code !== undefined && code !== null && String(code).trim()) {
      const asText = String(code).trim();
      if (/^\d{3}$/.test(asText) || !["done", "ok", "success", "completed", "running", "error", "failed"].includes(asText.toLowerCase())) {
        return asText;
      }
      if (typeof parsed.status === "string") return asText;
    }
    if (parsed.ok === false) return "error";
    if (parsed.ok === true) return "ok";
    if (parsed.confirmed === true) return "confirmed";
    if (parsed.confirmed === false) return "not confirmed";
    if (typeof parsed.status === "string") return parsed.status;
  }
  const explicit = text.match(/"status(?:_code|Code)?"\s*:\s*(\d{3})\b/);
  if (explicit?.[1]) return explicit[1];
  const m = text.match(/\b([1-5]\d{2})\b/);
  return m?.[1] || "";
}

/** When full JSON is truncated (large response bodies), still recover key display fields. */
function extractPartialFields(text: string): Record<string, unknown> | null {
  const source = String(text || "");
  if (!source.includes("{")) return null;
  const out: Record<string, unknown> = {};
  const status = source.match(/"status(?:_code|Code)?"\s*:\s*(\d{3})\b/);
  if (status?.[1]) out.status = Number(status[1]);
  const method = source.match(/"method"\s*:\s*"([A-Z]+)"/i);
  if (method?.[1]) out.method = method[1].toUpperCase();
  const url = source.match(/"url"\s*:\s*"(https?:\/\/[^"]+)"/i) || source.match(/"requested_url"\s*:\s*"(https?:\/\/[^"]+)"/i);
  if (url?.[1]) out.url = url[1];
  const action = source.match(/"action"\s*:\s*"([^"]+)"/i);
  if (action?.[1]) out.action = action[1];
  const scanner = source.match(/"scanner"\s*:\s*"([^"]+)"/i);
  if (scanner?.[1]) out.scanner = scanner[1];
  const confirmed = source.match(/"confirmed"\s*:\s*(true|false)\b/i);
  if (confirmed?.[1]) out.confirmed = confirmed[1].toLowerCase() === "true";
  const exitCode = source.match(/"exitCode"\s*:\s*(-?\d+)\b/);
  if (exitCode?.[1]) out.exitCode = Number(exitCode[1]);
  const title = source.match(/"title"\s*:\s*"([^"]{1,120})"/);
  if (title?.[1]) out.title = title[1];
  return Object.keys(out).length ? out : null;
}

function enrichResult(
  toolName: string,
  args: Record<string, unknown>,
  result: Record<string, unknown> | null,
  target: string,
  command: string,
): Record<string, unknown> | null {
  const name = String(toolName || "").toLowerCase();
  const base: Record<string, unknown> = { ...(result || {}) };
  if (name === "http") {
    if (!base.method) base.method = String(args.method || "GET").toUpperCase();
    if (!base.url && target) base.url = target;
  }
  if (name === "browser") {
    if (!base.action && args.action) base.action = args.action;
    if (!base.url && target) base.url = target;
    if (!base.method && (String(base.action || args.action || "").toLowerCase() === "goto" || target)) {
      base.method = "GET";
    }
  }
  if (name === "scan") {
    if (!base.scanner && args.scanner) base.scanner = args.scanner;
    if (!base.command && command) base.command = command;
  }
  if (command && !base.command) base.command = command;
  return Object.keys(base).length ? base : null;
}

function compactResult(parsed: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!parsed) return null;
  const kept: Record<string, unknown> = {};
  for (const key of [
    "method",
    "url",
    "status",
    "status_code",
    "statusCode",
    "action",
    "scanner",
    "command",
    "argv",
    "exitCode",
    "confirmed",
    "reason",
    "title",
    "summary",
    "message",
    "ok",
    "blocked",
    "error",
    "evidence_id",
    "traffic_id",
    "actor",
  ]) {
    if (parsed[key] !== undefined) kept[key] = parsed[key];
  }
  return Object.keys(kept).length ? kept : null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    // try last JSON object in multi-line output
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function firstNonJsonLine(text: string): string {
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("[")) continue;
    return trimmed;
  }
  return "";
}

function shortError(text: string, parsed: Record<string, unknown> | null): string {
  if (parsed) {
    const err = parsed.error || parsed.message || parsed.reason;
    if (err) return clip(String(err), 160);
  }
  return clip(firstNonJsonLine(text) || text.trim(), 160);
}

function joinParts(parts: Array<string | undefined | null>): string {
  return parts
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(" - ");
}

function clip(value: string, max: number): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
