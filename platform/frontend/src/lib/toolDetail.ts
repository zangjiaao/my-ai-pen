/**
 * User-facing detail text for ToolCallCard (title chip + item rows).
 * Prefer real tool intent (command / URL / path / op) over lifecycle chrome
 * (interrupted, shell running, 失败).
 */

const LIFECYCLE_ONLY =
  /^(interrupted|canceled|cancelled|执行中|失败|error|failed|done|ok|success|running)$/i;

/** Progressive name-known summaries: `shell running`, `browser running`. */
export function isProgressiveToolSummary(value: unknown): boolean {
  return /\s+running$/i.test(String(value ?? "").trim());
}

export function isLifecycleOnlyText(value: unknown): boolean {
  const s = String(value ?? "").trim();
  if (!s) return true;
  if (isProgressiveToolSummary(s)) return true;
  return LIFECYCLE_ONLY.test(s);
}

/** Raw JSON blobs must not appear as process-chrome detail lines. */
export function isJsonBlobText(value: unknown): boolean {
  const s = String(value ?? "").trim();
  if (!s) return false;
  if (!(s.startsWith("{") || s.startsWith("["))) return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    // Incomplete progressive JSON still looks like a blob to operators.
    return true;
  }
}

function str(value: unknown, max = 500): string {
  const s = String(value ?? "").trim();
  if (!s || isLifecycleOnlyText(s) || isJsonBlobText(s)) return "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Shell/script command text — keep multi-line scripts, not a 240/500 tease. */
const SHELL_COMMAND_DISPLAY_MAX = 16_000;

function shellCommandText(value: unknown): string {
  const s = String(value ?? "").trim();
  if (!s || isLifecycleOnlyText(s)) return "";
  // Commands may start with `{` rarely; do not scrub as JSON blob.
  return s.length > SHELL_COMMAND_DISPLAY_MAX
    ? `${s.slice(0, SHELL_COMMAND_DISPLAY_MAX - 1)}…`
    : s;
}

/** Humanize surface(op=summary|list|get|upsert) result for the row detail. */
export function formatSurfaceToolDetail(
  args: Record<string, unknown> | null | undefined,
  result: Record<string, unknown> | null | undefined,
): string {
  const op = String(args?.op || result?.op || "").trim().toLowerCase() || "summary";
  if (op === "summary" || (result && (result.total != null || result.case_tested != null))) {
    const total = result?.total;
    const tested = result?.tested;
    const touched = result?.touched;
    const booked = result?.booked;
    const parts: string[] = [];
    if (total != null && Number.isFinite(Number(total))) parts.push(`共${total}`);
    if (tested != null && Number.isFinite(Number(tested))) parts.push(`已测${tested}`);
    if (touched != null && Number.isFinite(Number(touched))) parts.push(`触及${touched}`);
    if (booked != null && Number.isFinite(Number(booked))) parts.push(`已登记${booked}`);
    return parts.length ? parts.join(" · ") : "summary";
  }
  if (op === "list") {
    const n = Array.isArray(result?.items)
      ? result!.items.length
      : Array.isArray(result?.surfaces)
        ? (result!.surfaces as unknown[]).length
        : null;
    return n != null ? `list ${n}条` : "list";
  }
  if (op === "get") {
    const loc =
      firstString(result, ["location", "path", "url"])
      || firstString(args, ["location", "path", "url", "id"]);
    return loc ? `get ${loc}` : "get";
  }
  if (op === "upsert") {
    const loc = firstString(args, ["location", "path", "url"]) || firstString(result, ["location", "path"]);
    return loc ? `upsert ${loc}` : "upsert";
  }
  return op;
}

/** If summary/result_text is JSON, try parse for surface-style formatting. */
export function tryParseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  const s = String(value ?? "").trim();
  if (!s.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* Truncated result_text (4k) is common — recover key string fields with regex. */
    return recoverPartialJsonObject(s);
  }
  return null;
}

