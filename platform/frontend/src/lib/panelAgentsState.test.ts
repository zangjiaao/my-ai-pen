/**
 * Pure Case roster merge helpers — no vitest; run with:
 *   npx tsx src/lib/panelAgentsState.test.ts
 */
import {
  formatAgentWorkModeBadge,
  mergeLivePanelAgents,
  type StrixAgentStatus,
} from "./panelAgentsState";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const main: StrixAgentStatus = {
  id: "role-expert:e2",
  name: "渗透大师",
  status: "idle",
  parent_id: null,
  task: "",
  skills: [],
  pending_count: 0,
  role: "main",
  expert_id: "e2",
  highlighted: true,
};

const sub1: StrixAgentStatus = {
  id: "role-expert:e2-sub_1",
  name: "Worker 1",
  status: "completed",
  parent_id: "role-expert:e2",
  task: "probe API",
  skills: [],
  pending_count: 0,
  role: "subagent",
  expert_id: "e2",
};

// Re-chat: live panel is main-only under node4-main id.
const liveMainOnly: StrixAgentStatus[] = [
  {
    id: "node4-main",
    name: "渗透大师",
    status: "running",
    parent_id: null,
    task: "",
    skills: [],
    pending_count: 0,
    role: "main",
    current_action: "chat",
    current_detail: "对话中，准备回复",
  },
];

{
  const merged = mergeLivePanelAgents([main, sub1], liveMainOnly, {
    expert_id: "e2",
    expert_name: "渗透大师",
  });
  const kids = merged.filter((a) => a.parent_id);
  assert(kids.length === 1, `expected prior subagent kept, got ${JSON.stringify(kids)}`);
  assert(kids[0]!.name === "Worker 1", "Worker 1 name");
  assert(kids[0]!.status === "completed", "FE must not invent terminal status on orphan");
  assert(kids[0]!.task === "probe API", "task preserved");
  const root = merged.find((a) => !a.parent_id && a.expert_id === "e2");
  assert(root?.status === "running", "root running after re-chat");
  console.log("ok: mergeLivePanelAgents keeps prior subagent on main-only re-chat");
}

{
  // Single-role (no expert_id / role- root) also preserves kids.
  const bareMain: StrixAgentStatus = {
    id: "node4-main",
    name: "Expert",
    status: "idle",
    parent_id: null,
    task: "",
    skills: [],
    pending_count: 0,
    role: "main",
  };
  const bareKid: StrixAgentStatus = {
    id: "sub_1",
    name: "Worker 1",
    status: "completed",
    parent_id: "node4-main",
    task: "old",
    skills: [],
    pending_count: 0,
    role: "subagent",
  };
  const merged = mergeLivePanelAgents([bareMain, bareKid], liveMainOnly);
  assert(merged.filter((a) => a.parent_id).length === 1, "single-role keeps kid");
  console.log("ok: single-role path keeps prior subagent");
}

{
  const liveWithNew: StrixAgentStatus[] = [
    ...liveMainOnly,
    {
      id: "sub_2",
      name: "Worker 2",
      status: "running",
      parent_id: "node4-main",
      task: "new work",
      skills: [],
      pending_count: 0,
      role: "subagent",
    },
  ];
  const merged = mergeLivePanelAgents([main, sub1], liveWithNew, { expert_id: "e2" });
  const kids = merged.filter((a) => a.parent_id);
  assert(kids.length === 2, `expected 2 kids, got ${kids.length}`);
  assert(
    kids.some((k) => k.name === "Worker 1") && kids.some((k) => k.name === "Worker 2"),
    "both workers present",
  );
  console.log("ok: mergeLivePanelAgents appends new subagent without dropping old");
}

{
  // Spec #278 S4: work mode badge labels
  assert(formatAgentWorkModeBadge({ work_mode: "free" }) === "Free", "free badge");
  assert(
    formatAgentWorkModeBadge({ work_mode: "graph", graph_id: "app_assessment" }) === "应用评估",
    "app_assessment badge",
  );
  assert(
    formatAgentWorkModeBadge({ work_mode: "graph", graph_id: "redteam_deep" }) === "红队深度",
    "redteam badge",
  );
  assert(
    formatAgentWorkModeBadge({
      work_mode: "hard_graph:app_assessment:surface",
    }) === "应用评估",
    "hard_graph work_mode string",
  );
  assert(formatAgentWorkModeBadge({}) === null, "missing mode → null");
  console.log("ok: formatAgentWorkModeBadge");
}

console.log("panelAgentsState.test.ts: all passed");
