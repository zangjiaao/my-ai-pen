import type { PlatformMessage, ToolRuntime } from "../types.js";

export function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

export function jsonResult(value: unknown, details: Record<string, unknown> = {}) {
  return textResult(JSON.stringify(value, null, 2), details);
}

export async function emitEvidence(
  runtime: ToolRuntime,
  sourceTool: string,
  summary: string,
  data: unknown,
): Promise<string> {
  const evidence = await runtime.evidence.create({ type: "tool_output", sourceTool, summary, data });
  // Platform EvidenceDetailDialog needs structured properties — not just a summary line.
  const properties = evidencePropertiesForPlatform(sourceTool, data);
  await runtime.platform.send({
    type: "evidence_created",
    conversation_id: runtime.task.conversationId,
    task_id: runtime.task.taskId,
    evidence_id: evidence.id,
    source_tool: sourceTool,
    summary: String(summary || "").slice(0, 500),
    evidence_type: properties.kind === "http" ? "http_exchange" : "tool_output",
    properties,
  } as PlatformMessage);
  return evidence.id;
}

/** Compact, UI-friendly payload for platform evidence rows (no multi-MB dumps). */
export function evidencePropertiesForPlatform(
  sourceTool: string,
  data: unknown,
): Record<string, unknown> {
  const tool = String(sourceTool || "tool").toLowerCase();
  const rec =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { value: data };

  if (tool === "http" || rec.method != null || rec.url != null) {
    return {
      kind: "http",
      method: rec.method,
      url: rec.url,
      status: rec.status ?? rec.status_code ?? rec.statusCode,
      headers: rec.headers,
      request_headers: rec.request_headers || rec.requestHeaders,
      request_body: clip(rec.request_body || rec.requestBody || rec.body, 2000),
      response_headers: rec.response_headers || rec.responseHeaders || rec.headers,
      response_body: clip(rec.body_preview || rec.response_body || rec.responseBody || rec.body, 4000),
      body_preview: clip(rec.body_preview || rec.body, 4000),
    };
  }

  if (tool === "shell" || tool === "script") {
    const stdout = clip(rec.stdout, 6000);
    const stderr = clip(rec.stderr, 2000);
    const command = clip(rec.command || rec.file, 800);
    return {
      kind: "shell",
      command,
      file: rec.file,
      exitCode: rec.exitCode ?? rec.exit_code,
      timedOut: rec.timedOut,
      aborted: rec.aborted,
      stdout,
      stderr,
      // short proof for cards
      proof: {
        exitCode: rec.exitCode ?? rec.exit_code,
        stdout_excerpt: clip(stdout, 800),
      },
    };
  }

  if (tool === "browser" || tool.includes("browser")) {
    return {
      kind: "browser",
      url: rec.url,
      action: rec.action,
      html: clip(rec.html || rec.content, 3000),
      text: clip(rec.text, 2000),
    };
  }

  // Generic: keep a small data blob, not the entire tool JSON tree.
  return {
    kind: "tool",
    data: clipJson(rec, 6000),
  };
}

function clip(value: unknown, max: number): string {
  if (value === undefined || value === null) return "";
  const s = String(value);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function clipJson(value: unknown, max: number): unknown {
  try {
    const raw = JSON.stringify(value);
    if (raw.length <= max) return value;
    return { truncated: true, preview: raw.slice(0, max - 1) + "…" };
  } catch {
    return { note: "unserializable" };
  }
}

export function targetBase(runtime: ToolRuntime): string | undefined {
  const value = runtime.task.target?.value;
  return typeof value === "string" && value ? value : undefined;
}

export function resolveTargetUrl(runtime: ToolRuntime, raw: string): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = targetBase(runtime);
  if (!base) throw new Error(`relative url requires task target.value: ${raw}`);
  const normalizedBase = /^https?:\/\//i.test(base) ? base : `http://${base}`;
  return new URL(raw, normalizedBase.endsWith("/") ? normalizedBase : `${normalizedBase}/`).toString();
}

export function isInScope(runtime: ToolRuntime, rawUrlOrHost: string): boolean {
  const allow = Array.isArray(runtime.task.scope?.allow) ? (runtime.task.scope.allow as unknown[]) : [];
  if (allow.length === 0) return true;
  const value = rawUrlOrHost.toLowerCase();
  return allow.some((entry) => {
    if (typeof entry !== "string" || !entry) return false;
    const normalized = entry.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
    const comparable = value.replace(/^https?:\/\//, "").replace(/\/$/, "");
    return comparable.includes(normalized) || normalized.includes(comparable.split("/")[0] || "");
  });
}
