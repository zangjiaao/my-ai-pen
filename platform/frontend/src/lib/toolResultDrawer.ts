/**
 * Tool result drawer bodies (stdout / pretty JSON / specialized families).
 * Request-line projection stays in toolDetail.ts.
 */

import {
  isJsonBlobText,
  isLifecycleOnlyText,
  tryParseJsonRecord,
  asRecord,
  firstString,
} from "./toolDetail";

/** Chat drawer body cap (display only; wire may already truncate earlier). */
const DRAWER_BODY_MAX = 24_000;

function clipDrawerBody(text: string, max = DRAWER_BODY_MAX): string {
  const t = text.trimEnd();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n\n…(聊天预览已截断，共约 ${t.length} 字符)`;
}

/** Historical wire bug: non-shell ok-JSON rewritten to empty shell shell-shape. */
function isDestroyedEmptyShellResult(r: Record<string, unknown> | null): boolean {
  if (!r) return false;
  const keys = Object.keys(r);
  if (keys.length > 8) return false;
  if (r.vulnerabilities != null || r.assets != null || r.finding != null) return false;
  const out = String(r.stdout ?? "");
  const err = String(r.stderr ?? "");
  if (out.trim() || err.trim()) return false;
  if (r.exitCode != null || r.exit_code != null) return false;
  return (
    (r.wire_truncated === true || r.output_truncated === true)
    && (r.stdout != null || r.stderr != null || r.ok != null)
    && typeof r.command !== "string"
  );
}

function isShellShapedResult(r: Record<string, unknown>): boolean {
  // Platform ledger / list payloads must never take the shell drawer path.
  if (
    r.vulnerabilities != null
    || r.assets != null
    || r.experts != null
    || r.reports != null
    || r.findings != null
    || r.finding != null
    || (Array.isArray(r.items) && r.command == null)
  ) {
    return false;
  }
  if (isDestroyedEmptyShellResult(r)) return false;
  if (r.exitCode != null || r.exit_code != null) return true;
  if (r.timedOut != null || r.aborted != null) return true;
  const out = String(r.stdout ?? "").trim();
  const err = String(r.stderr ?? "").trim();
  if (out || err) return true;
  // Empty streams only count as shell when a real process command is present.
  if (
    (typeof r.command === "string" || typeof r.cmd === "string")
    && (r.ok != null || r.timeout_seconds != null || r.output_archive != null || r.output_truncated === true)
  ) {
    return true;
  }
  return false;
}

function prettyJson(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return "";
    const parsed = tryParseJsonRecord(t);
    if (parsed) {
      try {
        return JSON.stringify(parsed, null, 2);
      } catch {
        return t;
      }
    }
    return t;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Dual raw dump — last-resort when a tool has no specialized projection,
 * or when specialized projection is empty but args/result exist.
 */
export function formatRawToolIoFallback(input: {
  args?: unknown;
  command?: unknown;
  result?: unknown;
  result_text?: unknown;
  summary?: unknown;
}): string {
  const req =
    prettyJson(input.args)
    || (String(input.command || "").trim()
      ? prettyJson({ command: String(input.command).trim() })
      : "");
  const res =
    prettyJson(input.result)
    || prettyJson(input.result_text)
    || prettyJson(input.summary);
  const parts: string[] = [];
  if (req) parts.push(`【请求】\n${req}`);
  if (res) {
    // Avoid duplicating destroyed empty-shell as "response"
    const resObj = asRecord(input.result) || tryParseJsonRecord(input.result_text) || tryParseJsonRecord(input.summary);
    if (resObj && isDestroyedEmptyShellResult(resObj)) {
      parts.push("【响应】\n(结果在上屏时丢失/被截断，库中仅剩空壳标记 — 请重跑该工具)");
    } else {
      parts.push(`【响应】\n${res}`);
    }
  }
  return clipDrawerBody(parts.join("\n\n"));
}

/**
 * Human-readable shell drawer: real newlines, not `{"stdout":"\\n<html…"}` JSON dump.
 * Command is intentionally omitted here — the request row shows it (expands to full wrap).
 */
function formatShellDrawerBody(r: Record<string, unknown>): string {
  const parts: string[] = [];
  const stdout = String(r.stdout ?? "").replace(/\r\n/g, "\n");
  const stderr = String(r.stderr ?? "").replace(/\r\n/g, "\n");
  const exit = r.exitCode ?? r.exit_code;
  const meta: string[] = [];
  if (exit != null && exit !== "") meta.push(`exit=${exit}`);
  if (r.timedOut === true) meta.push("timed out");
  if (r.aborted === true) meta.push("aborted");
  if (r.ok === false) meta.push("failed");
  if (meta.length) parts.push(meta.join(" · "));

  if (stdout.trim()) parts.push(stdout.replace(/\s+$/, ""));
  if (stderr.trim()) {
    parts.push(`--- stderr ---\n${stderr.replace(/\s+$/, "")}`);
  }
  if (!stdout.trim() && !stderr.trim()) {
    if (r.wire_truncated === true || r.output_truncated === true) {
      parts.push("(无 stdout/stderr — 结果在上屏时被截断；请重跑该命令或查看任务 tool-output 归档)");
    } else if (!meta.length) {
      parts.push("(无输出)");
    }
  }
  let body = parts.join("\n\n");
  if (r.output_truncated === true || r.wire_truncated === true) {
    const arch = String(r.output_archive || "").trim();
    if (stdout.trim() || stderr.trim()) {
      body += arch
        ? `\n\n…(输出已截断，完整见 ${arch})`
        : "\n\n…(输出已截断)";
    } else if (arch) {
      body += `\n\n完整输出见 ${arch}`;
    }
  }
  return clipDrawerBody(body);
}

function formatTodoDrawerBody(r: Record<string, unknown>): string | null {
  if (isDestroyedEmptyShellResult(r)) return null;
  const lines: string[] = [];
  const op = String(r.op || "").trim();
  const task = String(r.task || "").trim();
  if (op || task) lines.push([op, task].filter(Boolean).join(" · "));
  if (r.ok === true) lines.push("ok");
  if (r.ok === false) lines.push("failed");
  if (Array.isArray(r.completed_tasks) && r.completed_tasks.length) {
    const bits = r.completed_tasks.slice(0, 5).map((ct) => {
      if (!ct || typeof ct !== "object") return String(ct);
      const o = ct as { phase?: string; content?: string };
      return [o.phase, o.content].filter(Boolean).join(" / ") || String(ct);
    });
    lines.push(`completed: ${bits.join("; ")}`);
  }
  const summary = String(r.summary || "").trim();
  if (summary && !isLifecycleOnlyText(summary) && !isJsonBlobText(summary)) {
    lines.push(summary.length > 2000 ? `${summary.slice(0, 2000)}…` : summary);
  }
  // Remaining list preview
  if (Array.isArray(r.remaining) && r.remaining.length) {
    lines.push(`remaining ${r.remaining.length} items`);
  }
  if (Array.isArray(r.list) && r.list.length) {
    lines.push(`list phases: ${r.list.length}`);
  }
  if (!lines.length) return null;
  return clipDrawerBody(lines.join("\n"));
}

function formatFindingDrawerBody(r: Record<string, unknown>): string | null {
  if (isDestroyedEmptyShellResult(r)) return null;
  const f =
    r.finding && typeof r.finding === "object" && !Array.isArray(r.finding)
      ? (r.finding as Record<string, unknown>)
      : r;
  const lines: string[] = [];
  if (r.ok === true) lines.push("ok");
  if (r.ok === false) lines.push("failed");
  if (r.created === true) lines.push("created=true");
  if (r.created === false) lines.push("created=false (merge/rediscovery)");
  const id = String(f.id || r.id || "").trim();
  const action = String(f.action || r.action || "").trim();
  const title = String(f.title || r.title || "").trim();
  const severity = String(f.severity || r.severity || "").trim();
  const location = String(f.location || r.location || "").trim();
  if (id) lines.push(`id: ${id}`);
  if (action) lines.push(`action: ${action}`);
  if (title) lines.push(`title: ${title}`);
  if (severity) lines.push(`severity: ${severity}`);
  if (location) lines.push(`location: ${location}`);
  if (!lines.length) return null;
  return clipDrawerBody(lines.join("\n"));
}

function formatHttpDrawerBody(r: Record<string, unknown>): string | null {
  if (isDestroyedEmptyShellResult(r)) return null;
  // Prefer HTTP response shape over shell (http tool may not have exitCode).
  const status = r.status ?? r.status_code;
  const url = String(r.url || r.requested_url || "").trim();
  if (status == null && !url && r.body == null && r.headers == null) return null;
  const lines: string[] = [];
  if (status != null) lines.push(`status: ${status}`);
  if (url) lines.push(`url: ${url}`);
  const headers = asRecord(r.headers);
  if (headers) {
    const prefer = [
      "content-type",
      "server",
      "location",
      "set-cookie",
      "access-control-allow-origin",
      "x-powered-by",
    ];
    const shown: string[] = [];
    for (const k of prefer) {
      const v = headers[k] ?? headers[k.toLowerCase()];
      if (v != null && String(v).trim()) shown.push(`${k}: ${String(v).slice(0, 120)}`);
    }
    if (!shown.length) {
      for (const [k, v] of Object.entries(headers).slice(0, 6)) {
        shown.push(`${k}: ${String(v).slice(0, 80)}`);
      }
    }
    if (shown.length) lines.push(`headers:\n  ${shown.join("\n  ")}`);
  }
  const body = r.body ?? r.text ?? r.data;
  if (body != null && String(body).trim()) {
    const b = String(body);
    lines.push(`body:\n${b.length > 4000 ? `${b.slice(0, 4000)}…` : b}`);
  }
  if (r.truncated === true) lines.push("…(body truncated)");
  if (!lines.length) return null;
  return clipDrawerBody(lines.join("\n\n"));
}

function formatLedgerListDrawerBody(r: Record<string, unknown>): string | null {
  if (isDestroyedEmptyShellResult(r)) return null;
  const listKey =
    Array.isArray(r.vulnerabilities)
      ? "vulnerabilities"
      : Array.isArray(r.assets)
        ? "assets"
        : Array.isArray(r.experts)
          ? "experts"
          : Array.isArray(r.reports)
            ? "reports"
            : Array.isArray(r.findings)
              ? "findings"
              : Array.isArray(r.items)
                ? "items"
                : "";
  if (!listKey) {
    if (r.ok != null || r.count != null || r.total != null) {
      const bits = [
        r.ok === true ? "ok" : r.ok === false ? "failed" : "",
        r.count != null ? `count=${r.count}` : "",
        r.total != null ? `total=${r.total}` : "",
      ].filter(Boolean);
      return bits.length ? clipDrawerBody(bits.join(" · ")) : null;
    }
    return null;
  }
  const arr = r[listKey] as unknown[];
  const total = Number(r[`${listKey}_wire_total`] ?? r.total ?? r.count ?? arr.length);
  const lines: string[] = [];
  lines.push(`${listKey}: ${arr.length}${total > arr.length ? ` / ${total}` : ""}`);
  for (const row of arr.slice(0, 20)) {
    if (!row || typeof row !== "object") {
      lines.push(`- ${String(row).slice(0, 120)}`);
      continue;
    }
    const o = row as Record<string, unknown>;
    const title = String(o.title || o.name || o.address || o.email || o.id || "").trim();
    const sev = String(o.severity || o.status || o.type || "").trim();
    const id = String(o.id || "").trim();
    const bit = [title, sev, id && id !== title ? id.slice(0, 12) : ""].filter(Boolean).join(" · ");
    lines.push(`- ${bit || JSON.stringify(o).slice(0, 120)}`);
  }
  if (arr.length > 20) lines.push(`… +${arr.length - 20} more`);
  if (r.wire_truncated === true) lines.push("(wire truncated)");
  return clipDrawerBody(lines.join("\n"));
}

function formatDecisionDrawerBody(r: Record<string, unknown>): string | null {
  if (isDestroyedEmptyShellResult(r)) return null;
  const lines: string[] = [];
  if (r.ok === true) lines.push("ok");
  if (r.decision != null) lines.push(`decision: ${String(r.decision)}`);
  if (r.kind != null) lines.push(`kind: ${String(r.kind)}`);
  if (r.request_id != null) lines.push(`request_id: ${String(r.request_id)}`);
  if (r.selected != null) lines.push(`selected: ${prettyJson(r.selected)}`);
  if (r.handoff_pack_id != null) lines.push(`handoff_pack_id: ${String(r.handoff_pack_id)}`);
  if (!lines.length) return null;
  return clipDrawerBody(lines.join("\n"));
}

function toolFamilyForDrawer(toolId: string, toolName: string, parsed: Record<string, unknown> | null): string {
  const name = `${toolId} ${toolName}`.toLowerCase();
  if (/shell|exec|stdin|执行命令|命令输入|运行脚本/.test(name)) return "shell";
  if (/^todo\b|任务清单/.test(name) || toolId === "todo") return "todo";
  if (toolId === "finding" || /^finding$|登记发现/.test(name)) return "finding";
  if (/request_user_decision|用户授权/.test(name) || toolId === "request_user_decision") return "decision";
  if (/^http\b|http 探测|http 请求/.test(name) || toolId === "http") return "http";
  if (/platform_list_|查询漏洞|查询资产|list_vulnerabilit|list_assets|list_experts|list_reports/.test(name)) {
    return "ledger_list";
  }
  if (/platform_get_|platform_update|platform_/.test(name)) return "platform";
  // Infer from payload when tool id missing
  if (parsed) {
    if (isShellShapedResult(parsed)) return "shell";
    if (parsed.finding != null || (parsed.action && parsed.title && parsed.poc)) return "finding";
    if (parsed.vulnerabilities != null || parsed.assets != null) return "ledger_list";
    if (parsed.decision != null && parsed.request_id != null) return "decision";
    if (parsed.status != null && (parsed.headers != null || parsed.body != null) && parsed.url) return "http";
    if (parsed.op != null && (parsed.task != null || parsed.completed_tasks != null || parsed.list != null)) {
      return "todo";
    }
  }
  return "generic";
}

/**
 * Pretty body for the result drawer — **per-tool customized**, with raw req/resp JSON fallback.
 */
export function formatToolResultDrawerBody(input: {
  toolId?: unknown;
  toolName?: unknown;
  args?: unknown;
  command?: unknown;
  summary?: unknown;
  result?: unknown;
  result_text?: unknown;
  stdout?: unknown;
}): string {
  const toolId = String(input.toolId || "").trim().toLowerCase();
  const toolName = String(input.toolName || "").trim().toLowerCase();
  const args = asRecord(input.args);
  const stdoutDirect = String(input.stdout ?? "").trim();

  const parsed =
    asRecord(input.result)
    || tryParseJsonRecord(input.summary)
    || tryParseJsonRecord(input.result_text);

  const family = toolFamilyForDrawer(toolId, toolName, parsed);
  const rawFallback = () =>
    formatRawToolIoFallback({
      args: args || input.args,
      command: input.command,
      result: parsed || input.result,
      result_text: input.result_text,
      summary: input.summary,
    });

  // Destroyed wire payload: still show request; honest about response.
  if (parsed && isDestroyedEmptyShellResult(parsed)) {
    return rawFallback();
  }

  if (family === "shell" || (parsed && isShellShapedResult(parsed) && family !== "ledger_list" && family !== "finding" && family !== "todo" && family !== "decision" && family !== "http")) {
    const shellParsed = parsed && isShellShapedResult(parsed) ? parsed : null;
    if (shellParsed) {
      const merged =
        stdoutDirect && !isJsonBlobText(stdoutDirect)
          && stdoutDirect.length > String(shellParsed.stdout || "").length
          ? { ...shellParsed, stdout: stdoutDirect }
          : shellParsed;
      const body = formatShellDrawerBody(merged);
      if (body.trim()) return body;
    }
    if (stdoutDirect && !isJsonBlobText(stdoutDirect)) return clipDrawerBody(stdoutDirect);
    return rawFallback();
  }

  if (family === "todo") {
    const body = parsed ? formatTodoDrawerBody(parsed) : null;
    if (body?.trim()) return body;
    return rawFallback();
  }

  if (family === "finding") {
    const body = parsed ? formatFindingDrawerBody(parsed) : null;
    if (body?.trim()) return body;
    return rawFallback();
  }

  if (family === "http") {
    const body = parsed ? formatHttpDrawerBody(parsed) : null;
    if (body?.trim()) return body;
    return rawFallback();
  }

  if (family === "ledger_list" || family === "platform") {
    const body = parsed ? formatLedgerListDrawerBody(parsed) : null;
    if (body?.trim()) return body;
    // platform get single object — pretty JSON of result is fine; still try raw dual
    if (parsed && !isDestroyedEmptyShellResult(parsed)) {
      const pj = prettyJson(parsed);
      if (pj) return clipDrawerBody(pj);
    }
    return rawFallback();
  }

  if (family === "decision") {
    const body = parsed ? formatDecisionDrawerBody(parsed) : null;
    if (body?.trim()) return body;
    return rawFallback();
  }

  // Generic: specialized text field, else dual raw JSON
  if (stdoutDirect && !isJsonBlobText(stdoutDirect)) {
    return clipDrawerBody(stdoutDirect);
  }
  if (parsed) {
    if (isShellShapedResult(parsed)) return formatShellDrawerBody(parsed);
    const texty = firstString(parsed, ["output", "text", "body", "content", "message", "summary"]);
    if (texty && texty.length >= 40 && Object.keys(parsed).length <= 8) {
      return clipDrawerBody(texty);
    }
  }
  const dual = rawFallback();
  if (dual.trim()) return dual;
  const raw = String(input.result_text ?? input.summary ?? "").trim();
  return raw ? clipDrawerBody(raw) : "";
}
