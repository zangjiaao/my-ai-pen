/**
 * Case Status panel roster + plan_tree merge helpers (ConversationPage).
 */
import type { PlanNode, StrixAgentStatus } from "./panelTypes";

export type { PlanNode, StrixAgentStatus } from "./panelTypes";
/** @deprecated use PlanNode */
export type PlanNodeLike = PlanNode;

function readString(value: unknown): string {
  return value == null ? "" : String(value);
}

export function isStrixAgentStatus(value: unknown): value is StrixAgentStatus {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && readString((value as Record<string, unknown>).id));
}

/** True when the Status list already has a multi-role Case roster. */
export function isMultiRoleRoster(agents: StrixAgentStatus[]): boolean {
  const roots = agents.filter((a) => !a.parent_id);
  if (roots.length > 1) return true;
  return roots.some(
    (r) =>
      Boolean(r.expert_id) ||
      String(r.id || "").startsWith("role-") ||
      Boolean(r.highlighted),
  );
}

/**
 * Attach or update a subagent child under the active Case role root.
 * Node4 emits parent_id=node4-main; UI roots use role-expert:* ids.
 */
export function upsertSubagentChild(
  prev: StrixAgentStatus[],
  child: StrixAgentStatus,
  meta?: { expert_id?: string; expert_name?: string },
): StrixAgentStatus[] {
  const eid = String(meta?.expert_id || child.expert_id || "").trim();
  const ename = String(meta?.expert_name || "").trim().toLowerCase();
  let rootIdx = -1;
  if (eid) {
    rootIdx = prev.findIndex((a) => !a.parent_id && String(a.expert_id || "") === eid);
  }
  if (rootIdx < 0 && ename) {
    rootIdx = prev.findIndex((a) => !a.parent_id && String(a.name || "").toLowerCase() === ename);
  }
  if (rootIdx < 0) {
    rootIdx = prev.findIndex((a) => !a.parent_id && a.highlighted);
  }
  if (rootIdx < 0) {
    rootIdx = prev.findIndex((a) => !a.parent_id);
  }
  const root = rootIdx >= 0
    ? prev[rootIdx]!
    : {
        id: eid ? `role-expert:${eid}` : "node4-main",
        name: ename || "Expert",
        status: "running",
        parent_id: null,
        task: "",
        skills: [] as string[],
        pending_count: 0,
        role: "main",
        expert_id: eid || undefined,
        highlighted: true,
      };
  const rootId = root.id;
  const childId = child.id.startsWith(rootId) ? child.id : `${rootId}-${child.id}`;
  const nextChild: StrixAgentStatus = {
    ...child,
    id: childId,
    parent_id: rootId,
    expert_id: eid || root.expert_id,
  };
  const without = prev.filter((a) => a.id !== childId && a.id !== child.id);
  const hasRoot = without.some((a) => a.id === rootId);
  const base = hasRoot
    ? without.map((a) => (a.id === rootId ? { ...a, status: "running", highlighted: true } : a))
    : [{ ...root, status: "running", highlighted: true }, ...without];
  return [...base, nextChild];
}

/**
 * Merge a live single-burst panel_agents payload into an existing Case roster.
 * Replaces only when the previous list is single-role / empty.
 */
