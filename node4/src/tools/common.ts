import type { PlatformMessage, ToolRuntime } from "../types.js";

export function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

export function jsonResult(value: unknown, details: Record<string, unknown> = {}) {
  return textResult(JSON.stringify(value, null, 2), details);
}

/**
 * How the agent obtained a result (for Case "How captured" causality).
 * Kept short — full dumps stay in excerpt/observation.
 */
export type ActCapture = {
  via: string;
  command?: string;
  method?: string;
  url?: string;
  status?: string | number;
  request_headers?: unknown;
  request_body?: string;
  script_path?: string;
  script_preview?: string;
  path?: string;
  actor?: string;
};

/** In-memory act observations for grounding finding(proof) — not Case product evidence. */
export type RecentObservation = {
  sourceTool: string;
  summary: string;
  excerpt: string;
  path_or_url?: string;
  capture?: ActCapture;
  at: number;
};

/** Keep enough act history so book-time proof can still find the shell/script that produced it. */
export const RECENT_OBS_CAP = 80;
const MIN_GROUND_NEEDLE = 24;

export type EmitEvidenceOptions = {
  /** Override evidence type stored on Case (default from kind). */
  evidenceType?: string;
  /** Force role; otherwise classified from content. */
  role?: "proof" | "trace";
};

/** Pull request/command/script fields from raw act tool data for later book-time evidence. */
export function extractActCapture(sourceTool: string, data: unknown): ActCapture {
  const tool = String(sourceTool || "tool").toLowerCase();
  const rec =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  const via = tool || "tool";
  // Keep longer commands so multi-step XSS/shell probes remain readable in evidence.
  const command = clip(rec.command || "", 8000);
  const method = rec.method != null ? String(rec.method).toUpperCase() : "";
  const url = clip(rec.url || rec.path_or_url || "", 800);
  const status = rec.status ?? rec.status_code ?? rec.statusCode ?? rec.exitCode ?? rec.exit_code;
  const request_body = clip(rec.request_body || rec.requestBody || "", 2000);
  const path = clip(rec.path || rec.file || "", 500);
  const preview = clip(rec.preview || rec.content || "", 2000);
  const actor = rec.actor != null ? String(rec.actor) : undefined;

  if (tool === "http" || tool === "session" || (method && url)) {
    return {
      via: tool === "session" ? "session" : "http",
      method: method || undefined,
      url: url || undefined,
      status: status != null && status !== "" ? status : undefined,
      request_headers: rec.request_headers || rec.requestHeaders || undefined,
      request_body: request_body || undefined,
      actor,
      command: command || undefined,
    };
  }
  if (tool === "script" || (tool === "shell" && path && /\.(py|js|mjs)$/i.test(path))) {
    return {
      via: tool === "script" ? "script" : "shell",
      command: command || (path ? `run ${path}` : undefined),
      script_path: path || undefined,
      script_preview: preview || undefined,
      status: status != null && status !== "" ? status : undefined,
    };
  }
  if (tool === "write" || tool === "file") {
    return {
      via: "write",
      path: path || undefined,
      script_path: path || undefined,
      script_preview: preview || undefined,
    };
  }
  if (tool === "browser") {
    return {
      via: "browser",
      url: url || clip(rec.open_url || "", 800) || undefined,
      command: command || undefined,
      path: path || undefined,
    };
  }
  // shell default
  return {
    via: tool || "shell",
    command: command || undefined,
    path: path || undefined,
    status: status != null && status !== "" ? status : undefined,
  };
}

/**
 * Record act tool output for this task only (memory ring).
 * Does **not** create Case evidence — product evidence is created at finding(confirm).
 */
