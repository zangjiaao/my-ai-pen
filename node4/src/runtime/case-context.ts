/**
 * Format Case work-group context for the agent first prompt.
 * Mirrors platform case_context envelope (thread + findings board + evidence snippets).
 */

export type CaseThreadLine = {
  speaker?: string;
  kind?: string;
  text?: string;
  ts?: string;
};

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

export type CaseContext = {
  version?: number;
  conversation_id?: string;
  note?: string;
  thread?: CaseThreadLine[];
  findings_summary?: CaseFindingLine[];
  evidence_snippets?: CaseEvidenceSnippet[];
  artifact_hints?: string[];
  /** Spec #312: open Workset refs for agent-curated next_steps binds (not a choice UI). */
  next_work?: CaseNextWork;
};

const MAX_THREAD_LINES = 50;
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
  if (!thread.length && !findings.length && !hints.length && !snippets.length && !next_work) {
    if (!o.note && !o.conversation_id) return undefined;
  }
  return {
    version: typeof o.version === "number" ? o.version : 1,
    conversation_id: o.conversation_id != null ? String(o.conversation_id) : undefined,
    note: o.note != null ? String(o.note) : undefined,
    thread,
    findings_summary: findings,
    evidence_snippets: snippets,
    artifact_hints: hints,
    next_work,
  };
}

/** Render case work-group block for LLM (budgeted). */
export function formatCaseContextInjection(ctx: CaseContext | undefined | null): string {
  if (!ctx) return "";
  const lines: string[] = [
    "## Case work-group context (same conversation — read before acting)",
    ctx.note ||
      "You are joining an ongoing case. Prior messages, findings, and evidence below are shared. Do not pretend you were offline.",
  ];
  if (ctx.conversation_id) {
    lines.push(`Case/conversation id: ${ctx.conversation_id}`);
  }

  const thread = (ctx.thread || []).slice(-MAX_THREAD_LINES);
  if (thread.length) {
    lines.push("", "### Group thread (oldest → newest)");
    for (const item of thread) {
      const sp = String(item.speaker || "member").trim() || "member";
      const tx = String(item.text || "").trim();
      if (!tx) continue;
      lines.push(`- ${sp}: ${tx}`);
    }
  } else {
    lines.push("", "### Group thread", "(no prior messages — this may be the first turn)");
  }

  const findings = (ctx.findings_summary || []).slice(0, MAX_FINDINGS);
  if (findings.length) {
    lines.push(
      "",
      "### Findings already on ledger (re-verify open ones — do not skip)",
      "Open priors on this asset are work to re-prove with **fresh** acts, then finding(confirm) with finding_id so **this Case** ledger updates (platform rediscovery merge / vuln_found). Chat “N verified” without confirm is not a Finding. Prefer high/critical first. Interleave with remaining untested surface from recon.",
    );
    for (const f of findings) {
      const sev = f.severity ? `[${f.severity}] ` : "";
      const st = f.status ? ` (${f.status})` : "";
      const loc = f.location ? ` @ ${f.location}` : "";
      const id = f.id ? ` id=${f.id}` : "";
      const eids = Array.isArray(f.evidence_ids) && f.evidence_ids.length
        ? ` evidence=[${f.evidence_ids.slice(0, 6).join(", ")}]`
        : "";
      lines.push(`- ${sev}${f.title || "finding"}${st}${loc}${id}${eids}`);
      if (f.proof_excerpt) {
        lines.push(`  proof: ${String(f.proof_excerpt).replace(/\s+/g, " ").slice(0, 280)}`);
      }
    }
  }

  const snippets = (ctx.evidence_snippets || []).slice(0, MAX_EVIDENCE);
  if (snippets.length) {
    lines.push("", "### Case evidence (shared materials — paths/excerpts for collaboration)");
    lines.push(
      "Use these when continuing another expert's work (e.g. source path for code-audit). Full bodies are truncated.",
    );
    for (const s of snippets) {
      const id = s.id ? `id=${s.id}` : "id=?";
      const kind = s.kind || s.source_tool || "tool";
      const role = s.role ? ` role=${s.role}` : "";
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
    lines.push("", "### Artifact / path hints (not full file bodies)");
    for (const h of hints) lines.push(`- ${h}`);
  }

  // Spec #312 S5: retain next_work refs so Agent can bind next_steps options honestly.
  const nextWork = ctx.next_work;
  if (nextWork && (nextWork.workset_open_count || (nextWork.workset_open || []).length)) {
    const open = (nextWork.workset_open || []).slice(0, 12);
    const count =
      typeof nextWork.workset_open_count === "number"
        ? nextWork.workset_open_count
        : open.length;
    lines.push("", "### Case Next / Workset (open)");
    lines.push(
      `Open Workset items: ${count} (refs only — inventory SoT, not a user choice UI).`,
    );
    lines.push(
      "At stoppable settle / empty-continue with open Workset: emit structured request_user_decision(kind=next_steps) with 2–5 curated options (title+body; optional workset_item_ids). Do not only say 等待指示 or free-text A/B/C/D.",
    );
    for (const item of open) {
      const id = item.id ? `id=${item.id}` : "id=?";
      const fam = item.family ? ` [${item.family}]` : "";
      const st = item.status ? ` (${item.status})` : "";
      const title = String(item.title || "").trim() || "(untitled)";
      lines.push(`- ${id}${fam}${st} ${title}`);
    }
    if (nextWork.goal && (nextWork.goal.status || nextWork.goal.terminal)) {
      const gs = nextWork.goal.status ? `status=${nextWork.goal.status}` : "";
      const gt = nextWork.goal.terminal ? ` terminal=${nextWork.goal.terminal}` : "";
      lines.push(`Goal: ${gs}${gt}`.trim());
    }
  }

  lines.push(
    "",
    "Continue this case from the shared findings and evidence above. Prefer evidence paths/excerpts over inventing new dump locations. Large trees are not fully inlined — open or re-fetch only what you need.",
  );
  if (findings.length) {
    lines.push(
      "When open ledger findings exist on Scope assets: **re-verify** them with fresh proof (rediscovery) and booking via finding(confirm) — listing priors or chat summary is not completion and does not fill this Case Findings panel.",
    );
  }

  let out = lines.join("\n");
  if (out.length > MAX_TOTAL_CHARS) {
    out = `${out.slice(0, MAX_TOTAL_CHARS)}\n…(case context truncated)`;
  }
  return out;
}
