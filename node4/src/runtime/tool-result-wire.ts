/**
 * Main-chat tool result_text clipping + request-line surface fields.
 * Kept out of run-node4-agent so the session bridge stays under 1k lines.
 */

/** Main-chat tool result_text budget (was 4k; long shell cmds ate stdout). */
export const TOOL_RESULT_TEXT_WIRE_MAX = 12_000;
/** Full shell command on content.command / args — not a 500-char chip tease. */
export const SHELL_COMMAND_WIRE_MAX = 8_000;

/** True when jsonResult looks like shell/process output (not platform ledger lists). */
export function isShellToolResultPayload(p: Record<string, unknown>): boolean {
  if (p.stdout != null || p.stderr != null) return true;
  if (p.exitCode != null || p.exit_code != null) return true;
  if (p.timedOut != null || p.aborted != null) return true;
  // Platform list/get payloads often have ok + arrays — never treat as shell.
  if (
    p.vulnerabilities != null
    || p.assets != null
    || p.experts != null
    || p.reports != null
    || p.findings != null
    || p.items != null
  ) {
    return false;
  }
  // Shell empty-output: command + ok / timeout_seconds
  if (typeof p.command === "string" || typeof p.cmd === "string") {
    return p.ok != null || p.timeout_seconds != null || p.output_archive != null;
  }
  return false;
}

/**
 * Clip tool result JSON for the wire without destroying the payload.
 * - Shell: prefer exit + streams; demote long command (lives on content.command).
 * - Other tools (ledger lists, etc.): shrink arrays / hard-slice JSON — never rebuild as empty shell.
 */
export function clipToolResultTextForWire(
  raw: string,
  max = TOOL_RESULT_TEXT_WIRE_MAX,
): string {
  const text = String(raw || "");
  if (text.length <= max) return text;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return text.slice(0, max);
  try {
    const p = JSON.parse(trimmed) as Record<string, unknown>;
    if (!p || typeof p !== "object" || Array.isArray(p)) return text.slice(0, max);

    if (isShellToolResultPayload(p)) {
      return clipShellResultTextForWire(p, max);
    }
    return clipGenericJsonResultForWire(p, max);
  } catch {
    return text.slice(0, max);
  }
}

function clipShellResultTextForWire(p: Record<string, unknown>, max: number): string {
  const fullCmd = String(p.command ?? p.cmd ?? "");
  let stdout = String(p.stdout ?? "");
  let stderr = String(p.stderr ?? "");

  const build = (out: string, err: string, command: string | undefined): string => {
    const body: Record<string, unknown> = {};
    // Outcome fields first (survives any residual hard slice).
    if (p.ok !== undefined) body.ok = p.ok;
    if (p.exitCode !== undefined) body.exitCode = p.exitCode;
    else if (p.exit_code !== undefined) body.exit_code = p.exit_code;
    if (p.timedOut !== undefined) body.timedOut = p.timedOut;
    if (p.aborted !== undefined) body.aborted = p.aborted;
    body.output_truncated = true;
    if (p.output_archive != null) body.output_archive = p.output_archive;
    if (p.output_original_chars != null) body.output_original_chars = p.output_original_chars;
    body.stdout = out;
    body.stderr = err;
    if (p.timeout_seconds !== undefined) body.timeout_seconds = p.timeout_seconds;
    if (command !== undefined && command !== "") body.command = command;
    body.wire_truncated = true;
    return JSON.stringify(body);
  };

  // 1) streams + short command preview
  let commandField: string | undefined =
    fullCmd.length > 240 ? `${fullCmd.slice(0, 240)}…` : fullCmd || undefined;
  let s = build(stdout, stderr, commandField);
  if (s.length <= max) return s;

  // 2) streams only (full command already on args / content.command)
  s = build(stdout, stderr, undefined);
  if (s.length <= max) return s;

  // 3) shrink streams to fit
  const overhead = build("", "", undefined).length + 64;
  let budget = Math.max(256, max - overhead);
  if (!stderr) {
    stdout = stdout.slice(0, budget);
  } else {
    const outBudget = Math.floor(budget * 0.85);
    stdout = stdout.slice(0, outBudget);
    stderr = stderr.slice(0, budget - outBudget);
  }
  for (let i = 0; i < 24; i++) {
    s = build(stdout, stderr, undefined);
    if (s.length <= max) return s;
    if (!stdout && !stderr) return s.slice(0, max);
    if (stdout.length >= stderr.length && stdout.length > 0) {
      stdout = stdout.slice(0, Math.max(0, stdout.length - Math.max(64, s.length - max)));
    } else if (stderr.length > 0) {
      stderr = stderr.slice(0, Math.max(0, stderr.length - Math.max(64, s.length - max)));
    } else {
      break;
    }
  }
  return s.slice(0, max);
}