export function recordActObservation(
  runtime: ToolRuntime,
  sourceTool: string,
  summary: string,
  data: unknown,
  options: EmitEvidenceOptions = {},
): void {
  const properties = evidencePropertiesForPlatform(sourceTool, data, options.role);
  const excerpt = String(
    properties.excerpt ||
      properties.body_preview ||
      properties.stdout ||
      properties.preview ||
      properties.text ||
      summary ||
      "",
  ).slice(0, 6000);
  const path_or_url = String(properties.path_or_url || properties.path || properties.url || "").trim();
  const capture = extractActCapture(sourceTool, data);
  // Shell stdout lives on data; ensure capture.command is set from data even when summary-only.
  if (!capture.command && data && typeof data === "object") {
    const cmd = String((data as Record<string, unknown>).command || "").trim();
    if (cmd) capture.command = cmd.slice(0, 2500);
  }
  const list = (runtime.lifecycle.recentObservations ||= []);
  list.push({
    sourceTool: String(sourceTool || "tool"),
    summary: String(summary || "").slice(0, 300),
    excerpt,
    path_or_url: path_or_url || undefined,
    capture,
    at: Date.now(),
  });
  while (list.length > RECENT_OBS_CAP) list.shift();
}

/**
 * Create Case evidence (local + platform). Used when booking a finding — not on every act.
 */
export async function emitCaseEvidence(
  runtime: ToolRuntime,
  sourceTool: string,
  summary: string,
  data: unknown,
  options: EmitEvidenceOptions = {},
): Promise<string> {
  const evidence = await runtime.evidence.create({ type: "tool_output", sourceTool, summary, data });
  const properties = evidencePropertiesForPlatform(sourceTool, data, options.role);
  const kind = String(properties.kind || "tool");
  const evidenceType =
    options.evidenceType ||
    (kind === "http"
      ? "http_exchange"
      : kind === "file" || kind === "source_excerpt"
        ? "file_artifact"
        : "tool_output");
  await runtime.platform.send({
    type: "evidence_created",
    conversation_id: runtime.task.conversationId,
    task_id: runtime.task.taskId,
    evidence_id: evidence.id,
    source_tool: sourceTool,
    summary: String(summary || "").slice(0, 500),
    evidence_type: evidenceType,
    properties,
  } as PlatformMessage);
  return evidence.id;
}

/**
 * Act-time helper: only records observation for later proof grounding.
 * Does not emit Case evidence or return an id (agents book with `proof`, not evidence_ids).
 */
export async function emitEvidence(
  runtime: ToolRuntime,
  sourceTool: string,
  summary: string,
  data: unknown,
  options: EmitEvidenceOptions = {},
): Promise<string> {
  recordActObservation(runtime, sourceTool, summary, data, options);
  return "";
}