/** Unescape a JSON string body (complete or mid-truncation). */
function unescapeJsonStringBody(body: string): string {
  try {
    return JSON.parse(`"${body}"`) as string;
  } catch {
    return body
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

/**
 * Best-effort fields from truncated JSON tool results (unterminated strings OK).
 * Complete `"key":"..."` preferred; otherwise open-ended `"key":"...` to EOF.
 */
function recoverPartialJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw.startsWith("{")) return null;
  const out: Record<string, unknown> = {};
  const pickStr = (key: string): string => {
    // Complete quoted string
    const complete = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`);
    const m = raw.match(complete);
    if (m) return unescapeJsonStringBody(m[1]);
    // Truncated mid-string (common for large stdout in ~4k result_text)
    const open = new RegExp(`"${key}"\\s*:\\s*"`);
    const om = raw.match(open);
    if (!om || om.index == null) return "";
    let i = om.index + om[0].length;
    let acc = "";
    while (i < raw.length) {
      const c = raw[i];
      if (c === "\\") {
        if (i + 1 >= raw.length) break;
        acc += c + raw[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') break;
      acc += c;
      i += 1;
    }
    return unescapeJsonStringBody(acc);
  };
  for (const key of [
    "op",
    "task",
    "phase",
    "note",
    "command",
    "cmd",
    "url",
    "method",
    "id",
    "name",
    "action",
    "title",
    "status",
    "stdout",
    "stderr",
    "output_archive",
  ]) {
    const v = pickStr(key);
    if (v) out[key] = v;
  }
  if (/"output_truncated"\s*:\s*true/.test(raw)) out.output_truncated = true;
  if (/"exitCode"\s*:\s*(-?\d+)/.test(raw)) {
    const em = raw.match(/"exitCode"\s*:\s*(-?\d+)/);
    if (em) out.exitCode = Number(em[1]);
  }
  // completed_tasks: [{ "phase": "...", "content": "..." }, ...]
  const ct = raw.match(/"completed_tasks"\s*:\s*\[/);
  if (ct && ct.index != null) {
    const slice = raw.slice(ct.index, ct.index + 800);
    const content = slice.match(/"content"\s*:\s*"((?:\\.|[^"\\])*)"/);
    const phase = slice.match(/"phase"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (content) {
      try {
        const c = JSON.parse(`"${content[1]}"`) as string;
        const p = phase ? (JSON.parse(`"${phase[1]}"`) as string) : "";
        out.completed_tasks = [{ phase: p, content: c }];
      } catch {
        /* ignore */
      }
    }
  }
  // Nested finding: { "finding": { "action", "title" } }
  if (raw.includes('"finding"')) {
    const action = raw.match(/"finding"\s*:\s*\{[^}]*"action"\s*:\s*"((?:\\.|[^"\\])*)"/);
    const title = raw.match(/"finding"\s*:\s*\{[^}]*"title"\s*:\s*"((?:\\.|[^"\\])*)"/)
      || raw.match(/"title"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (action || title) {
      out.finding = {
        action: action ? action[1] : "confirm",
        title: title ? title[1].slice(0, 200) : "",
      };
    }
  }
  return Object.keys(out).length ? out : null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function firstString(obj: Record<string, unknown> | null | undefined, keys: string[]): string {
  if (!obj) return "";
  for (const key of keys) {
    const v = str(obj[key]);
    if (v) return v;
  }
  return "";
}

/**
 * Like firstString but keeps protocol ops that str() would scrub as lifecycle
 * (todo op "done" / "start" / "ok" must remain visible as the request verb).
 */
function firstArgString(obj: Record<string, unknown> | null | undefined, keys: string[]): string {
  if (!obj) return "";
  for (const key of keys) {
    const raw = obj[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
    if (typeof raw === "boolean") return raw ? "true" : "false";
    if (typeof raw !== "string") continue;
    const s = raw.trim();
    if (!s || isJsonBlobText(s)) continue;
    // Allow short protocol ops even if they match lifecycle tokens.
    if (isLifecycleOnlyText(s) && !/^(done|start|init|view|list|load|ok|success|running|error)$/i.test(s)) {
      continue;
    }
    return s.length > 200 ? `${s.slice(0, 199)}…` : s;
  }
  return "";
}

/** Coerce primitive arg values for display (limit numbers, booleans, short strings). */
function formatArgValue(value: unknown, max = 80): string {
  if (value == null) return "";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    const s = value.trim();
    if (!s || isLifecycleOnlyText(s) || isJsonBlobText(s)) return "";
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  }
  if (Array.isArray(value)) {
    if (!value.length) return "";
    if (value.every((x) => typeof x === "string" || typeof x === "number")) {
      return value
        .slice(0, 4)
        .map((x) => String(x))
        .join(",");
    }
    return `${value.length}项`;
  }
  return "";
}

