/**
 * Pure Case roster merge helpers — no vitest; run with:
 *   npx tsx src/lib/panelAgentsState.test.ts
 */
import {
  formatAgentWorkModeBadge,
  isLegacySyntheticPhasePlan,
  markPanelWorkerReleased,
  mergeLivePanelAgents,
  mergePlanTreeByOwner,
  mergeSnapshotAgentsPreserveHarness,
  preferRicherPlanTree,
  type StrixAgentStatus,
} from "./panelAgentsState";
import type { PlanNode } from "./panelTypes";

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

{
  // Snapshot refresh must not strip Free badge / session_id mid-stream.
  const prev = [
    {
      id: "role-expert:e1",
      name: "渗透大师",
      status: "running",
      expert_id: "e1",
      work_mode: "free" as const,
      session_id: "pi-sid-keep",
    },
  ];
  const snap = [
    {
      id: "role-expert:e1",
      name: "渗透大师",
      status: "running",
      expert_id: "e1",
      // no work_mode / session_id (historical snapshot thin projection)
    },
  ];
  const merged = mergeSnapshotAgentsPreserveHarness(prev, snap);
  assert(merged[0]!.work_mode === "free", "preserve free work_mode");
  assert(merged[0]!.session_id === "pi-sid-keep", "preserve pi session_id");
  // Empty snapshot is authoritative (Session Delete) — do not resurrect prev.
  const empty = mergeSnapshotAgentsPreserveHarness(prev, []);
  assert(empty.length === 0, "empty next clears collab tree");
  // Snapshot with new Reset id wins over prior live id.
  const afterReset = mergeSnapshotAgentsPreserveHarness(prev, [
    {
      id: "role-expert:e1",
      name: "渗透大师",
      status: "idle",
      expert_id: "e1",
      work_mode: "free",
      session_id: "pi-sid-new-after-reset",
    },
  ]);
  assert(afterReset[0]!.session_id === "pi-sid-new-after-reset", "reset id wins");
  console.log("ok: mergeSnapshotAgentsPreserveHarness keeps harness fields");
}

{
  // Thin mid-thinking snapshot must not flash off Case cumulative meters.
  const prev = [
    {
      id: "role-expert:e1",
      name: "渗透大师",
      status: "running",
      expert_id: "e1",
      usage: { total_tokens: 202000, requests: 10, model: "deepseek-v4-flash" },
      model: "deepseek-v4-flash",
    },
  ];
  const thin = [
    {
      id: "role-expert:e1",
      name: "渗透大师",
      status: "running",
      expert_id: "e1",
      usage: { total_tokens: 0, requests: 0 },
    },
  ];
  const merged = mergeSnapshotAgentsPreserveHarness(prev, thin);
  assert(merged[0]!.usage?.total_tokens === 202000, "keep prior tokens when snap is zero");
  assert(merged[0]!.usage?.requests === 10, "keep prior requests when snap is zero");
  assert(merged[0]!.model === "deepseek-v4-flash", "keep prior model when snap omits it");
  console.log("ok: mergeSnapshotAgentsPreserveHarness keeps usage meters");
}

{
  // Live panel may stamp configured model before first message_end; keep Case meters.
  const prev = [
    {
      ...main,
      usage: { total_tokens: 202000, requests: 10 },
    },
  ];
  const live = [
    {
      id: "node4-main",
      name: "渗透大师",
      status: "running",
      parent_id: null,
      task: "",
      skills: [],
      pending_count: 0,
      role: "main",
      model: "deepseek-v4-flash",
    },
  ];
  const merged = mergeLivePanelAgents(prev, live, { expert_id: "e2" });
  assert(merged[0]!.model === "deepseek-v4-flash", "live configured model stamps onto Main");
  assert(merged[0]!.usage?.total_tokens === 202000, "live panel must not clobber Case usage");
  console.log("ok: mergeLivePanelAgents stamps model without wiping usage");
}

{
  // Synthetic archaeology plan-phase-* must not stick as Tasks for Default chat.
  const synthetic: PlanNode[] = [
    {
      node_id: "plan-phase-intake",
      title: "目标与授权范围检查",
      kind: "phase",
      level: "phase",
      status: "running",
      priority: 0,
    },
    {
      node_id: "plan-phase-recon",
      title: "攻击面发现",
      kind: "phase",
      level: "phase",
      status: "pending",
      priority: 100,
    },
  ];
  assert(isLegacySyntheticPhasePlan(synthetic), "synthetic plan detected");
  assert(
    preferRicherPlanTree([], synthetic).length === 0,
    "first snapshot must not paint synthetic plan-phase list",
  );
  assert(
    preferRicherPlanTree(synthetic, []).length === 0,
    "empty snapshot drops synthetic plan-phase list",
  );
  const realGraph: PlanNode[] = [
    {
      node_id: "graph-stage-init",
      title: "init",
      kind: "phase",
      level: "phase",
      status: "running",
      source: "plan",
      priority: 100,
    },
  ];
  assert(
    preferRicherPlanTree(realGraph, []).length === 1,
    "empty snapshot keeps real Graph L1",
  );
  assert(
    preferRicherPlanTree(synthetic, realGraph)[0]?.node_id === "graph-stage-init",
    "real Graph wins over leftover synthetic shells",
  );
  console.log("ok: legacy synthetic plan_tree hygiene");
}

{
  const marked = markPanelWorkerReleased(
    [main, sub1, { ...sub1, id: "role-expert:e2-sub_10", name: "Worker 10", status: "idle" }],
    "sub_1",
  );
  assert(marked.length === 2, "released worker dropped from collab tree");
  assert(marked.every((a) => a.id !== sub1.id && !a.id.endsWith("-sub_1")), "sub_1 gone");
  assert(marked.some((a) => a.id === "role-expert:e2-sub_10"), "sub_10 untouched");
  console.log("ok: markPanelWorkerReleased suffix");
}

{
  const ping4: PlanNode = {
    node_id: "pkg-sub_10",
    title: "回复 ping4",
    status: "running",
    kind: "task",
    level: "work_item",
    owner_expert_id: "e1",
    owner_expert_name: "渗透大师",
  };
  const keptGhost = mergePlanTreeByOwner([ping4], []);
  assert(keptGhost.length === 0, "empty plan_tree must not leave a running ghost chip");
  const ownerClear = mergePlanTreeByOwner(
    [ping4, { ...ping4, node_id: "other-role", owner_expert_id: "e2", title: "other" }],
    [],
    { owner_expert_id: "e1" },
  );
  assert(ownerClear.length === 1, "empty from one expert drops only that expert");
  assert(ownerClear[0]?.node_id === "other-role", "other role Tasks remain");
  const doneKeep = mergePlanTreeByOwner([ping4], [{ ...ping4, status: "done" }]);
  assert(doneKeep[0]?.status === "done", "done republish replaces running");
  console.log("ok: mergePlanTreeByOwner empty is authoritative");
}

console.log("panelAgentsState.test.ts: all passed");