/** Ledger lists / platform JSON: keep valid JSON; shrink large arrays (never empty-shell rewrite). */
function clipGenericJsonResultForWire(p: Record<string, unknown>, max: number): string {
  const body: Record<string, unknown> = { ...p, wire_truncated: true };
  let s = JSON.stringify(body);
  if (s.length <= max) return s;

  for (const key of Object.keys(body)) {
    if (!Array.isArray(body[key])) continue;
    const arr = body[key] as unknown[];
    let n = arr.length;
    while (n > 0) {
      body[key] = arr.slice(0, n);
      body[`${key}_wire_total`] = arr.length;
      s = JSON.stringify(body);
      if (s.length <= max) return s;
      n = Math.floor(n / 2);
    }
    body[key] = [];
    body[`${key}_wire_total`] = arr.length;
    s = JSON.stringify(body);
    if (s.length <= max) return s;
  }

  // Shorten bulky strings
  for (const key of Object.keys(body)) {
    if (typeof body[key] === "string" && String(body[key]).length > 240) {
      body[key] = `${String(body[key]).slice(0, 240)}…`;
    }
  }
  s = JSON.stringify(body);
  if (s.length <= max) return s;

  // Minimal valid stub — never hard-slice mid-JSON into invalid text.
  const stub: Record<string, unknown> = {
    wire_truncated: true,
    note: "result too large for chat wire; re-call with a smaller limit",
  };
  if (p.ok !== undefined) stub.ok = p.ok;
  for (const key of Object.keys(body)) {
    if (Array.isArray(body[key]) && typeof body[`${key}_wire_total`] === "number") {
      stub[key] = [];
      stub[`${key}_wire_total`] = body[`${key}_wire_total`];
    }
  }
  s = JSON.stringify(stub);
  return s.length <= max ? s : JSON.stringify({ wire_truncated: true, note: "result too large" });
}

/** Best-effort command string from shell/script tool args (for Main tool chip). */
export function commandFromToolArgs(args: Record<string, unknown> | null | undefined): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  for (const key of ["command", "cmd", "script", "code", "input"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, SHELL_COMMAND_WIRE_MAX);
  }
  return "";
}

/** Pull command from tool result JSON body when args were dropped. */
export function commandFromResultText(resultText: string | null | undefined): string {
  const raw = String(resultText || "").trim();
  if (!raw.startsWith("{")) return "";
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ["command", "cmd", "script"]) {
      const v = parsed?.[key];
      if (typeof v === "string" && v.trim()) return v.trim().slice(0, SHELL_COMMAND_WIRE_MAX);
    }
  } catch {
    /* ignore truncated JSON — open recover is FE-side */
  }
  return "";
}

/** Ensure args carries command for shell-like tools (Main request line). */
export function enrichArgsWithCommand(
  args: Record<string, unknown> | null | undefined,
  resultText?: string | null,
): Record<string, unknown> | undefined {
  const base =
    args && typeof args === "object" && !Array.isArray(args) ? { ...args } : ({} as Record<string, unknown>);
  if (!commandFromToolArgs(base)) {
    const fromResult = commandFromResultText(resultText);
    if (fromResult) base.command = fromResult;
  }
  return Object.keys(base).length ? base : args || undefined;
}

/**
 * Map tool args → wire fields the UI can show next to the tool title.
 * - shell/script → command
 * - http/browser/fs/skill/… → target (url/path/op id) or command when applicable
 */