export function mergeLivePanelAgents(
  prev: StrixAgentStatus[],
  panel: StrixAgentStatus[],
  meta?: { expert_id?: string; expert_name?: string },
): StrixAgentStatus[] {
  if (!panel.length) return prev;
  if (!prev.length || !isMultiRoleRoster(prev)) return panel;

  const eid = String(meta?.expert_id || "").trim();
  const ename = String(meta?.expert_name || "").trim().toLowerCase();
  const panelMain = panel.find((a) => !a.parent_id) || panel[0]!;
  const panelChildren = panel.filter((a) => a.parent_id);

  let rootIdx = -1;
  if (eid) {
    rootIdx = prev.findIndex((a) => !a.parent_id && String(a.expert_id || "") === eid);
  }
  if (rootIdx < 0 && ename) {
    rootIdx = prev.findIndex((a) => !a.parent_id && String(a.name || "").toLowerCase() === ename);
  }
  if (rootIdx < 0) {
    rootIdx = prev.findIndex((a) => !a.parent_id && a.highlighted);
  }
  if (rootIdx < 0) {
    rootIdx = prev.findIndex((a) => !a.parent_id && String(a.status || "").toLowerCase() === "running");
  }
  if (rootIdx < 0) {
    rootIdx = prev.findIndex((a) => !a.parent_id);
  }
  if (rootIdx < 0) return panel;

  const root = prev[rootIdx]!;
  const rootId = root.id;
  const withoutRootAndKids = prev.filter(
    (a) => a.id !== rootId && a.parent_id !== rootId && !(a.parent_id && String(a.parent_id) === rootId),
  );
  // Also drop legacy single-main children that belonged to this burst id.
  const cleaned = withoutRootAndKids.filter((a) => {
    if (a.parent_id && panel.some((p) => p.id === a.id)) return false;
    return true;
  });

  const nextRoot: StrixAgentStatus = {
    ...root,
    status: panelMain.status || "running",
    current_tool: panelMain.current_tool || root.current_tool,
    current_action: panelMain.current_action || root.current_action,
    current_detail: panelMain.current_detail || root.current_detail,
    last_tool: panelMain.last_tool || root.last_tool,
    highlighted: true,
    expert_id: eid || root.expert_id,
  };
  const nextKids = panelChildren.map((child) => ({
    ...child,
    parent_id: rootId,
    id: child.id.startsWith(rootId) ? child.id : `${rootId}-${child.id}`,
    expert_id: eid || root.expert_id,
  }));
  // Clear highlight on other roots.
  const others = cleaned.map((a) =>
    !a.parent_id ? { ...a, highlighted: false } : a,
  );
  return [nextRoot, ...others, ...nextKids];
}

/** Patch active role root from live status_update (tool / LLM phase). */
export function patchMainAgentActivity(
  prev: StrixAgentStatus[],
  input: {
    phase?: string;
    activeTool?: string;
    currentDetail?: string;
    running?: boolean;
    expert_id?: string;
    expert_name?: string;
  },
): StrixAgentStatus[] {
  const phase = String(input.phase || "").trim();
  const tool = input.activeTool != null ? String(input.activeTool) : undefined;
  const detail = input.currentDetail != null ? String(input.currentDetail).trim() : "";
  const eid = String(input.expert_id || "").trim();
  const ename = String(input.expert_name || "").trim().toLowerCase();

  let mainIdx = -1;
  if (eid) {
    mainIdx = prev.findIndex((a) => !a.parent_id && String(a.expert_id || "") === eid);
  }
  if (mainIdx < 0 && ename) {
    mainIdx = prev.findIndex((a) => !a.parent_id && String(a.name || "").toLowerCase() === ename);
  }
  if (mainIdx < 0) {
    mainIdx = prev.findIndex((a) => !a.parent_id && a.highlighted);
  }
  if (mainIdx < 0) {
    mainIdx = prev.findIndex(
      (a) => a.id === "node4-main" || a.id === "node2-main" || (!a.parent_id && a.role === "main"),
    );
  }
  if (mainIdx < 0) {
    mainIdx = prev.findIndex((a) => !a.parent_id);
  }
  const base: StrixAgentStatus =
    mainIdx >= 0
      ? prev[mainIdx]!
      : {
          id: "node4-main",
          name: input.expert_name || "Agent",
          status: "running",
          parent_id: null,
          task: "",
          skills: [],
          pending_count: 0,
          role: "main",
          expert_id: eid || undefined,
        };
  const lastTool =
    tool && tool.length > 0 ? tool : String(base.last_tool || base.current_tool || "").trim();
  const next: StrixAgentStatus = {
    ...base,
    status: input.running === false ? base.status : "running",
    parent_id: null,
    role: base.role || "main",
    expert_id: eid || base.expert_id,
    highlighted: true,
    current_tool: tool !== undefined ? tool : base.current_tool,
    current_action: phase || base.current_action || "running",
    last_tool: lastTool || base.last_tool,
    current_detail:
      detail ||
      (phase === "tool_running" && tool
        ? `正在调用 ${tool}`
        : phase === "llm_waiting"
          ? lastTool
            ? `分析「${lastTool}」结果，规划下一步`
            : "等待模型思考与回复"
          : base.current_detail),
  };
  if (mainIdx < 0) return [next, ...prev];
  return prev.map((a, i) => {
    if (i === mainIdx) return next;
    if (!a.parent_id && a.highlighted) return { ...a, highlighted: false };
    return a;
  });
}

/** Expert Graph L1 stages from Hard Graph plan projection. */
export function countGraphStagePhases(nodes: PlanNode[]): number {
  return nodes.filter((n) => {
    const id = String(n.node_id || n.id || "");
    const level = String(n.level || "");
    const kind = String(n.kind || "");
    return id.startsWith("graph-stage-") || ((level === "phase" || kind === "phase") && String(n.source || "") === "plan");
  }).length;
}

