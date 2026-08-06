/**
 * Spec #308 — Worker display_name resolve (S1 / S-name).
 *
 * Resolve: user_display_name(agent_id) ?? panel_agents.name ?? "Worker N"
 * Does not change agent_id or system ordinal.
 */

import { isWorkerName, workerNameOrdinal } from "./workerPresentation";

export function resolveWorkerDisplayName(input: {
  agentId?: string | null;
  /** Case override map agent_id → name */
  overrides?: Record<string, string> | null;
  /** panel_agents.name for this agent */
  panelName?: string | null;
  /** Optional ordinal for fallback Worker N */
  workerOrdinal?: number | null;
}): string {
  const id = String(input.agentId || "").trim();
  const overrides = input.overrides || {};
  if (id) {
    const direct = String(overrides[id] || "").trim();
    if (direct) return direct;
    // Root-prefixed panel ids: `{root}-{subId}`
    for (const [key, value] of Object.entries(overrides)) {
      const k = String(key || "").trim();
      const v = String(value || "").trim();
      if (!k || !v) continue;
      if (k === id || id.endsWith(`-${k}`) || k.endsWith(`-${id}`)) return v;
    }
  }
  const panel = String(input.panelName || "").trim();
  if (panel) return panel;
  const ord = input.workerOrdinal;
  if (typeof ord === "number" && ord >= 1) return `Worker ${ord}`;
  const fromPanel = workerNameOrdinal(panel);
  if (fromPanel != null) return `Worker ${fromPanel}`;
  return "Worker";
}

/** Normalize write payload: trim; empty clears; length 1–64. */
export function normalizeDisplayNameWrite(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (raw == null) return { ok: true, value: "" };
  const rawStr = String(raw);
  // Reject control chars in the raw value (not only after trim).
  if (/[\x00-\x1f\x7f]/.test(rawStr)) {
    return { ok: false, error: "display_name must not contain control characters" };
  }
  const text = rawStr.trim();
  if (!text) return { ok: true, value: "" };
  if (text.length > 64) {
    return { ok: false, error: "display_name must be at most 64 characters" };
  }
  return { ok: true, value: text };
}

/** Apply override map to a panel agent list for tree/Tasks presentation. */
export function applyDisplayNameOverrides<T extends { id: string; name?: string; role?: string }>(
  agents: T[],
  overrides: Record<string, string> | null | undefined,
): T[] {
  if (!overrides || !Object.keys(overrides).length) return agents;
  return agents.map((agent) => {
    const role = String(agent.role || "").toLowerCase();
    if (role !== "subagent") return agent;
    const name = resolveWorkerDisplayName({
      agentId: agent.id,
      overrides,
      panelName: agent.name,
    });
    // Keep system Worker N in panel when no override — only rewrite when different.
    if (name === String(agent.name || "").trim()) return agent;
    // Prefer override over panel; if resolve fell back to Worker without ordinal, keep panel.
    if (name === "Worker" && isWorkerName(String(agent.name || ""))) return agent;
    return { ...agent, name };
  });
}
