/**
 * Offline audit of Node4 CTF/pentest events.jsonl runs.
 * Pure parse helpers — no answer keys, no live target dependency.
 */

export type CtfAuditToolCounts = Record<string, number>;

export type CtfAuditShellShape = {
  curl: number;
  python: number;
  cookie_jar: number;
  gopher: number;
  sqlmap: number;
  fuzzer: number;
  browser_cli: number;
  other: number;
};

export type CtfAuditReport = {
  source: string;
  event_lines: number;
  tool_counts: CtfAuditToolCounts;
  shell_commands_seen: number;
  shell_shapes: CtfAuditShellShape;
  /** Redacted command prefixes for operator review (URLs scrubbed). */
  shell_samples: string[];
  status_continues: string[];
  goal_ops: string[];
  flags_unique: string[];
  flag_count: number;
  levels_seen: Record<string, number>;
  /** Heuristic gaps for pack/tool/skill design (no target answers). */
  gap_candidates: string[];
  leverage_recommendations: string[];
};

export type CtfAuditOptions = {
  /** Max shell samples to keep. */
  maxSamples?: number;
  /** Label for report.source when path not provided. */
  sourceLabel?: string;
};

/** Parse one events.jsonl text blob into an audit report. */
export function auditCtfEventsJsonl(text: string, options: CtfAuditOptions = {}): CtfAuditReport {
  const maxSamples = Math.max(1, options.maxSamples ?? 15);
  const tool_counts: CtfAuditToolCounts = {};
  const shell_shapes: CtfAuditShellShape = {
    curl: 0,
    python: 0,
    cookie_jar: 0,
    gopher: 0,
    sqlmap: 0,
    fuzzer: 0,
    browser_cli: 0,
    other: 0,
  };
  const shell_samples: string[] = [];
  const sampleKeys = new Set<string>();
  const status_continues: string[] = [];
  const goal_ops: string[] = [];
  const flagSet = new Set<string>();
  let event_lines = 0;
  let shell_commands_seen = 0;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    event_lines += 1;
    const type = String(o.type || "");

    if (type === "tool_output") {
      const name = String(o.tool_name || "unknown");
      tool_counts[name] = (tool_counts[name] || 0) + 1;
      if (name === "shell" && (o.status === "running" || o.args)) {
        const args = (o.args && typeof o.args === "object" ? o.args : {}) as Record<string, unknown>;
        const cmd = String(args.command || "").trim();
        if (cmd) {
          shell_commands_seen += 1;
          classifyShellShape(cmd, shell_shapes);
          const key = scrubUrl(cmd).slice(0, 100);
          if (!sampleKeys.has(key) && shell_samples.length < maxSamples) {
            sampleKeys.add(key);
            shell_samples.push(scrubUrl(cmd).slice(0, 180));
          }
        }
      }
    }

    if (type === "status_update") {
      const msg = String(o.message || "");
      if (/continue/i.test(msg)) status_continues.push(msg.slice(0, 240));
    }
    if (type === "goal_updated") {
      goal_ops.push(String(o.op || "unknown"));
    }

    // Collect flag shapes from any text field (evidence, not answer keys).
    const blob = JSON.stringify(o);
    for (const m of blob.matchAll(/flag\{[a-zA-Z0-9_\-]{4,}\}/g)) {
      flagSet.add(m[0]!);
    }
  }

  const flags_unique = [...flagSet].sort();
  const levels_seen: Record<string, number> = {};
  for (const f of flags_unique) {
    const m = /^flag\{(l\d+)/i.exec(f);
    if (m) levels_seen[m[1]!.toLowerCase()] = (levels_seen[m[1]!.toLowerCase()] || 0) + 1;
  }

  const gap_candidates = deriveGaps(tool_counts, shell_shapes, shell_commands_seen, goal_ops);
  const leverage_recommendations = deriveLeverage(shell_shapes, tool_counts);

  return {
    source: options.sourceLabel || "events.jsonl",
    event_lines,
    tool_counts,
    shell_commands_seen,
    shell_shapes,
    shell_samples,
    status_continues: status_continues.slice(-30),
    goal_ops,
    flags_unique,
    flag_count: flags_unique.length,
    levels_seen,
    gap_candidates,
    leverage_recommendations,
  };
}

function classifyShellShape(cmd: string, shapes: CtfAuditShellShape): void {
  const cl = cmd.toLowerCase();
  let hit = false;
  if (/\bcurl\b/.test(cl)) {
    shapes.curl += 1;
    hit = true;
  }
  if (/\bpython3?\b/.test(cl)) {
    shapes.python += 1;
    hit = true;
  }
  if (/cookie|cjar|-b\s|-c\s|set-cookie|jar/.test(cl)) {
    shapes.cookie_jar += 1;
    hit = true;
  }
  if (/gopher:\/\//.test(cl)) {
    shapes.gopher += 1;
    hit = true;
  }
  if (/sqlmap/.test(cl)) {
    shapes.sqlmap += 1;
    hit = true;
  }
  if (/\b(ffuf|gobuster|feroxbuster|dirsearch)\b/.test(cl)) {
    shapes.fuzzer += 1;
    hit = true;
  }
  if (/\b(playwright|selenium|chromium|puppeteer|agent-browser)\b/.test(cl)) {
    shapes.browser_cli += 1;
    hit = true;
  }
  if (!hit) shapes.other += 1;
}

function scrubUrl(cmd: string): string {
  return cmd.replace(/https?:\/\/[^\s"'\\]+/gi, "URL");
}

function deriveGaps(
  tools: CtfAuditToolCounts,
  shapes: CtfAuditShellShape,
  shellN: number,
  goalOps: string[],
): string[] {
  const gaps: string[] = [];
  if ((tools.shell || 0) > 50 && shapes.curl > 20) {
    gaps.push("heavy curl-via-shell: sessionized HTTP tool would cut boilerplate");
  }
  if (shapes.cookie_jar > 10) {
    gaps.push("frequent cookie jar handling: durable session jar tool needed");
  }
  if (shapes.python > 15) {
    gaps.push("many ad-hoc python one-liners: offer recipes for common CTF chains");
  }
  if (shapes.browser_cli === 0 && (tools.http || 0) + shapes.curl > 0) {
    gaps.push("no browser usage: SPA/JS-gated challenges may be under-tested");
  }
  if (!tools.skill && !tools.session) {
    gaps.push("no skill/session tools in run: methodology and session tools not yet available");
  }
  if (goalOps.includes("complete_rejected")) {
    gaps.push("early goal complete rejected: keep maximize gates; teach flag-verify skill");
  }
  if (shellN > 100 && Object.keys(tools).length <= 4) {
    gaps.push("narrow tool surface: agent over-relies on shell for all act paths");
  }
  return gaps;
}

function deriveLeverage(shapes: CtfAuditShellShape, tools: CtfAuditToolCounts): string[] {
  const recs: string[] = [];
  if (shapes.curl > 0 || shapes.cookie_jar > 0) {
    recs.push("session tool: multi-step HTTP with cookie jar + history (replace curl -b/-c chains)");
  }
  if (shapes.gopher > 0 || shapes.python > 0) {
    recs.push("recipes: documented non-answer CTF scripts (ssrf-gopher, multi-step login) under recipes/ctf");
  }
  recs.push("skills: ctf-web-recon, ctf-flag-verify, ctf-stuck-rotation (load on demand)");
  if (!tools.session) recs.push("wire session into ctf pack toolNames");
  return recs;
}