/**
 * Prefer the tree that still has Graph L1 structure when a snapshot refresh
 * would otherwise flatten Tasks (work_items only).
 */
export function preferRicherPlanTree(prev: PlanNode[], next: PlanNode[]): PlanNode[] {
  if (!prev.length) return next;
  if (!next.length) return prev;
  const prevStages = countGraphStagePhases(prev);
  const nextStages = countGraphStagePhases(next);
  if (prevStages > 0 && nextStages === 0) return prev;
  // Same Graph map: prefer larger node count (includes L2 todos) when stages match.
  if (prevStages > 0 && nextStages > 0 && next.length < prev.length && nextStages === prevStages) {
    // Allow growth/shrink of L2 under same L1 — still take next if it has stages
    // (live updates should win when structured).
    return next;
  }
  return next;
}

/** Merge plan trees by owner so multi-role Case Tasks keep both sides. */
/**
 * Merge live plan_tree_updated into Case Tasks.
 * Drop unowned nodes when the same node_id already has an owner (checkpoint vs participant).
 * When an owner re-publishes, replace that owner's previous nodes only.
 */
export function mergePlanTreeByOwner(prev: PlanNode[], incoming: PlanNode[]): PlanNode[] {
  if (!incoming.length) return prev;
  if (!prev.length) return dedupePlanTreePreferOwner(incoming);

  const ownerKey = (node: PlanNode) =>
    String(node.owner_expert_id || node.owner_expert_name || "").trim();
  const nodeId = (node: PlanNode) =>
    String(node.node_id || node.id || node.title || "").trim();
  const incomingOwners = new Set(incoming.map(ownerKey).filter(Boolean));

  // No owner on either side → classic replace (single-agent path).
  if (incomingOwners.size === 0 && !prev.some((n) => ownerKey(n))) {
    return dedupePlanTreePreferOwner(incoming);
  }

  const kept = prev.filter((node) => {
    const owner = ownerKey(node);
    if (!owner) {
      // Drop unowned prev when any owned tree is present (or incoming is owned).
      return incomingOwners.size === 0 && !prev.some((n) => ownerKey(n));
    }
    // Drop previous nodes for owners that just re-published a full tree.
    return !incomingOwners.has(owner);
  });
  return dedupePlanTreePreferOwner([...kept, ...incoming]);
}

/** Prefer owned rows when the same node_id appears with and without owner. */
export function dedupePlanTreePreferOwner(nodes: PlanNode[]): PlanNode[] {
  const ownedNids = new Set<string>();
  for (const n of nodes) {
    const owner = String(n.owner_expert_id || n.owner_expert_name || "").trim();
    const nid = String(n.node_id || n.id || n.title || "").trim();
    if (owner && nid) ownedNids.add(nid);
  }
  const out: PlanNode[] = [];
  const seenOwnerKey = new Set<string>();
  const seenUnownedNid = new Set<string>();
  for (const n of nodes) {
    const owner = String(n.owner_expert_id || n.owner_expert_name || "").trim();
    const nid = String(n.node_id || n.id || n.title || "").trim();
    if (!nid) continue;
    if (owner) {
      const key = `${owner}:${nid}`;
      if (seenOwnerKey.has(key)) continue;
      seenOwnerKey.add(key);
      out.push(n);
      continue;
    }
    if (ownedNids.has(nid) || seenUnownedNid.has(nid)) continue;
    seenUnownedNid.add(nid);
    out.push(n);
  }
  return out;
}

/** Ensure main agent row exists, then upsert a worker child for live collaboration tree. */
export function upsertWorkerAgent(prev: StrixAgentStatus[], worker: StrixAgentStatus): StrixAgentStatus[] {
  const main: StrixAgentStatus = prev.find((a) => a.id === "node2-main" || a.id === "node4-main" || a.role === "main") || {
    id: "node4-main",
    name: "Main Agent",
    status: "running",
    parent_id: null,
    task: "",
    skills: [],
    pending_count: 0,
    role: "main",
    current_tool: "",
    current_action: "running",
  };
  const others = prev.filter((a) => a.id !== main.id && a.id !== worker.id);
  return [
    { ...main, status: main.status === "completed" ? "running" : main.status || "running", parent_id: null },
    ...others,
    { ...worker, parent_id: "node2-main" },
  ];
}

