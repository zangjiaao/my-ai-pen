/**
 * Format Case work-group context for the system This turn block.
 * Findings / intel / evidence live here. Visible group speech is harness
 * (`case-speech.ts`), not ### Thread.
 */

export type CaseThreadLine = {
  speaker?: string;
  kind?: string;
  text?: string;
  ts?: string;
  id?: string;
  expert_id?: string;
};

/** Visible group speech (id-bearing). Distinct from thread crumbs / finding cards. */
export type CaseSpeechLine = CaseThreadLine;

export type CaseFindingLine = {
  id?: string;
  title?: string;
  severity?: string;
  status?: string;
  location?: string;
  url?: string;
  description?: string;
  evidence_ids?: string[];
  proof_excerpt?: string;
};

export type CaseEvidenceSnippet = {
  id?: string;
  summary?: string;
  source_tool?: string;
  kind?: string;
  role?: string;
  path_or_url?: string;
  excerpt?: string;
};

/** Spec #311/#312 — thin Workset refs from platform case_context.next_work. */
export type CaseNextWorkItem = {
  id?: string;
  family?: string;
  title?: string;
  status?: string;
  auto_eligible?: boolean;
  suggested_expert?: string;
};

export type CaseNextWork = {
  boundary?: string;
  workset_open?: CaseNextWorkItem[];
  workset_open_count?: number;
  note?: string;
  goal?: {
    status?: string;
    terminal?: string;
    outer_rounds?: number;
    outer_budget?: number;
    residual?: unknown;
  };
};

/** Thin cross-Case Host memory (platform scope_intel) — not full prior dumps. */
export type CaseScopeIntel = {
  version?: number;
  discipline?: string;
  hosts?: Array<{
    id?: string;
    address?: string;
    name?: string;
    tags?: string[];
    ports?: string[];
    services?: Array<{ port?: string; name?: string; note?: string }>;
    on_ledger?: boolean;
    note?: string;
  }>;
  prior_findings?: {
    total?: number;
    open_or_retest?: number;
    by_severity?: Record<string, number>;
  };
  high_priority_sample?: Array<{
    id?: string;
    severity?: string;
    title?: string;
    location?: string;
    port?: string;
    status?: string;
    asset_id?: string;
    summary?: string;
    discoveries?: number;
    vuln_type?: string;
  }>;
  surface_sketch?: {
    known_paths?: string[];
    sample_urls?: string[];
    this_case_surface_count?: number;
  };
};

export type CaseContext = {
  version?: number;
  conversation_id?: string;
  note?: string;
  thread?: CaseThreadLine[];
  /** Append-only visible group speech for harness delta (not system ### Thread). */
  speech?: CaseSpeechLine[];
  findings_summary?: CaseFindingLine[];
  evidence_snippets?: CaseEvidenceSnippet[];
  artifact_hints?: string[];
  /** Spec #312: open Workset refs for agent-curated next_steps binds (not a choice UI). */
  next_work?: CaseNextWork;
  /** Thin Scope Host memory: counts + samples + surface sketch. */
  scope_intel?: CaseScopeIntel;
  /** Living notebook clues (id + summary + hang). Distinct from scope_intel priors. */
  intel_summary?: CaseIntelLine[];
};

export type CaseIntelLine = {
  id?: string;
  summary?: string;
  kind?: string;
  asset_id?: string;
  port?: string;
  is_new?: boolean;
};

/** Login/session working memory — inject before path/config clues. */
export const LOGIN_INTEL_KINDS = new Set(["credential_status", "secret", "token", "account"]);

export function formatIntelInjectLine(c: CaseIntelLine): string {
  const bits: string[] = [];
  if (c.kind) bits.push(String(c.kind));
  if (c.port) bits.push(`:${c.port}`);
  else if (c.asset_id) bits.push("host");
  if (c.id) bits.push(`id=${c.id}`);
  const meta = bits.length ? ` (${bits.join(", ")})` : "";
  return `- ${c.summary || "(no summary)"}${meta}`;
}

export function sortIntelSummaryForInject(clues: CaseIntelLine[]): CaseIntelLine[] {
  const creds: CaseIntelLine[] = [];
  const rest: CaseIntelLine[] = [];
  for (const c of clues) {
    if (LOGIN_INTEL_KINDS.has(String(c.kind || ""))) creds.push(c);
    else rest.push(c);
  }
  return [...creds, ...rest];
}