/** Keys that are noise for the process-chrome row (timeouts, large bodies). */
const ARGS_SKIP_KEYS = new Set([
  "timeout_seconds",
  "timeout",
  "timeout_ms",
  "headers",
  "body",
  "content",
  "old_string",
  "new_string",
  "proof",
  "observation",
  "description",
  "poc",
  "list",
  "packages",
  "payload",
  "outcome",
  "evidence_ids",
  "evidence_refs",
  "interactive",
  "full_page",
]);

/**
 * Compact query/filter params for list/get tools: `status=open · limit=50`.
 * Prefer showing how the agent queried — never invent fake filters.
 */
export function formatToolArgsDetail(
  args: Record<string, unknown> | null | undefined,
  options?: { preferKeys?: string[]; maxParts?: number },
): string {
  if (!args) return "";
  const maxParts = options?.maxParts ?? 5;
  const prefer = options?.preferKeys || [];
  const parts: string[] = [];
  const used = new Set<string>();

  const push = (key: string, raw: unknown) => {
    if (used.has(key) || ARGS_SKIP_KEYS.has(key)) return;
    if (key.startsWith("_")) return;
    const val = formatArgValue(raw);
    if (!val) return;
    used.add(key);
    // Short Chinese-friendly labels for common filters.
    const label =
      key === "q"
        ? "关键词"
        : key === "limit"
          ? "limit"
          : key === "status"
            ? "status"
            : key === "asset_id"
              ? "asset"
              : key === "vulnerability_id"
                ? "vuln"
                : key === "finding_id"
                  ? "finding"
                  : key === "report_id"
                    ? "report"
                    : key;
    parts.push(`${label}=${val}`);
  };

  for (const key of prefer) {
    if (key in args) push(key, args[key]);
  }
  for (const [key, raw] of Object.entries(args)) {
    if (parts.length >= maxParts) break;
    push(key, raw);
  }
  return parts.join(" · ");
}

function joinParts(parts: Array<string | undefined>, sep = " "): string {
  return parts.map((p) => String(p || "").trim()).filter(Boolean).join(sep);
}

export type ToolDetailInput = {
  toolName?: string;
  /** Raw tool id preferred over display label when available. */
  toolId?: string;
  command?: string;
  target?: string;
  summary?: string;
  args?: unknown;
  result?: unknown;
  result_text?: unknown;
};

export type ToolDetailProjection = {
  /** Primary user-visible detail next to the tool title (may be empty). */
  text: string;
  /** Prefer monospace for commands, paths, URLs. */
  mono: boolean;
};

/**
 * Request-side echo only (what the agent asked for), recovered from result when
 * wire args were never persisted. **Never** exit codes, stdout, list counts, etc.
 * Those belong in the expandable result drawer.
 */
