/**
 * Format Case work-group context for the agent first prompt.
 * Mirrors platform case_context envelope (thread + findings board).
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
};

export type CaseContext = {
  version?: number;
  conversation_id?: string;
  note?: string;
  thread?: CaseThreadLine[];
  findings_summary?: CaseFindingLine[];
  artifact_hints?: string[];
};

const MAX_THREAD_LINES = 50;
const MAX_FINDINGS = 25;
const MAX_TOTAL_CHARS = 16000;

export function parseCaseContext(raw: unknown): CaseContext | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const thread = Array.isArray(o.thread) ? (o.thread as CaseThreadLine[]) : [];
  const findings = Array.isArray(o.findings_summary)
    ? (o.findings_summary as CaseFindingLine[])
    : Array.isArray(o.findings)
      ? (o.findings as CaseFindingLine[])
      : [];
  const hints = Array.isArray(o.artifact_hints)
    ? o.artifact_hints.map(String)
    : [];
  if (!thread.length && !findings.length && !hints.length) {
    // Still allow empty note-only for tests
    if (!o.note && !o.conversation_id) return undefined;
  }
  return {
    version: typeof o.version === "number" ? o.version : 1,
    conversation_id: o.conversation_id != null ? String(o.conversation_id) : undefined,
    note: o.note != null ? String(o.note) : undefined,
    thread,
    findings_summary: findings,
    artifact_hints: hints,
  };
}

/** Render case work-group block for LLM (budgeted). */
export function formatCaseContextInjection(ctx: CaseContext | undefined | null): string {
  if (!ctx) return "";
  const lines: string[] = [
    "## Case work-group context (same conversation — read before acting)",
    ctx.note ||
      "You are joining an ongoing case like a work group chat. Prior messages and findings below are shared. Do not pretend you were offline.",
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
    lines.push("", "### Findings already on this case");
    for (const f of findings) {
      const sev = f.severity ? `[${f.severity}] ` : "";
      const st = f.status ? ` (${f.status})` : "";
      const loc = f.location ? ` @ ${f.location}` : "";
      const id = f.id ? ` id=${f.id}` : "";
      lines.push(`- ${sev}${f.title || "finding"}${st}${loc}${id}`);
    }
  }

  const hints = (ctx.artifact_hints || []).filter(Boolean).slice(0, 12);
  if (hints.length) {
    lines.push("", "### Artifact / path hints (not full file bodies)");
    for (const h of hints) lines.push(`- ${h}`);
  }

  lines.push(
    "",
    "Use this context to continue the case. Prefer acting on requests already in the thread. Large source trees are not inlined — open paths via tools when needed.",
  );

  let out = lines.join("\n");
  if (out.length > MAX_TOTAL_CHARS) {
    out = `${out.slice(0, MAX_TOTAL_CHARS)}\n…(case context truncated)`;
  }
  return out;
}