export function surfaceFieldsFromToolArgs(
  toolName: string,
  args: Record<string, unknown> | null | undefined,
): { command: string; target: string } {
  const name = String(toolName || "").trim().toLowerCase();
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { command: "", target: "" };
  }
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const v = args[key];
      if (typeof v === "string" && v.trim()) return v.trim().slice(0, 500);
    }
    return "";
  };
  /** Shell commands are multi-line scripts — keep nearly full text on the chip. */
  const pickShell = (...keys: string[]): string => {
    for (const key of keys) {
      const v = args[key];
      if (typeof v === "string" && v.trim()) return v.trim().slice(0, SHELL_COMMAND_WIRE_MAX);
    }
    return "";
  };

  if (/shell|exec|command|script|stdin/.test(name)) {
    return {
      command: pickShell("command", "cmd", "script", "code", "input"),
      target: "",
    };
  }
  if (/^http|request|session/.test(name)) {
    const method = (pick("method") || "GET").toUpperCase();
    const url = pick("url", "target");
    return {
      command: url ? `${method} ${url}`.slice(0, 500) : "",
      target: url,
    };
  }
  if (/browser/.test(name)) {
    const action = pick("action");
    const url = pick("url", "target");
    const selector = pick("selector");
    const detail = [action, url || selector].filter(Boolean).join(" ").trim();
    return { command: "", target: detail.slice(0, 500) };
  }
  if (/^(read|write|edit)$/.test(name) || /file/.test(name)) {
    const path = pick("path", "file", "relative_path");
    return { command: path, target: path };
  }
  if (/skill/.test(name)) {
    const op = pick("op") || "list";
    const id = pick("id", "skill_id", "name");
    return { command: "", target: id ? `${op} ${id}` : op };
  }
  if (/todo/.test(name)) {
    const op = pick("op") || "view";
    const task = pick("task", "phase", "note");
    return { command: "", target: task ? `${op} · ${task}` : op };
  }
  if (/finding/.test(name)) {
    const action = pick("action") || "confirm";
    const title = pick("title", "vuln_type", "location", "url", "finding_id");
    return { command: "", target: title ? `${action} · ${title}` : action };
  }
  if (/hypothesis/.test(name)) {
    const op = pick("op") || "list";
    const statement = pick("statement", "id", "signal");
    return { command: "", target: statement ? `${op} · ${statement}` : op };
  }
  if (/subagent/.test(name)) {
    const op = pick("op") || "spawn";
    const goal = pick("this_turn_goal", "target", "scope", "assignment", "agent_id");
    const packages = args.packages;
    if (Array.isArray(packages) && packages.length > 1) {
      return { command: "", target: `${op} · ${packages.length} packages` };
    }
    return { command: "", target: goal ? `${op} · ${goal}` : op };
  }
  if (/^platform_/.test(name)) {
    // Prefer query filters (how agent listed/fetched) over empty target.
    const parts: string[] = [];
    const q = pick("q", "query");
    const status = pick("status");
    const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? String(args.limit) : pick("limit");
    const id = pick(
      "asset_id",
      "vulnerability_id",
      "finding_id",
      "report_id",
      "id",
      "title",
      "name",
    );
    if (q) parts.push(`q=${q}`);
    if (status) parts.push(`status=${status}`);
    if (limit) parts.push(`limit=${limit}`);
    if (id) parts.push(id);
    const target = parts.join(" · ") || ( /list_/.test(name) ? "默认列表" : "");
    return { command: "", target };
  }
  if (/fact|goal|captcha|decision/.test(name)) {
    const body = pick(
      "text",
      "content",
      "note",
      "summary",
      "goal",
      "title",
      "question",
      "reason",
      "action",
      "url",
      "path",
    );
    return { command: "", target: body };
  }

  // Generic fallback
  const command = pick("command", "cmd", "script", "code");
  const target = pick(
    "url",
    "target",
    "path",
    "file",
    "query",
    "title",
    "name",
    "id",
    "action",
    "op",
    "this_turn_goal",
  );
  return { command, target };
}