export function formatRequestFromResult(
  toolId: string,
  result: Record<string, unknown> | null | undefined,
): string {
  if (!result) return "";
  const name = String(toolId || "").toLowerCase();

  // Shell / script — only the command string (full script, not 240-char tease)
  const cmd = shellCommandText(result.command || result.cmd);
  if (cmd && (/shell|exec|script|command/.test(name) || result.exitCode != null || result.stdout != null)) {
    return cmd;
  }
  if (cmd && !result.vulnerabilities && !result.assets) return cmd;

  // HTTP — request line only (no status code)
  if (/^http|request|session/.test(name) || result.url) {
    const method = String(result.method || "GET").toUpperCase();
    const url = String(result.url || result.requested_url || "").trim();
    if (url) return `${method} ${url}`.slice(0, 240);
  }

  // Skill / todo / hypothesis — op (+ task/id) is the request; nested summary is result.
  if (
    /skill|todo|hypothesis|任务清单/.test(name)
    || ["load", "list", "init", "start", "done", "view", "upsert", "append", "rm", "drop"].includes(String(result.op || ""))
  ) {
    const op = String(result.op || "").trim();
    // Which item was start/done — from request echo or completed_tasks transition.
    let task = String(result.task || result.id || result.name || result.skill_id || "").trim();
    if (!task && Array.isArray(result.completed_tasks) && result.completed_tasks[0]) {
      const ct = result.completed_tasks[0];
      if (ct && typeof ct === "object") {
        task = String((ct as { content?: string }).content || "").trim();
      }
    }
    if (op === "list" || op === "view" || op === "summary") return op;
    if (op && task) return `${op} · ${task}`.slice(0, 200);
    if (op) return op;
  }

  // Finding — action + title are the request
  if (/^finding$|登记发现/.test(name) || result.finding) {
    const f =
      result.finding && typeof result.finding === "object" && !Array.isArray(result.finding)
        ? (result.finding as Record<string, unknown>)
        : result;
    const action = String(f.action || "").trim() || "confirm";
    const title = String(f.title || f.location || f.url || "").trim();
    if (title) return `${action} · ${title}`.slice(0, 200);
    return action;
  }

  // platform_create_report — request is "create" (body is result)
  if (/platform_create_report|生成交付报告/.test(name)) {
    const title = String(result.report && typeof result.report === "object"
      ? (result.report as Record<string, unknown>).title || ""
      : "").trim();
    return title ? `create · ${title}`.slice(0, 160) : "create";
  }

  // Browser — action + url
  if (/browser/.test(name)) {
    const action = String(result.action || "").trim();
    const url = String(result.url || "").trim();
    if (action || url) return [action, url].filter(Boolean).join(" ").slice(0, 200);
  }

  // FS path echo
  const path = String(result.path || result.relative_path || "").trim();
  if (path && /read|write|edit/.test(name)) return path.slice(0, 200);

  // Platform get: id was the request; list with no args → 默认列表 (not count)
  if (/platform_get_/.test(name)) {
    const id = String(result.id || result.vulnerability_id || result.asset_id || "").trim();
    if (id) return id;
  }
  if (/platform_list_/.test(name)) {
    return "默认列表";
  }

  // Surface request is usually op only
  if (/surface/.test(name)) {
    const op = String(result.op || "summary").trim();
    return op || "summary";
  }

  return "";
}

/** @deprecated use formatRequestFromResult — kept for import stability in tests */
export function formatToolResultDetail(
  toolId: string,
  result: Record<string, unknown> | null | undefined,
): string {
  return formatRequestFromResult(toolId, result);
}

/**
 * Best-effort user-facing detail for any product tool.
 * Never returns lifecycle-only tokens; empty when nothing useful is known yet.
 */