function appendLivingNotebook(lines: string[], ctx: CaseContext): void {
  const clues = ctx.intel_summary || [];
  if (!clues.length) return;
  const ordered = sortIntelSummaryForInject(clues);
  const creds = ordered.filter((c) => LOGIN_INTEL_KINDS.has(String(c.kind || "")));
  const rest = ordered.filter((c) => !LOGIN_INTEL_KINDS.has(String(c.kind || "")));
  lines.push("", "### Living notebook");
  if (creds.length) {
    lines.push("Use first (try these creds/tokens before defaults or hash dump):");
    for (const c of creds) lines.push(formatIntelInjectLine(c));
  }
  if (rest.length) {
    if (creds.length) lines.push("Other clues:");
    for (const c of rest) lines.push(formatIntelInjectLine(c));
  }
  lines.push("Full body: fact(op=get, id=…).");
}

const MAX_FINDINGS = 25;
const MAX_EVIDENCE = 12;
const MAX_TOTAL_CHARS = 18000;

function parseNextWork(raw: unknown): CaseNextWork | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const openRaw = Array.isArray(o.workset_open) ? o.workset_open : [];
  const workset_open: CaseNextWorkItem[] = [];
  for (const row of openRaw) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    const item: CaseNextWorkItem = {};
    if (r.id != null) item.id = String(r.id);
    if (r.family != null) item.family = String(r.family);
    if (r.title != null) item.title = String(r.title);
    if (r.status != null) item.status = String(r.status);
    if (r.auto_eligible != null) item.auto_eligible = Boolean(r.auto_eligible);
    if (r.suggested_expert != null) item.suggested_expert = String(r.suggested_expert);
    workset_open.push(item);
  }
  const count =
    typeof o.workset_open_count === "number"
      ? o.workset_open_count
      : workset_open.length;
  const next: CaseNextWork = {
    workset_open,
    workset_open_count: count,
  };
  if (o.boundary != null) next.boundary = String(o.boundary);
  if (o.note != null) next.note = String(o.note);
  if (o.goal && typeof o.goal === "object" && !Array.isArray(o.goal)) {
    const g = o.goal as Record<string, unknown>;
    next.goal = {
      status: g.status != null ? String(g.status) : undefined,
      terminal: g.terminal != null ? String(g.terminal) : undefined,
      outer_rounds: typeof g.outer_rounds === "number" ? g.outer_rounds : undefined,
      outer_budget: typeof g.outer_budget === "number" ? g.outer_budget : undefined,
      residual: g.residual,
    };
  }
  return next;
}

export function parseCaseContext(raw: unknown): CaseContext | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const thread = Array.isArray(o.thread) ? (o.thread as CaseThreadLine[]) : [];
  const speech = Array.isArray(o.speech) ? (o.speech as CaseSpeechLine[]) : [];
  const findings = Array.isArray(o.findings_summary)
    ? (o.findings_summary as CaseFindingLine[])
    : Array.isArray(o.findings)
      ? (o.findings as CaseFindingLine[])
      : [];
  const snippets = Array.isArray(o.evidence_snippets)
    ? (o.evidence_snippets as CaseEvidenceSnippet[])
    : Array.isArray(o.case_evidence_snippets)
      ? (o.case_evidence_snippets as CaseEvidenceSnippet[])
      : [];
  const hints = Array.isArray(o.artifact_hints) ? o.artifact_hints.map(String) : [];
  const next_work = parseNextWork(o.next_work);
  const scope_intel =
    o.scope_intel && typeof o.scope_intel === "object" && !Array.isArray(o.scope_intel)
      ? (o.scope_intel as CaseScopeIntel)
      : undefined;
  const intel_summary = parseIntelSummary(o.intel_summary);
  if (
    !thread.length &&
    !speech.length &&
    !findings.length &&
    !hints.length &&
    !snippets.length &&
    !next_work &&
    !scope_intel &&
    !intel_summary?.length
  ) {
    if (!o.note && !o.conversation_id) return undefined;
  }
  return {
    version: typeof o.version === "number" ? o.version : 1,
    conversation_id: o.conversation_id != null ? String(o.conversation_id) : undefined,
    note: o.note != null ? String(o.note) : undefined,
    thread,
    speech,
    findings_summary: findings,
    evidence_snippets: snippets,
    artifact_hints: hints,
    next_work,
    scope_intel,
    intel_summary,
  };
}