function normalizeForMatch(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function buildProofNeedles(proofNorm: string): string[] {
  const needles: string[] = [];
  for (const len of [96, 64, 48, 32, 24]) {
    if (proofNorm.length >= len) needles.push(proofNorm.slice(0, len));
  }
  if (proofNorm.length > 80) {
    for (let i = 0; i + 32 <= Math.min(proofNorm.length, 400); i += 40) {
      needles.push(proofNorm.slice(i, i + 32));
    }
  }
  return [...new Set(needles.filter((n) => n.length >= MIN_GROUND_NEEDLE))];
}

function observationMatchesProof(r: RecentObservation, needles: string[]): boolean {
  const hay = normalizeForMatch(`${r.excerpt}\n${r.summary}\n${r.path_or_url || ""}`);
  if (!hay) return false;
  return needles.some((n) => hay.includes(n));
}

/** Prefer matches that still carry the command/script that produced the result. */
function captureRichness(r: RecentObservation): number {
  const c = r.capture;
  if (!c) return 0;
  let s = 0;
  if (c.command && c.command.length >= 8) s += 4;
  if (c.script_preview && c.script_preview.length >= 20) s += 3;
  if (c.script_path) s += 2;
  if (c.method && c.url) s += 4;
  if (c.request_body) s += 1;
  return s;
}

/**
 * If shell ran `python scripts/foo.py`, attach script body from a prior write observation.
 */
export function enrichMatchWithScriptBody(
  match: RecentObservation,
  recent: RecentObservation[] | undefined,
): RecentObservation {
  const list = recent || [];
  const cap: ActCapture = { ...(match.capture || { via: match.sourceTool || "shell" }) };
  const cmd = String(cap.command || "");

  // python/node script path in command
  const pathHit =
    cmd.match(/(?:python3?|node)\s+([^\s;|&'"]+\.(?:py|js|mjs))/i) ||
    cmd.match(/((?:scripts|notes)\/[^\s;|&'"]+\.(?:py|js|mjs))/i);
  const scriptPath = (pathHit?.[1] || cap.script_path || "").replace(/^\.\//, "");

  if (scriptPath && !cap.script_preview) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const r = list[i]!;
      // Only pull body from write/script material rows — never from the run's stdout excerpt.
      if (!["write", "file", "script"].includes(String(r.sourceTool || "").toLowerCase()) && r.capture?.via !== "write") {
        continue;
      }
      const rp = String(r.capture?.script_path || r.capture?.path || r.path_or_url || "")
        .replace(/\\/g, "/")
        .replace(/^\.\//, "");
      if (!rp || /^https?:\/\//i.test(rp)) continue;
      const base = rp.split("/").filter(Boolean).pop() || "";
      const wantBase = scriptPath.split("/").filter(Boolean).pop() || "";
      const pathOk =
        rp === scriptPath ||
        rp.endsWith("/" + scriptPath) ||
        rp.endsWith(scriptPath) ||
        (wantBase.length >= 4 && base === wantBase);
      if (!pathOk) continue;
      // Prefer explicit write preview; do not fall back to unrelated excerpts.
      const preview = String(r.capture?.script_preview || "").trim() || String(r.excerpt || "").trim();
      if (preview.length >= 20 && !preview.startsWith("Name:") && !/^uid=/i.test(preview)) {
        cap.script_path = scriptPath;
        cap.script_preview = preview.slice(0, 4000);
        break;
      }
    }
  }

  // Long inline shell/python is itself the "script content" (agent paste, not a file).
  if (cmd.length >= 120 && !cap.script_preview) {
    cap.script_preview = cmd.slice(0, 4000);
    if (!cap.script_path) cap.script_path = "inline-shell-script";
  }

  return { ...match, capture: cap };
}

/**
 * If the text match has no command, borrow the nearest richer shell/http observation
 * that still mentions part of the proof (same probe burst).
 */
function preferRicherCapture(
  match: RecentObservation,
  recent: RecentObservation[],
  needles: string[],
): RecentObservation {
  if (captureRichness(match) >= 4) return match;
  let best = match;
  let bestScore = captureRichness(match);
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const r = recent[i]!;
    if (!observationMatchesProof(r, needles) && !normalizeForMatch(r.excerpt).includes(needles[0] || "___")) {
      // Allow nearby shell with command if excerpt shares a short token from proof
      const token = needles.find((n) => n.length >= 24);
      if (!token || !normalizeForMatch(r.excerpt + r.summary).includes(token.slice(0, 24))) continue;
    }
    const score = captureRichness(r);
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  // Merge: keep match excerpt identity but prefer richer capture (command/script).
  if (best !== match && best.capture) {
    return {
      ...match,
      capture: {
        ...(match.capture || { via: match.sourceTool || "shell" }),
        ...best.capture,
        command: best.capture.command || match.capture?.command,
        script_preview: best.capture.script_preview || match.capture?.script_preview,
        script_path: best.capture.script_path || match.capture?.script_path,
      },
    };
  }
  return match;
}

/**
 * Ensure finding proof is grounded in recent tool output (anti-hallucination).
 * Returns the matching act observation so book-time evidence can show *how* it was obtained
 * (shell command / script content / HTTP request).
 */
export function proofGroundedInRecentWork(
  proof: string,
  recent: RecentObservation[] | undefined,
): { ok: boolean; reason?: string; match?: RecentObservation } {
  const p = normalizeForMatch(proof);
  if (p.length < MIN_GROUND_NEEDLE) {
    return {
      ok: false,
      reason: `proof too short (≥${MIN_GROUND_NEEDLE} chars) — paste the proving observation from your tool output`,
    };
  }
  const list = recent || [];
  if (!list.length) {
    return {
      ok: false,
      reason: "no recent tool output — probe the target first, then book with proof quoted from that output",
    };
  }
  const needles = buildProofNeedles(p);
  const matches: RecentObservation[] = [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const r = list[i]!;
    if (observationMatchesProof(r, needles)) matches.push(r);
  }
  if (!matches.length) {
    return {
      ok: false,
      reason:
        "proof not found in recent tool outputs — re-run one short act (shell/session/http) that shows the effect, then finding(confirm) with proof= an exact substring from that output (response body / stdout / reflection), not a paraphrased guess",
    };
  }

  // Prefer the match that still has the command/script (not a thin later echo).
  matches.sort((a, b) => {
    const dr = captureRichness(b) - captureRichness(a);
    if (dr !== 0) return dr;
    return b.at - a.at;
  });
  let match = matches[0]!;
  match = preferRicherCapture(match, list, needles);
  match = enrichMatchWithScriptBody(match, list);
  return { ok: true, match };
}

/** Build Case evidence payload: proving observation + how it was captured. */
export function bookTimeEvidenceData(input: {
  title: string;
  location: string;
  proofText: string;
  match?: RecentObservation;
  recent?: RecentObservation[];
}): Record<string, unknown> {
  const proofText = input.proofText.slice(0, 4000);
  let match = input.match;
  if (match && input.recent) {
    match = enrichMatchWithScriptBody(match, input.recent);
  }
  const cap = match?.capture;
  const via = cap?.via || match?.sourceTool || "probe";
  // Display location is the finding location; capture URL is separate when present.
  const captureUrl = cap?.url || undefined;

  const data: Record<string, unknown> = {
    kind: "proof",
    observation: proofText,
    proof: proofText,
    path_or_url: input.location,
    location: input.location,
    title: input.title,
    stdout: proofText,
    body_preview: proofText,
    capture_via: via,
    how_captured: buildHowCapturedLabel(cap, match),
  };

  // Always prefer storing the actual probe action for UI "What the agent did".
  if (cap?.command) data.command = String(cap.command).slice(0, 8000);
  if (cap?.method) data.method = cap.method;
  if (captureUrl) data.url = captureUrl;
  if (cap?.status != null && cap.status !== "") data.status = cap.status;
  if (cap?.request_body) data.request_body = cap.request_body;
  if (cap?.request_headers) data.request_headers = cap.request_headers;
  if (cap?.script_path) {
    data.script_path = cap.script_path;
    // Do not put vuln URL in `path` — only real script/file paths.
    if (!/^https?:\/\//i.test(cap.script_path) && !/\/vulnerabilities\//i.test(cap.script_path)) {
      data.path = cap.script_path;
    }
  }
  if (cap?.script_preview) data.script_preview = String(cap.script_preview).slice(0, 4000);
  if (cap?.path && !data.path && !/^https?:\/\//i.test(cap.path)) data.path = cap.path;
  if (cap?.actor) data.actor = cap.actor;
  if (match?.sourceTool) data.source_tool_act = match.sourceTool;
  if (match?.summary) data.act_summary = match.summary.slice(0, 300);

  return data;
}

function buildHowCapturedLabel(cap?: ActCapture, match?: RecentObservation): string {
  if (!cap && !match) return "quoted from recent probe output";
  const via = cap?.via || match?.sourceTool || "probe";
  if (cap?.script_path && cap.script_path !== "inline-shell-script") {
    return `script: ${cap.script_path}`;
  }
  if (cap?.method && cap?.url) {
    const st = cap.status != null && cap.status !== "" ? ` → ${cap.status}` : "";
    return `${cap.method} ${cap.url}${st}`;
  }
  if (cap?.command) {
    const one = cap.command.replace(/\s+/g, " ").trim().slice(0, 160);
    return `shell: ${one}`;
  }
  if (cap?.script_path) return `script: ${cap.script_path}`;
  return `via ${via}`;
}

/** Compact, UI-friendly payload for platform evidence rows (no multi-MB dumps). */
export function evidencePropertiesForPlatform(
  sourceTool: string,
  data: unknown,
  roleOverride?: "proof" | "trace",
): Record<string, unknown> {
  const tool = String(sourceTool || "tool").toLowerCase();
  const rec =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { value: data };

  let base: Record<string, unknown>;

  if (tool === "finding" || rec.kind === "proof") {
    const observation = clip(rec.observation || rec.proof || rec.stdout || rec.body_preview || "", 4000);
    const path = clip(rec.path_or_url || rec.location || rec.url || rec.path || "", 800);
    base = {
      kind: "proof",
      path_or_url: path,
      location: clip(rec.location || path, 800),
      observation,
      excerpt: observation,
      // Result first for cards; full fields for How-captured UI.
      stdout: observation,
      body_preview: observation,
      title: rec.title != null ? clip(rec.title, 200) : undefined,
      capture_via: rec.capture_via != null ? String(rec.capture_via) : undefined,
      how_captured: rec.how_captured != null ? clip(rec.how_captured, 400) : undefined,
      command: rec.command != null ? clip(rec.command, 2500) : undefined,
      method: rec.method,
      url: rec.url != null ? clip(rec.url, 800) : undefined,
      status: rec.status,
      request_headers: rec.request_headers,
      request_body: rec.request_body != null ? clip(rec.request_body, 2000) : undefined,
      script_path: rec.script_path != null ? clip(rec.script_path, 500) : undefined,
      script_preview: rec.script_preview != null ? clip(rec.script_preview, 2000) : undefined,
      path: rec.path != null ? clip(rec.path, 500) : rec.script_path != null ? clip(rec.script_path, 500) : undefined,
      actor: rec.actor,
      source_tool_act: rec.source_tool_act,
      act_summary: rec.act_summary != null ? clip(rec.act_summary, 300) : undefined,
    };
  } else if (tool === "write" || tool === "file" || rec.kind === "file" || rec.kind === "source_excerpt") {
    const path = clip(rec.path || rec.file || "", 500);
    const preview = clip(rec.preview || rec.content || rec.text || "", 3000);
    base = {
      kind: rec.kind === "source_excerpt" ? "source_excerpt" : "file",
      path,
      path_or_url: path,
      hash: rec.hash || undefined,
      bytes: rec.bytes,
      preview,
      excerpt: preview,
    };
  } else if (
    tool === "http" ||
    // Generic payloads only — do not steal session/browser/shell shapes.
    (tool === "tool" && rec.method != null && rec.url != null) ||
    (tool === "tool" && rec.url != null && rec.status != null)
  ) {
    const body = clip(rec.body_preview || rec.response_body || rec.responseBody || rec.body, 4000);
    const url = clip(rec.url, 800);
    const method = rec.method != null ? String(rec.method) : "";
    const status = rec.status ?? rec.status_code ?? rec.statusCode;
    const statusLine = [method, url, status != null && status !== "" ? `→ ${status}` : ""]
      .filter(Boolean)
      .join(" ");
    base = {
      kind: "http",
      method: rec.method,
      url,
      path_or_url: url,
      status,
      headers: clipJson(rec.headers, 2000),
      request_headers: clipJson(rec.request_headers || rec.requestHeaders, 1500),
      request_body: clip(rec.request_body || rec.requestBody, 2000),
      response_headers: clipJson(rec.response_headers || rec.responseHeaders || rec.headers, 2000),
      response_body: body,
      body_preview: body,
      // Prefer body; fall back to status line so collab never sees a silent card.
      excerpt: body || statusLine,
    };
  } else if (tool === "shell" || tool === "script") {
    const stdoutRaw = String(rec.stdout ?? "");
    const stdout = clip(stdoutRaw, 6000);
    const stderr = clip(rec.stderr, 2000);
    const command = clip(rec.command || rec.file, 800);
    const filePath = clip(rec.file, 500);
    // Prefer target material paths from stdout/command; never treat agent scripts/*.py as "source".
    const pathHint =
      pathHintFromStdout(stdoutRaw) ||
      pathHintFromCommand(String(rec.command || "")) ||
      (filePath && looksLikeMaterialPath(filePath) ? filePath : "");
    const materialPath = Boolean(pathHint && looksLikeMaterialPath(pathHint));
    // What the user/next expert needs: the *observation* that proves a claim, not the wrapper process.
    const observation = clip(
      rec.observation || rec.proof_highlight || extractObservationHighlight(stdoutRaw),
      2000,
    );
    base = {
      kind: materialPath ? "source_excerpt" : "shell",
      command,
      file: rec.file,
      // Only surface target material paths (notes/source_dump/…), not agent probe script paths.
      path_or_url: pathHint || undefined,
      path: pathHint || undefined,
      exitCode: rec.exitCode ?? rec.exit_code,
      timedOut: rec.timedOut,
      aborted: rec.aborted,
      stdout,
      stderr,
      observation,
      // Excerpt for Case/UI/collab: proof first; full stdout remains in stdout for expand.
      excerpt: observation || stdout || (stderr ? `stderr: ${clip(stderr, 600)}` : ""),
      preview: materialPath ? clip(stdout, 2500) : undefined,
      proof: {
        exitCode: rec.exitCode ?? rec.exit_code,
        observation: clip(observation, 800),
        stdout_excerpt: clip(observation || stdout, 800),
      },
    };
  } else if (tool === "browser" || tool.includes("browser")) {
    // Browser tools emit snapshot/cli/text — map all into collab-facing fields.
    const text = clip(
      rec.text || rec.html || rec.content || rec.snapshot || rec.cli || "",
      3000,
    );
    const url = clip(rec.url || rec.open_url || "", 800);
    base = {
      kind: "browser",
      url: url || undefined,
      path_or_url: url || undefined,
      action: rec.action,
      html: clip(rec.html || rec.content || rec.snapshot, 3000),
      text: clip(rec.text || rec.snapshot || rec.cli, 2000),
      excerpt: text || (url ? `browser ${url}` : ""),
    };
  } else if (tool === "session") {
    const body = clip(
      rec.body_preview ||
        rec.body ||
        rec.stdout ||
        sessionStepsBody(rec.steps) ||
        sessionCompareBody(rec) ||
        "",
      4000,
    );
    const url = clip(rec.url || "", 800);
    const actor = clip(rec.actor || rec.actor_a || "", 80);
    base = {
      kind: body || url ? "http" : "session",
      url: url || undefined,
      path_or_url: url || actor || undefined,
      method: rec.method,
      status: rec.status ?? rec.status_code,
      actor: actor || undefined,
      stdout: clip(rec.stdout, 4000),
      body_preview: body,
      excerpt: body || (url ? `${rec.method || "SESSION"} ${url}` : actor ? `session actor=${actor}` : ""),
      data: clipJson(rec, 4000),
    };
  } else {
    base = {
      kind: "tool",
      data: clipJson(rec, 6000),
      excerpt: clip(typeof rec.summary === "string" ? rec.summary : JSON.stringify(rec).slice(0, 400), 600),
    };
  }

  const role = roleOverride || classifyEvidenceRole(tool, base);
  base.role = role;
  // Drop empty noise keys
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || v === null || v === "") continue;
    cleaned[k] = v;
  }
  return cleaned;
}

function sessionStepsBody(steps: unknown): string {
  if (!Array.isArray(steps) || !steps.length) return "";
  const parts: string[] = [];
  for (const s of steps.slice(0, 6)) {
    if (!s || typeof s !== "object") continue;
    const row = s as Record<string, unknown>;
    const line = [row.method, row.url, row.status != null ? `→ ${row.status}` : ""]
      .filter(Boolean)
      .join(" ");
    const body = String(row.body_preview || "").trim();
    if (line) parts.push(line);
    if (body) parts.push(body.slice(0, 400));
  }
  return parts.join("\n");
}

function sessionCompareBody(rec: Record<string, unknown>): string {
  const a = rec.a && typeof rec.a === "object" ? (rec.a as Record<string, unknown>) : null;
  const b = rec.b && typeof rec.b === "object" ? (rec.b as Record<string, unknown>) : null;
  if (!a && !b) return "";
  const bits: string[] = [];
  if (a) bits.push(`A: ${a.status ?? ""} ${String(a.body_preview || a.url || "").slice(0, 200)}`);
  if (b) bits.push(`B: ${b.status ?? ""} ${String(b.body_preview || b.url || "").slice(0, 200)}`);
  return bits.join("\n");
}

/** Classify proof vs process noise for Case collab default views. */
export function classifyEvidenceRole(sourceTool: string, props: Record<string, unknown>): "proof" | "trace" {
  const tool = String(sourceTool || "").toLowerCase();
  // Book-time proof materials (created by finding tool) are product proof.
  if (tool === "finding" || props.kind === "proof") {
    const excerpt = String(props.excerpt || props.observation || props.proof || props.stdout || "").trim();
    return excerpt.length >= 16 ? "proof" : "trace";
  }
  if (["todo", "skill", "read", "edit", "goal", "subagent"].includes(tool)) {
    return "trace";
  }
  const excerpt = String(
    props.excerpt || props.stdout || props.body_preview || props.response_body || props.preview || props.text || "",
  ).trim();
  const pathOrUrl = String(props.path_or_url || props.path || props.url || "").trim();
  if (tool === "file" || tool === "write" || props.kind === "file" || props.kind === "source_excerpt") {
    return pathOrUrl || excerpt.length >= 16 ? "proof" : "trace";
  }
  if (!excerpt && !pathOrUrl) return "trace";

  // URL/status only (no real body) → trace for collab; booking gate still rejects status-only claims.
  if (tool === "http" || props.kind === "http") {
    const body = String(props.response_body || props.body_preview || props.stdout || "").trim();
    if (body.length < 8) {
      // Redirect with Location still useful
      const headers = String(JSON.stringify(props.response_headers || props.headers || "")).toLowerCase();
      if (headers.includes("location")) return "proof";
      return "trace";
    }
  }

  if (tool === "browser" || props.kind === "browser") {
    const body = String(props.text || props.html || props.excerpt || "").trim();
    // "browser http://..." alone is not proof material
    if (body.length < 24 || /^browser\s+https?:\/\//i.test(body)) return "trace";
  }

  if (tool === "shell" || tool === "script") {
    if (isShellNoise(excerpt, String(props.command || ""))) return "trace";
  }

  if (tool === "session") {
    const body = String(props.body_preview || props.excerpt || props.stdout || "").trim();
    if (body.length < 8 && !pathOrUrl.startsWith("http")) return "trace";
  }

  return "proof";
}

function isShellNoise(stdout: string, command: string): boolean {
  const out = stdout.trim();
  const cmd = command.trim().toLowerCase();
  if (!out) return true;
  if (/^total\s+\d+\s*$/i.test(out) || /^total\s+\d+(\n[-\w].*){0,3}$/i.test(out)) {
    if (/^\s*ls\b/.test(cmd) && !cmd.includes("cat ") && !cmd.includes("find ")) return true;
  }
  if (out.length < 8 && /^(ok|true|done|1)$/i.test(out)) return true;
  return false;
}

/** Target material for code-audit collab — NOT agent probe scripts under scripts/. */
export function looksLikeMaterialPath(path: string): boolean {
  const p = path.replace(/\\/g, "/").toLowerCase();
  if (!p) return false;
  // Agent-owned probe paths are process, not product evidence of target source.
  if (p.includes("/scripts/") || p.startsWith("scripts/") || /_probe\.py$/.test(p)) return false;
  if (p.includes("source_dump") || p.includes("/notes/") || p.startsWith("notes/")) return true;
  // Target source-like files only when under dump/material-ish dirs
  if (/(^|\/)(source|dump|leaked|materials)\//.test(p)) return true;
  return false;
}

/**
 * Pull the proving *observation* out of script/shell stdout for Case/UI.
 * Structural only (banners, CONFIRMED/Context blocks, HTTP-ish lines, HTML fragments) —
 * not vuln-class keyword lists.
 */
export function extractObservationHighlight(stdout: string, max = 1500): string {
  const text = String(stdout || "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!text) return "";
  const lines = text.split("\n");
  const interesting: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const L = lines[i] || "";
    if (/\[CONFIRMED\]/i.test(L)) interesting.push(i);
    if (/^Context:\s*/i.test(L)) interesting.push(i);
    if (/^(GET|POST|PUT|PATCH|DELETE)\s+\S+/i.test(L)) interesting.push(i);
    if (/->\s*\d{3}|\bstatus[:\s]+\d{3}\b/i.test(L)) interesting.push(i);
    if (/^\[Test\s+\d|^\[Step\s+\d|^\d+\)\s+\S/i.test(L)) interesting.push(i);
    // HTML fragment often carries the reflected/stored payload proof
    if (/<[a-zA-Z][^>]{0,120}>/.test(L) && L.length >= 24) interesting.push(i);
    // Payload-looking quoted snippets after Context or in response dumps
    if (/payload|reflected|persistent|uploaded|password changed/i.test(L) && L.length >= 16) {
      interesting.push(i);
    }
  }
  if (interesting.length) {
    const keep = new Set<number>();
    for (const i of interesting) {
      for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 4); j += 1) keep.add(j);
    }
    const picked = [...keep]
      .sort((a, b) => a - b)
      .map((i) => lines[i])
      .join("\n")
      .trim();
    if (picked.length >= 16) return clip(picked, max);
  }
  // Skip leading decorative banners (=== ... ===, [*]) and take substance.
  let start = 0;
  while (
    start < lines.length &&
    (/^={3,}/.test(lines[start] || "") ||
      /^\s*$/.test(lines[start] || "") ||
      (/^\[[*+]\]/.test(lines[start] || "") && (lines[start] || "").length < 80))
  ) {
    start += 1;
  }
  return clip(lines.slice(start).join("\n").trim() || text, max);
}

/** Accept only path-like tokens (reject regex/sed garbage from shell one-liners). */
export function isPlausiblePathHint(token: string): boolean {
  const t = String(token || "").trim();
  if (!t || t.length < 2 || t.length > 400) return false;
  if (t.startsWith("-")) return false;
  // Regex / PCRE noise
  if (/[(){}|?*+[\]^$]/.test(t) && !t.includes("/")) return false;
  if (/^\.\*\?/.test(t) || /=\?\(/.test(t) || /<\//.test(t)) return false;
  if (t === "/dev/null" || t === "nul") return false;
  // Must look like a path or URL or relative file
  if (/^https?:\/\//i.test(t)) return true;
  if (t.startsWith("/") || t.startsWith("./") || t.startsWith("../")) return true;
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;
  if (/^(notes|scripts|evidence|findings|source_dump|workspace)\//i.test(t)) return true;
  if (/^[\w.-]+\/[\w./-]+\.\w{1,8}$/.test(t)) return true; // rel/path.ext
  if (/^[\w.-]+\.\w{1,8}$/.test(t) && !t.includes("=")) return true; // file.ext
  return false;
}

/** Best-effort path extraction for collab (cat/tee/redirection dumps). */
export function pathHintFromCommand(command: string): string {
  const c = String(command || "").trim();
  if (!c) return "";
  const candidates: string[] = [];

  // Quoted paths first
  for (const m of c.matchAll(/(['"])([^'"`\n]+)\1/g)) {
    if (m[2] && isPlausiblePathHint(m[2])) candidates.push(m[2]);
  }
  // cat/head/tail/tee
  for (const m of c.matchAll(/\b(?:cat|head|tail|less|more|nl|tee)\s+([^\s'"`;&|]+)/g)) {
    if (m[1] && isPlausiblePathHint(m[1])) candidates.push(m[1]);
  }
  // redirection > file / >> file
  for (const m of c.matchAll(/(?:>>?)\s*([^\s'"`;&|]+)/g)) {
    if (m[1] && isPlausiblePathHint(m[1])) candidates.push(m[1]);
  }
  // python script.py
  for (const m of c.matchAll(/\bpython3?\s+([^\s'"`;&|]+\.py)\b/g)) {
    if (m[1] && isPlausiblePathHint(m[1])) candidates.push(m[1]);
  }
  // Prefer material / notes paths
  candidates.sort((a, b) => {
    const score = (p: string) =>
      (looksLikeMaterialPath(p) ? 10 : 0) + (p.includes("source_dump") ? 5 : 0) + Math.min(p.length, 50) / 50;
    return score(b) - score(a);
  });
  return candidates[0]?.slice(0, 400) || "";
}

/** Pull material paths mentioned in stdout (e.g. saved to notes/source_dump/x). */
export function pathHintFromStdout(stdout: string): string {
  const text = String(stdout || "");
  const m =
    text.match(/(?:notes|source_dump|scripts)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8}/) ||
    text.match(/(?:^|\s)(\.?\.?\/?(?:notes|source_dump)\/[A-Za-z0-9_./-]+)/m);
  if (m) {
    const p = (m[1] || m[0]).trim();
    return isPlausiblePathHint(p) ? p.slice(0, 400) : "";
  }
  return "";
}

export function clip(value: unknown, max: number): string {
  if (value === undefined || value === null) return "";
  const s = String(value);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function clipJson(value: unknown, max: number): unknown {
  if (value === undefined || value === null) return undefined;
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