export function toolUserFacingDetail(input: ToolDetailInput): ToolDetailProjection {
  const toolId = String(input.toolId || input.toolName || "").trim().toLowerCase();
  const displayName = String(input.toolName || "").trim().toLowerCase();
  const name = toolId || displayName;
  const args = asRecord(input.args);
  // Historical frames store full jsonResult only in summary/result_text (args empty).
  const result =
    asRecord(input.result)
    || tryParseJsonRecord(input.summary)
    || tryParseJsonRecord(input.result_text);
  // Prefer full shell command (args / top-level command), not str() 500-char clip.
  const command =
    shellCommandText(input.command)
    || shellCommandText(args && (args.command ?? args.cmd ?? args.script ?? args.code ?? args.input))
    || shellCommandText(result?.command ?? result?.cmd);
  const target =
    str(input.target)
    || firstString(args, ["url", "target", "path", "file", "location", "relative_path"])
    || firstString(result, ["url", "target", "path", "relative_path", "location"]);

  // --- shell / script / stdin (command only — never stdout/exit) ---
  // Do NOT match bare `command` field: other tools may echo a polluted content.command.
  if (/shell|exec|docker|process|stdin|执行命令|命令输入|运行脚本|\bscript\b/.test(name)
    || toolId === "shell"
    || toolId === "exec") {
    if (command) return { text: command, mono: true };
    const req = formatRequestFromResult(name || "shell", result);
    if (req) return { text: req, mono: true };
  }

  // --- request_user_decision (before generic command/url last-chance) ---
  if (/request_user_decision|用户授权/.test(name) || toolId === "request_user_decision") {
    const kind = firstArgString(args, ["kind"]) || firstArgString(result, ["kind"]) || "";
    const tgt =
      firstArgString(args, ["target"])
      || firstArgString(result, ["target"])
      || "";
    const q = firstArgString(args, ["question", "title", "reason", "prompt"]);
    if (kind && tgt) return { text: `${kind} · ${tgt}`.slice(0, 200), mono: false };
    if (kind && q) return { text: `${kind} · ${q}`.slice(0, 200), mono: false };
    if (kind) return { text: kind, mono: false };
    if (q) return { text: q.slice(0, 200), mono: false };
  }

  // --- HTTP (request line only — no response status) ---
  if (/^http|request|session|http 探测|http 请求|会话化/.test(name)) {
    const method = (firstString(args, ["method"]) || firstString(result, ["method"]) || "GET").toUpperCase();
    const url = target || firstString(args, ["url"]) || firstString(result, ["url"]);
    if (url) return { text: `${method} ${url}`.slice(0, 240), mono: true };
    const req = formatRequestFromResult(name || "http", result);
    if (req) return { text: req, mono: true };
    if (method && method !== "GET") return { text: method, mono: false };
  }

  // --- browser ---
  if (/browser|浏览器/.test(name)) {
    const action = firstString(args, ["action"]) || firstString(result, ["action"]);
    const url = target || firstString(args, ["url"]) || firstString(result, ["url"]);
    const selector = firstString(args, ["selector"]);
    const text = joinParts([action, url || selector]);
    if (text) return { text, mono: Boolean(url || selector) };
  }

  // --- filesystem ---
  if (/^read|write|edit|读取文件|写入文件|编辑文件/.test(name) || /^(read|write|edit)\b/.test(name)) {
    const path =
      target
      || firstString(args, ["path", "file", "relative_path"])
      || firstString(result, ["path", "relative_path"]);
    if (path) return { text: path, mono: true };
  }

  // --- skill (op + skill id = the request) ---
  if (/skill|加载技能/.test(name)) {
    const op = firstArgString(args, ["op"]) || firstArgString(result, ["op"]) || "list";
    const id =
      firstArgString(args, ["id", "skill_id", "name"])
      || firstArgString(result, ["id", "name"]);
    if (id || firstArgString(args, ["op"])) return { text: id ? `${op} ${id}` : op, mono: Boolean(id) };
    const req = formatRequestFromResult("skill", result);
    if (req) return { text: req, mono: true };
  }

  // --- todo (op + which task; never dump remaining-items body as the request line) ---
  if (/todo|任务清单/.test(name)) {
    const op = firstArgString(args, ["op"]) || firstArgString(result, ["op"]) || "";
    let task = firstArgString(args, ["task"]);
    if (!task && result) {
      task = firstArgString(result, ["task"]);
      if (!task && Array.isArray(result.completed_tasks) && result.completed_tasks[0]) {
        const ct = result.completed_tasks[0];
        if (ct && typeof ct === "object") {
          task = String((ct as { content?: string }).content || "").trim();
        }
      }
    }
    // init with list → show item count as request shape
    if (op === "init" && args && Array.isArray(args.list)) {
      const n = (args.list as unknown[]).reduce((acc: number, phaseRow) => {
        if (!phaseRow || typeof phaseRow !== "object") return acc;
        const items = (phaseRow as { items?: unknown }).items;
        return acc + (Array.isArray(items) ? items.length : 0);
      }, 0);
      return { text: n > 0 ? `init · ${n} 项` : "init", mono: false };
    }
    if (op && task) return { text: `${op} · ${task}`.slice(0, 200), mono: false };
    if (task) return { text: task.slice(0, 200), mono: false };
    if (op) return { text: op, mono: false };
    const req = formatRequestFromResult("todo", result);
    if (req) return { text: req, mono: false };
  }

  // --- finding tool (id=finding only; do not match 「查询漏洞台账」 labels) ---
  if (/^finding$|登记发现/.test(name) || toolId === "finding") {
    const action = firstArgString(args, ["action"]) || firstArgString(result, ["action"]);
    const nested =
      result?.finding && typeof result.finding === "object" && !Array.isArray(result.finding)
        ? (result.finding as Record<string, unknown>)
        : null;
    const title =
      firstArgString(args, ["title", "vuln_type", "finding_kind", "location", "url", "finding_id"])
      || firstArgString(nested, ["title", "location", "url"])
      || firstArgString(result, ["title", "location", "url"]);
    const act = action || firstArgString(nested, ["action"]) || "confirm";
    const text = title ? `${act} · ${title}` : act;
    return { text, mono: false };
  }

  // --- hypothesis ---
  if (/hypothesis/.test(name)) {
    const op = firstString(args, ["op"]) || "list";
    const statement = firstString(args, ["statement", "id", "signal", "status"]);
    const text = statement ? `${op} · ${statement}` : op;
    return { text, mono: false };
  }

  // --- fact / goal ---
  if (/^fact|记录过程|goal|更新目标/.test(name)) {
    const body =
      firstString(args, ["text", "content", "note", "summary", "goal", "status", "title"])
      || str(input.summary);
    if (body) return { text: body, mono: false };
  }

  // --- subagent ---
  if (/subagent|子代理/.test(name)) {
    const op = firstString(args, ["op"]) || "spawn";
    const goal =
      firstString(args, ["this_turn_goal", "target", "scope", "assignment", "agent_id", "resume_agent_id"])
      || firstString(result, ["agent_id", "target"]);
    const packages = args?.packages;
    if (Array.isArray(packages) && packages.length > 1) {
      return { text: `${op} · ${packages.length} packages`, mono: false };
    }
    const text = goal ? `${op} · ${goal}` : op;
    return { text, mono: false };
  }

  // --- captcha ---
  if (/captcha|验证码/.test(name)) {
    const body = firstString(args, ["action", "url", "path", "text"]) || target;
    if (body) return { text: body, mono: Boolean(target) };
  }

  // --- surface (request: op / location — counts are result drawer only) ---
  if (/surface|攻击面/.test(name)) {
    const op = firstString(args, ["op"]) || firstString(result, ["op"]) || "summary";
    const loc = firstString(args, ["location", "path", "url", "id"]);
    if (loc) return { text: `${op} ${loc}`, mono: true };
    if (op) return { text: op, mono: false };
  }

  // --- platform_* ledger query / mutate ---
  if (/^platform_|平台：/.test(name) || name.includes("platform_")) {
    // Prefer filter params (how agent queried), not a bare id that looks opaque.
    const filters = formatToolArgsDetail(args, {
      preferKeys: [
        "q",
        "status",
        "limit",
        "asset_id",
        "vulnerability_id",
        "finding_id",
        "report_id",
        "conversation_id",
        "title",
        "name",
        "query",
        "id",
      ],
    });
    if (filters) return { text: filters, mono: true };
    // list_* with empty args → default list request (not result counts).
    if (/list_/.test(name) || /查询|列表|list/.test(displayName)) {
      return { text: "默认列表", mono: false };
    }
    const req = formatRequestFromResult(name, result);
    if (req) return { text: req, mono: true };
    if (/get_|读取|详情/.test(name) || /get_|读取|详情/.test(displayName)) {
      const id =
        firstString(args, ["asset_id", "vulnerability_id", "finding_id", "report_id", "id"])
        || firstString(result, ["id", "title", "name"]);
      if (id) return { text: id, mono: true };
    }
    const id =
      firstString(args, [
        "asset_id",
        "vulnerability_id",
        "finding_id",
        "report_id",
        "conversation_id",
        "id",
        "title",
        "name",
        "query",
        "status",
      ])
      || firstString(result, ["id", "title", "name"]);
    if (id) return { text: id, mono: /[_-]/.test(id) || id.length > 20 };
  }

  // Last-chance: request-side echo only (command / url / op), never tool output body.
  {
    const req = formatRequestFromResult(name, result);
    if (req) {
      return {
        text: req,
        mono: /https?:\/\//i.test(req) || req.includes("/") || req.includes("="),
      };
    }
  }

  // Generic: full arg snapshot first (query tools), then single-key shortcuts.
  const argsDetail = formatToolArgsDetail(args);
  if (argsDetail) {
    const mono = Boolean(
      command
      || /[=/]/.test(argsDetail)
      || /^https?:\/\//i.test(argsDetail),
    );
    return { text: argsDetail, mono };
  }
  const generic =
    command
    || target
    || firstString(args, [
      "query",
      "title",
      "name",
      "path",
      "file",
      "url",
      "target",
      "action",
      "op",
      "id",
      "statement",
      "task",
      "this_turn_goal",
      "message",
      "text",
      "note",
    ]);
  if (generic) {
    const mono = Boolean(
      command
      || /^https?:\/\//i.test(generic)
      || generic.includes("/")
      || generic.includes("\\"),
    );
    return { text: generic, mono };
  }

  // Structured JSON result with op=summary (even if tool id unknown).
  const parsedBlob = tryParseJsonRecord(input.summary) || tryParseJsonRecord(input.result_text) || result;
  if (parsedBlob && (parsedBlob.op === "summary" || parsedBlob.total != null || parsedBlob.case_tested != null)) {
    const text = formatSurfaceToolDetail(args, parsedBlob);
    if (text) return { text, mono: false };
  }

  // Non-lifecycle summary / short result_text (never raw JSON).
  const summary = str(input.summary);
  if (summary) {
    return {
      text: summary,
      mono: /^https?:\/\//i.test(summary) || summary.includes("/"),
    };
  }
  const resultText = str(input.result_text, 160);
  if (resultText) {
    return { text: resultText, mono: false };
  }
  // result object fallbacks — skip non-string / lifecycle fields
  const fromResult = firstString(result, [
    "title",
    "message",
    "path",
    "relative_path",
    "url",
    "id",
    "op",
  ]);
  if (fromResult) {
    return {
      text: fromResult,
      mono: fromResult.includes("/") || /^https?:\/\//i.test(fromResult),
    };
  }

  return { text: "", mono: false };
}