function parseIntelSummary(raw: unknown): CaseIntelLine[] | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const out: CaseIntelLine[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    const line: CaseIntelLine = {};
    if (r.id != null) line.id = String(r.id);
    if (r.summary != null) line.summary = String(r.summary);
    if (r.kind != null) line.kind = String(r.kind);
    if (r.asset_id != null) line.asset_id = String(r.asset_id);
    if (r.port != null) line.port = String(r.port);
    if (r.is_new != null) line.is_new = Boolean(r.is_new);
    if (line.id || line.summary) out.push(line);
  }
  return out.length ? out : undefined;
}

/** Render case work-group block for LLM (budgeted). Facts only — policy lives in Profession/Runtime. */
export type FormatCaseContextOptions = {
  /** Named engagement port from Target/Scope — labels the prior count and filters sample URLs. */
  engagementPort?: string;
};

function urlMatchesEngagementPort(url: string, port: string): boolean {
  const p = String(port || "").trim();
  if (!p) return true;
  const s = String(url || "").trim();
  if (!s.includes("://")) return true;
  try {
    const u = new URL(s);
    const up = u.port || (u.protocol === "https:" ? "443" : "80");
    return up === p;
  } catch {
    return true;
  }
}

export function formatCaseContextInjection(
  ctx: CaseContext | undefined | null,
  options?: FormatCaseContextOptions,
): string {
  if (!ctx) return "";
  const lines: string[] = ["### Case"];
  if (ctx.conversation_id) {
    lines.push(`id: ${ctx.conversation_id}`);
  }

  appendLivingNotebook(lines, ctx);

  const intel = ctx.scope_intel;
  if (intel && (intel.hosts?.length || intel.prior_findings || intel.high_priority_sample?.length)) {
    lines.push("", "### Scope hosts");
    for (const h of (intel.hosts || []).slice(0, 5)) {
      const addr = String(h.address || "").trim() || "?";
      const name = h.name ? ` «${h.name}»` : "";
      const id = h.id ? ` id=${h.id}` : "";
      const tags = Array.isArray(h.tags) && h.tags.length ? ` tags=${h.tags.slice(0, 6).join(",")}` : "";
      const ports = Array.isArray(h.ports) && h.ports.length ? ` ports=${h.ports.slice(0, 12).join(",")}` : "";
      const on = h.on_ledger === false ? " (not on ledger)" : "";
      lines.push(`- ${addr}${name}${id}${ports}${tags}${on}`);
      if (Array.isArray(h.services) && h.services.length) {
        const svc = h.services
          .slice(0, 6)
          .map((s) => {
            const p = s.port || "?";
            const n = s.name || s.note || "";
            return n ? `${p}/${n}` : String(p);
          })
          .join(", ");
        if (svc) lines.push(`  services: ${svc}`);
      }
      if (h.note) lines.push(`  note: ${String(h.note).slice(0, 120)}`);
    }
    const pf = intel.prior_findings;
    if (pf && (pf.total != null || pf.open_or_retest != null)) {
      const by = pf.by_severity && typeof pf.by_severity === "object" ? pf.by_severity : {};
      const sevBits = Object.entries(by)
        .map(([k, v]) => `${k}=${v}`)
        .slice(0, 6)
        .join(" ");
      const portBit = String(options?.engagementPort || "").trim()
        ? ` on Scope port :${String(options?.engagementPort).trim()} (list without port= follows this port; all_ports=true is host-wide)`
        : "";
      lines.push(
        `- Prior findings: ${pf.total ?? "?"} total, ~${pf.open_or_retest ?? "?"} open` +
          (sevBits ? ` (${sevBits})` : "") +
          portBit,
      );
    }
    const samples = (intel.high_priority_sample || []).slice(0, 24);
    if (samples.length) {
      const total = intel.prior_findings?.total;
      const shownBit =
        typeof total === "number" && total > samples.length
          ? ` (${samples.length} of ${total})`
          : "";
      lines.push("", `### Prior catalog${shownBit}`);
      for (const f of samples) {
        const sev = f.severity ? `[${f.severity}] ` : "";
        const loc = f.location ? ` @ ${f.location}` : "";
        const n = typeof f.discoveries === "number" && f.discoveries > 1 ? ` ×${f.discoveries}` : "";
        const id = f.id ? ` (${f.id})` : "";
        const sum = f.summary ? ` — ${String(f.summary).replace(/\s+/g, " ").slice(0, 140)}` : "";
        lines.push(`- ${sev}${String(f.title || "finding").slice(0, 100)}${loc}${n}${id}${sum}`);
      }
    }
    const sk = intel.surface_sketch;
    if (sk) {
      const paths = (sk.known_paths || []).slice(0, 16);
      if (paths.length) {
        lines.push("", "### Paths seen", `- ${paths.join(" · ")}`);
      }
      const port = String(options?.engagementPort || "").trim();
      const urls = (sk.sample_urls || [])
        .filter((u) => urlMatchesEngagementPort(String(u), port))
        .slice(0, 6);
      if (urls.length) {
        lines.push(`- URLs: ${urls.join(" · ")}`);
      }
      if (sk.this_case_surface_count != null) {
        lines.push(`- This Case surface rows: ${sk.this_case_surface_count}`);
      }
    }
  }

  const findings = (ctx.findings_summary || []).slice(0, MAX_FINDINGS);
  if (findings.length) {
    lines.push("", "### This Case findings");
    for (const f of findings) {
      const sev = f.severity ? `[${f.severity}] ` : "";
      const st = f.status ? ` (${f.status})` : "";
      const loc = f.location ? ` @ ${f.location}` : "";
      const id = f.id ? ` id=${f.id}` : "";
      const eids = Array.isArray(f.evidence_ids) && f.evidence_ids.length
        ? ` evidence=${f.evidence_ids.slice(0, 6).join(",")}`
        : "";
      lines.push(`- ${sev}${f.title || "finding"}${st}${loc}${id}${eids}`);
      if (f.proof_excerpt) {
        lines.push(`  proof: ${String(f.proof_excerpt).replace(/\s+/g, " ").slice(0, 280)}`);
      }
    }
  }

  const snippets = (ctx.evidence_snippets || []).slice(0, MAX_EVIDENCE);
  if (snippets.length) {
    lines.push("", "### Evidence");
    for (const s of snippets) {
      const id = s.id ? s.id : "?";
      const kind = s.kind || s.source_tool || "tool";
      const role = s.role ? ` ${s.role}` : "";
      const where = s.path_or_url ? ` @ ${s.path_or_url}` : "";
      const sum = s.summary ? ` — ${String(s.summary).slice(0, 120)}` : "";
      lines.push(`- [${kind}] ${id}${role}${where}${sum}`);
      if (s.excerpt) {
        const ex = String(s.excerpt).trim().slice(0, 360).replace(/\n/g, " ⏎ ");
        lines.push(`  excerpt: ${ex}`);
      }
    }
  }

  const hints = (ctx.artifact_hints || []).filter(Boolean).slice(0, 12);
  if (hints.length) {
    lines.push("", "### Paths / artifacts");
    for (const h of hints) lines.push(`- ${h}`);
  }

  const nextWork = ctx.next_work;
  if (nextWork && (nextWork.workset_open_count || (nextWork.workset_open || []).length)) {
    const open = (nextWork.workset_open || []).slice(0, 12);
    lines.push("", "### Next (open)");
    for (const item of open) {
      const id = item.id ? item.id : "?";
      const fam = item.family ? ` [${item.family}]` : "";
      const st = item.status ? ` (${item.status})` : "";
      const title = String(item.title || "").trim() || "(untitled)";
      lines.push(`- ${id}${fam}${st} ${title}`);
    }
    if (nextWork.goal && (nextWork.goal.status || nextWork.goal.terminal)) {
      const gs = nextWork.goal.status ? `status=${nextWork.goal.status}` : "";
      const gt = nextWork.goal.terminal ? ` terminal=${nextWork.goal.terminal}` : "";
      lines.push(`- Goal: ${gs}${gt}`.trim());
    }
  }

  let out = lines.join("\n");
  if (out.length > MAX_TOTAL_CHARS) {
    out = `${out.slice(0, MAX_TOTAL_CHARS)}\n…(case context truncated)`;
  }
  return out;
}
