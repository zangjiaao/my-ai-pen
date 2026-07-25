/**
 * Single client-side presentation helpers for Worker / handoff text.
 *
 * Prefer Node panel_agents fields (name, task, current_detail) already scrubbed.
 * These helpers exist only for legacy dirty strings and Tasks titles.
 */

/** True when text looks like a full subagent handoff package. */
export function looksLikeHandoffPackage(s: string): boolean {
  const t = String(s || "");
  return (
    /subagent handoff package/i.test(t) ||
    /^#\s*subagent/i.test(t) ||
    /##\s*Target\b/i.test(t) ||
    /##\s*This-turn goal/i.test(t)
  );
}

export function looksLikeSubagentId(s: string): boolean {
  return /^sub[_-]?\d/i.test(s.trim()) || /^subagent\s+sub_/i.test(s.trim());
}

export function isWorkerName(s: string): boolean {
  return /^Worker\s+\d+\s*$/i.test(String(s || "").trim());
}

/** Extract "## This-turn goal" body, or empty. */
export function extractThisTurnGoal(raw: string, maxLen = 120): string {
  const section = String(raw || "").match(/##\s*This-turn goal[^\n]*\n+([\s\S]*?)(?=\n##\s|\n*$)/i);
  if (section?.[1]) {
    const g = section[1].replace(/\s+/g, " ").trim();
    if (g) return g.length > maxLen ? `${g.slice(0, Math.max(0, maxLen - 3))}…` : g;
  }
  return "";
}

/**
 * this_turn_goal (or clean prose) — never raw handoff markdown / Worker labels / sub_* ids.
 */
export function scrubWorkerPurpose(raw: string, maxLen = 240): string {
  const text = String(raw || "").trim();
  if (!text) return "";
  if (looksLikeHandoffPackage(text)) {
    return extractThisTurnGoal(text, maxLen);
  }
  const flat = text.replace(/\s+/g, " ").trim();
  if (isWorkerName(flat) || looksLikeSubagentId(flat) || /^Subagent sub_/i.test(flat)) return "";
  return flat.length > maxLen ? `${flat.slice(0, Math.max(0, maxLen - 3))}…` : flat;
}

/**
 * Display name for collaboration tree.
 * Trusts clean "Worker N" from Node; never invents a wrong index.
 * Prefer role === "subagent"; parent_id alone is not enough (multi-role trees).
 */
export function agentDisplayName(
  agent: { name?: string; id?: string; role?: string; parent_id?: string | null },
  workerOrdinal?: number,
): string {
  const role = String(agent.role || "").toLowerCase();
  const isSub = role === "subagent";
  if (!isSub) {
    return String(agent.name || agent.id || "Main Agent").trim() || "Main Agent";
  }
  const name = String(agent.name || "").trim();
  const workerFromName = name.match(/^Worker\s+(\d+)\s*$/i);
  if (workerFromName) return `Worker ${workerFromName[1]}`;
  if (typeof workerOrdinal === "number" && workerOrdinal >= 1) return `Worker ${workerOrdinal}`;
  if (/^Worker\b/i.test(name)) return name.slice(0, 32);
  return "Worker";
}

function isOpaquePhaseToken(value: string): boolean {
  return /^(tool_running|llm_waiting|model_turn|starting|running|continue|finished|completed|chat|working|done)$/i.test(
    value.trim(),
  );
}

/** Purpose line candidates → first clean human string. */
export function agentPurposeLine(agent: {
  current_detail?: string;
  task?: string;
  name?: string;
}): string {
  const candidates = [agent.current_detail, agent.task, agent.name].map((v) => String(v || "").trim());
  for (const raw of candidates) {
    if (!raw || isOpaquePhaseToken(raw)) continue;
    if (looksLikeHandoffPackage(raw)) {
      const goal = extractThisTurnGoal(raw);
      if (goal) return goal;
      continue;
    }
    if (isWorkerName(raw) || looksLikeSubagentId(raw) || /^Subagent sub_/i.test(raw)) continue;
    if (/^子任务已完成$|^子任务失败$|^已中止$/.test(raw)) continue;
    return raw;
  }
  return "";
}

/** Tasks chip: show Worker N only; never raw sub_* / handoff. */
export function humanAgentChipName(ownerAgentName: string | undefined | null): string {
  const named = String(ownerAgentName || "").trim();
  if (isWorkerName(named)) return named;
  if (
    named &&
    !/^Subagent sub_/i.test(named) &&
    !looksLikeSubagentId(named) &&
    !/handoff package/i.test(named)
  ) {
    return named.length > 28 ? `${named.slice(0, 25)}…` : named;
  }
  return "";
}

/**
 * Safe agent lookup: exact id, or root-prefixed `{root}-{subId}`.
 * Does NOT use includes() (would match sub_1 inside sub_10).
 */
export function findAgentByIdExact<T extends { id: string }>(
  agents: T[],
  subId: string,
): T | undefined {
  const id = String(subId || "").trim();
  if (!id) return undefined;
  const exact = agents.find((a) => a.id === id);
  if (exact) return exact;
  return agents.find((a) => a.id.endsWith(`-${id}`));
}

/** Next Worker N for legacy events without panel_agents (prefer reusing existing name). */
export function nextWorkerOrdinal(
  agents: Array<{ id: string; name?: string }>,
  subId?: string,
): number {
  if (subId) {
    const existing = findAgentByIdExact(agents, subId);
    const m = String(existing?.name || "").match(/^Worker\s+(\d+)\s*$/i);
    if (m) return Number(m[1]);
  }
  let max = 0;
  for (const a of agents) {
    const m = String(a.name || "").match(/^Worker\s+(\d+)\s*$/i);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** Strip handoff markdown / status suffixes from a todo title for display. */
export function displayTodoTitle(title: string): string {
  let t = String(title || "").trim();
  if (!t) return "Untitled task";
  if (looksLikeHandoffPackage(t)) {
    const goal = extractThisTurnGoal(t, 160);
    if (goal) t = goal;
    else {
      t =
        t
          .split(/\r?\n/)
          .map((l) => l.replace(/^#+\s*/, "").trim())
          .find((l) => l.length >= 8 && !/handoff package|target|scope/i.test(l)) || t;
    }
  }
  t = t.replace(
    /\s*[（(]\s*(已完成|已发现|完成|已跳过|已放弃|完成了|done|completed|found|skipped|abandoned)\s*[）)]\s*$/i,
    "",
  );
  t = t.replace(/\s*[-–—]\s*(已完成|已发现|done|completed)\s*$/i, "");
  t = t.replace(/\s+/g, " ").trim();
  if (t.length > 160) t = `${t.slice(0, 157)}…`;
  return t || String(title || "").trim() || "Untitled task";
}