/** Normalize a raw tool id or Chinese display label into a chrome family. */
export function toolFamilyFromName(name: string): string {
  const lower = String(name || "").trim().toLowerCase();
  if (!lower) return "";
  if (/^platform_|平台：|查询资产|读取资产|查询漏洞|读取漏洞|更新漏洞|补充资产|会话快照|查询报告|生成交付/.test(lower)) {
    return "platform";
  }
  if (/shell|exec_command|exec command|write_stdin|script|执行命令|运行脚本|命令输入/.test(lower)) return "shell";
  if (/browser|浏览器/.test(lower)) return "browser";
  if (/^http|http_request|http 探测|http 请求|会话化 http/.test(lower)) return "http";
  if (/^(read|write|edit)$|读取文件|写入文件|编辑文件/.test(lower)) return "file";
  if (/finding|登记发现/.test(lower)) return "finding";
  if (/todo|任务清单/.test(lower)) return "todo";
  if (/skill|加载技能/.test(lower)) return "skill";
  if (/subagent|子代理/.test(lower)) return "subagent";
  if (/surface|攻击面/.test(lower)) return "surface";
  if (/fact|记录过程/.test(lower)) return "fact";
  if (/^goal$|更新目标/.test(lower)) return "goal";
  if (/captcha|验证码/.test(lower)) return "captcha";
  if (/request_user_decision|用户授权/.test(lower)) return "decision";
  if (/hypothesis/.test(lower)) return "hypothesis";
  return lower;
}

/** Normalize tool family key for adjacent card grouping + header icon. */
export function toolFamilyKey(content: Record<string, unknown> | null | undefined): string {
  if (!content || typeof content !== "object") return "";
  const raw =
    String(content.tool_name || content.latest_tool_name || "").trim()
    || (Array.isArray(content.tool_items)
      && content.tool_items[0]
      && typeof content.tool_items[0] === "object"
      && !Array.isArray(content.tool_items[0])
      ? String((content.tool_items[0] as Record<string, unknown>).tool_name || "").trim()
      : "");
  return toolFamilyFromName(raw);
}
