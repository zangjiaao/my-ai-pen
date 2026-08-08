/**
 * Spec #324 S1 — Case metering presentation helpers (pure projection).
 * Status D1: Case totals + AgentRow model · requests · tokens.
 */
import type { AgentUsageSummary, StrixAgentStatus } from "./panelTypes";

export type CaseRunUsage = {
  total_tokens?: number;
  cost?: number;
  requests?: number;
};

export type CaseRunSummaryLike = {
  started_at?: string;
  last_active_at?: string;
  participant_count?: number;
  llm_usage?: CaseRunUsage;
};

/** Compact token count for collab header / rows. */
export function formatTokenCount(value: unknown): string {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

export function formatCostUsd(value: unknown): string {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * Collaboration section primary metric: Case total tokens + cost.
 * Active worker count is secondary only (caller may append).
 */
export function formatCaseMeteringHeader(caseRun: CaseRunSummaryLike | undefined | null): string {
  const usage = caseRun?.llm_usage || {};
  const tokens = Number(usage.total_tokens || 0);
  const cost = Number(usage.cost || 0);
  const tok = formatTokenCount(tokens);
  if (cost > 0) return `${tok} tok · ${formatCostUsd(cost)}`;
  if (tokens > 0) return `${tok} tok`;
  return "0 tok";
}

function readUsage(agent: Pick<StrixAgentStatus, "usage" | "model">): AgentUsageSummary {
  const u = agent.usage && typeof agent.usage === "object" ? agent.usage : {};
  return {
    total_tokens: Number(u.total_tokens || 0),
    cost: Number(u.cost || 0),
    requests: Number(u.requests || 0),
    model: String(agent.model || u.model || "").trim() || undefined,
  };
}

/**
 * AgentRow secondary line: model · requests · tokens (Participant cumulative).
 * Empty/zero usage returns a quiet dash — never tool-progress narration.
 */
export function formatAgentUsageLine(
  agent: Pick<StrixAgentStatus, "usage" | "model" | "role" | "parent_id">,
  opts?: { short?: boolean },
): string {
  const u = readUsage(agent);
  const tokens = Number(u.total_tokens || 0);
  const requests = Number(u.requests || 0);
  const model = String(u.model || "").trim();
  const short = Boolean(opts?.short) || Boolean(agent.parent_id) || String(agent.role || "").toLowerCase() === "subagent";

  if (tokens <= 0 && requests <= 0 && !model) {
    return short ? "" : "—";
  }

  const parts: string[] = [];
  if (model) parts.push(model);
  if (requests > 0) parts.push(`${requests} req`);
  if (tokens > 0) parts.push(`${formatTokenCount(tokens)} tok`);
  else if (!short && requests <= 0 && model) {
    // model known but no meters yet
  }
  return parts.join(" · ") || (short ? "" : "—");
}

/** True when AgentRow should not require a work-content summary string. */
export function agentRowUsesMeteringSecondary(): boolean {
  return true;
}
