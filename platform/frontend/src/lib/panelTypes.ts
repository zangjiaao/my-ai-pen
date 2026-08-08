/**
 * Canonical Status / Tasks panel types (single source of truth).
 * Components re-export when convenient; do not redefine shapes elsewhere.
 */

export type PlanStatus =
  | "todo"
  | "pending"
  | "running"
  | "done"
  | "skipped"
  | "blocked"
  | "failed"
  | string;

/** Plan / work-item node for Tasks list (Expert Graph L1/L2 or flat plan). */
export type PlanNode = {
  node_id?: string;
  id?: string;
  title?: string;
  status?: PlanStatus;
  kind?: string;
  level?: string;
  method?: string | null;
  endpoint?: string | null;
  parameter?: string | null;
  parameters?: string[];
  vuln_type?: string | null;
  result?: string | null;
  parent_id?: string | null;
  notes?: string | null;
  evidence_ids?: string[];
  priority?: number;
  source?: string;
  agent_id?: string;
  linked_agent_id?: string;
  /** Case multi-role: which product expert owns this todo. */
  owner_expert_id?: string;
  owner_expert_name?: string;
  /** Agent Graph worker display label (Tasks chip). */
  owner_agent_name?: string;
};

/** Spec #324 S1: LLM usage projection for Case metering / AgentRow D1. */
export type AgentUsageSummary = {
  total_tokens?: number;
  cost?: number;
  requests?: number;
  model?: string;
};

/** Collaboration tree agent row (Main / Worker). */
export type StrixAgentStatus = {
  id: string;
  name: string;
  status: string;
  parent_id?: string | null;
  task?: string;
  skills?: string[];
  pending_count?: number;
  role?: string;
  current_tool?: string;
  /** Machine phase (tool_running / llm_waiting / …). */
  current_action?: string;
  /** Human-readable activity from Node (preferred). */
  current_detail?: string;
  last_tool?: string;
  /** Product expert id for Case multi-role roster. */
  expert_id?: string;
  pack_id?: string;
  /**
   * Spec #354: Participant Session *instance* id on this Case.
   * Renewed after Session Delete + same-expert re-entry. Distinct from
   * expert_id (catalog identity). Shown in collab chrome.
   */
  session_id?: string;
  /** Currently sticky / active speaker role. */
  highlighted?: boolean;
  /** Spec #278: Session actual harness (not composer intent). */
  work_mode?: "free" | "graph" | string;
  graph_id?: string;
  graph_label?: string;
  /** Spec #324 D1: Participant or Sub cumulative usage (platform rollup). */
  usage?: AgentUsageSummary;
  /** Stable metered/configured model id for this seat (not marketing names). */
  model?: string;
};
