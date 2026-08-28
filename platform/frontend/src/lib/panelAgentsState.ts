/**
 * Case Status panel roster + plan_tree merge helpers (ConversationPage).
 */
import type { PlanNode, StrixAgentStatus } from "./panelTypes";
import { ENGAGEMENT_TEMPLATES } from "./experts";

export type { PlanNode, StrixAgentStatus } from "./panelTypes";
/** @deprecated use PlanNode */
export type PlanNodeLike = PlanNode;

function readString(value: unknown): string {
  return value == null ? "" : String(value);
}

export function isStrixAgentStatus(value: unknown): value is StrixAgentStatus {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && readString((value as Record<string, unknown>).id));
}

/** Spec #491: End Worker — keep the collab-tree row, stamp released (grey light). */
export function isReleasedWorkerId(agentId: string, releasedIds: readonly string[]): boolean {
  const aid = String(agentId || "").trim();
  if (!aid) return false;
  for (const raw of releasedIds) {
    const rid = String(raw || "").trim();
    if (!rid) continue;
    if (aid === rid || aid.endsWith(`-${rid}`) || rid.endsWith(`-${aid}`)) return true;
  }
  return false;
}

function stampReleasedRow(agent: StrixAgentStatus): StrixAgentStatus {
  if (agent.status === "released") return agent;
  return { ...agent, status: "released", current_action: "released" };
}

/** Keep released Workers on the tree; do not resurrect them as running. */
export function applyReleasedWorkerStatus(
  agents: StrixAgentStatus[],
  releasedIds: readonly string[],
): StrixAgentStatus[] {
  if (!releasedIds.length) return agents;
  return agents.map((agent) => {
    if (!agent.parent_id) return agent;
    return isReleasedWorkerId(agent.id, releasedIds) ? stampReleasedRow(agent) : agent;
  });
}

/** @deprecated use applyReleasedWorkerStatus — End greys the row instead of dropping it. */
export function omitReleasedWorkers(
  agents: StrixAgentStatus[],
  releasedIds: readonly string[],
): StrixAgentStatus[] {
  return applyReleasedWorkerStatus(agents, releasedIds);
}

/**
 * Snapshot replace must not resurrect a released Worker as running, and must not
 * drop a released row just because a thin snapshot omitted it.
 * Empty `next` remains authoritative (Session Delete).
 */
export function mergeAgentsKeepingReleased(
  prev: StrixAgentStatus[],
  next: StrixAgentStatus[],
  releasedIds: readonly string[],
): StrixAgentStatus[] {
  if (!next.length) return next;
  const stamped = applyReleasedWorkerStatus(next, releasedIds);
  if (!releasedIds.length) return stamped;
  const extras: StrixAgentStatus[] = [];
  for (const row of prev) {
    if (!row.parent_id) continue;
    if (!isReleasedWorkerId(row.id, releasedIds)) continue;
    const already = stamped.some(
      (a) => a.id === row.id || isReleasedWorkerId(a.id, [row.id]) || isReleasedWorkerId(row.id, [a.id]),
    );
    if (!already) extras.push(stampReleasedRow(row));
  }
  return extras.length ? [...stamped, ...extras] : stamped;
}

export function markPanelWorkerReleased(agents: StrixAgentStatus[], agentId: string): StrixAgentStatus[] {
  const id = String(agentId || "").trim();
  if (!id) return agents;
  return applyReleasedWorkerStatus(agents, [id]);
}

/**
 * Spec #278 S4: AgentRow badge from Session actual work_mode (not composer).
 * Pure helper — Free or short Graph label.
 */
export function formatAgentWorkModeBadge(agent: Pick<
  StrixAgentStatus,
  "work_mode" | "graph_id" | "graph_label"
>): string | null {
  const mode = String(agent.work_mode || "").trim().toLowerCase();
  if (!mode) return null;
  if (mode === "free") return "Free";
  if (mode === "graph" || mode.startsWith("hard_graph") || mode.startsWith("graph")) {
    const label = String(agent.graph_label || "").trim();
    if (label) {
      if (/应用/.test(label) && /评估|安全/.test(label)) return "应用评估";
      if (/红队/.test(label)) return "红队深度";
      return label.length > 12 ? `${label.slice(0, 11)}…` : label;
    }
    const gid = String(agent.graph_id || "").trim().toLowerCase();
    const known = ENGAGEMENT_TEMPLATES.find((t) => t.id === gid);
    if (known) return known.label;
    // hard_graph:app_assessment:stage → extract id
    const m = mode.match(/hard_graph:([a-z0-9_]+)/i);
    if (m?.[1]) {
      const fromMode = ENGAGEMENT_TEMPLATES.find((t) => t.id === m[1]);
      if (fromMode) return fromMode.label;
    }
    if (gid) return gid;
    return "Graph";
  }
  return null;
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

/** Index of the active Case role root (expert → name → highlight → running → first). */
function findRoleRootIndex(
  agents: StrixAgentStatus[],
  meta?: { expert_id?: string; expert_name?: string },
): number {
  const eid = String(meta?.expert_id || "").trim();
  const ename = String(meta?.expert_name || "").trim().toLowerCase();
  let idx = -1;
  if (eid) {
    idx = agents.findIndex((a) => !a.parent_id && String(a.expert_id || "") === eid);
  }
  if (idx < 0 && ename) {
    idx = agents.findIndex((a) => !a.parent_id && String(a.name || "").toLowerCase() === ename);
  }
  if (idx < 0) {
    idx = agents.findIndex((a) => !a.parent_id && a.highlighted);
  }
  if (idx < 0) {
    idx = agents.findIndex(
      (a) => !a.parent_id && String(a.status || "").toLowerCase() === "running",
    );
  }
  if (idx < 0) {
    idx = agents.findIndex((a) => !a.parent_id);
  }
  return idx;
}

function isChildOfRoot(agent: StrixAgentStatus, rootId: string): boolean {
  return agent.parent_id === rootId || String(agent.parent_id || "") === rootId;
}

/** In-agent / hop-in-flight statuses that must pulse blue, not idle green. */
export function isInFlightPanelStatus(status: string | undefined | null): boolean {
  const s = String(status || "")
    .trim()
    .toLowerCase();
  return (
    s === "running" ||
    s === "tool_running" ||
    s === "llm_waiting" ||
    s === "llm_stalled" ||
    s === "working" ||
    s === "chat" ||
    s === "starting"
  );
}

function isSettledPanelStatus(status: string | undefined | null): boolean {
  const s = String(status || "")
    .trim()
    .toLowerCase();
  return s === "completed" || s === "done" || s === "finished" || s === "success" || s === "idle" || !s;
}

/** Match live `role-…-feedback` against a snapshot row still keyed `feedback`. */
function findPriorPanelChild(
  prev: StrixAgentStatus[],
  row: StrixAgentStatus,
): StrixAgentStatus | null {
  const id = String(row.id || "").trim();
  if (!id) return null;
  const direct = prev.find((a) => a.parent_id && a.id === id);
  if (direct) return direct;
  const suffixed = prev.find(
    (a) =>
      Boolean(a.parent_id) &&
      (a.id.endsWith(`-${id}`) || id.endsWith(`-${a.id}`)),
  );
  if (suffixed) return suffixed;
  const name = String(row.name || "")
    .trim()
    .toLowerCase();
  if (name === "feedback") {
    return (
      prev.find(
        (a) =>
          Boolean(a.parent_id) &&
          String(a.name || "")
            .trim()
            .toLowerCase() === "feedback",
      ) || null
    );
  }
  return null;
}

/**
 * Snapshot replace for collab tree: keep Session harness fields (work_mode / graph_* /
 * session_id) when the snapshot row is thinner than the live row.
 * Prevents Free/Graph badge flash-off during mid-stream refreshConversationState.
 *
 * Empty `next` is authoritative (Session Delete / empty Case) — do not resurrect prev.
 * Prefer snapshot session_id when present so Reset-projected new pi ids win over stale live.
 */
export function mergeSnapshotAgentsPreserveHarness(
  prev: StrixAgentStatus[],
  next: StrixAgentStatus[],
): StrixAgentStatus[] {
  // Empty snapshot is product truth (e.g. last Session Delete), not "mid-stream thin".
  if (!next.length) return next;
  if (!prev.length) return next;
  const prevByKey = new Map<string, StrixAgentStatus>();
  for (const a of prev) {
    const k = String(a.expert_id || a.id || "").trim();
    if (k) prevByKey.set(k, a);
    prevByKey.set(a.id, a);
  }
  const sidOk = (s: string) =>
    Boolean(s) && !s.startsWith("expert:") && !s.startsWith("pack:");
  return next.map((row) => {
    const prior = row.parent_id
      ? findPriorPanelChild(prev, row)
      : prevByKey.get(String(row.expert_id || "").trim()) ||
        prevByKey.get(row.id) ||
        null;
    // 2s snapshot poll must not paint Feedback/Worker green while a live hop is running.
    if (row.parent_id && prior && isInFlightPanelStatus(prior.status) && isSettledPanelStatus(row.status)) {
      return {
        ...row,
        status: prior.status,
        current_action: prior.current_action || row.current_action,
        current_detail: prior.current_detail || row.current_detail,
      };
    }
    if (!prior || row.parent_id) return row;
    const liveWm = String(row.work_mode || "").trim();
    const priorWm = String(prior.work_mode || "").trim();
    const work_mode = liveWm || priorWm || undefined;
    const liveSid = String(row.session_id || "").trim();
    const priorSid = String(prior.session_id || "").trim();
    // Authoritative snapshot id wins (Reset / new Agent). Only fill gap from live.
    const session_id =
      (sidOk(liveSid) ? liveSid : "") || (sidOk(priorSid) ? priorSid : "") || undefined;
    const snapTokens = Number(row.usage?.total_tokens || 0);
    const snapRequests = Number(row.usage?.requests || 0);
    const usage =
      snapTokens > 0 || snapRequests > 0 ? row.usage : prior.usage || row.usage;
    const model =
      String(row.model || row.usage?.model || prior.model || prior.usage?.model || "").trim() ||
      undefined;
    return {
      ...row,
      ...(work_mode
        ? {
            work_mode,
            graph_id:
              String(work_mode).toLowerCase() === "free"
                ? undefined
                : row.graph_id || prior.graph_id,
            graph_label:
              String(work_mode).toLowerCase() === "free"
                ? undefined
                : row.graph_label || prior.graph_label,
          }
        : {}),
      ...(session_id ? { session_id } : {}),
      ...(usage ? { usage } : {}),
      ...(model ? { model } : {}),
    };
  });
}

/**
 * Merge a live single-burst panel_agents payload into an existing Case roster.
 *
 * Invariant: Subagent children under the active root are upserted by id and never
 * dropped when a new burst sends main-only. Terminal settle is backend-only.
 */
export function mergeLivePanelAgents(
  prev: StrixAgentStatus[],
  panel: StrixAgentStatus[],
  meta?: { expert_id?: string; expert_name?: string; released_ids?: readonly string[] },
): StrixAgentStatus[] {
  const released = Array.isArray(meta?.released_ids) ? [...meta.released_ids] : [];
  prev = applyReleasedWorkerStatus(prev, released);
  panel = applyReleasedWorkerStatus(panel, released);
  if (!panel.length) return prev;
  if (!prev.length) return panel;

  const eid = String(meta?.expert_id || "").trim();
  const panelMain = panel.find((a) => !a.parent_id) || panel[0]!;
  const panelChildren = panel.filter((a) => a.parent_id);
  const rootIdx = findRoleRootIndex(prev, meta);
  if (rootIdx < 0) return panel;

  const root = prev[rootIdx]!;
  const rootId = root.id;
  const prevKids = prev.filter((a) => isChildOfRoot(a, rootId));
  const others = prev
    .filter((a) => a.id !== rootId && !isChildOfRoot(a, rootId))
    // Drop legacy bare child ids that this panel re-introduces under the role root.
    .filter(
      (a) =>
        !(
          a.parent_id &&
          panel.some((p) => p.id === a.id || `${rootId}-${p.id}` === a.id)
        ),
    )
    .map((a) => (!a.parent_id ? { ...a, highlighted: false } : a));

  // pi Agent.sessionId: prefer live panel stamp; never drop a known id when panel omits it.
  const liveSessionId = String(panelMain.session_id || "").trim();
  const prevSessionId = String(root.session_id || "").trim();
  const sessionId =
    (liveSessionId && !liveSessionId.startsWith("expert:") && !liveSessionId.startsWith("pack:")
      ? liveSessionId
      : "") ||
    (prevSessionId && !prevSessionId.startsWith("expert:") && !prevSessionId.startsWith("pack:")
      ? prevSessionId
      : "");
  // Spec #278: work_mode is Session harness — never drop Free/Graph when a live
  // panel tick omits it (status/stream panels used to flash the badge on/off).
  const liveWm = String(panelMain.work_mode || "").trim().toLowerCase();
  const prevWm = String(root.work_mode || "").trim().toLowerCase();
  let workMode: string | undefined;
  let graphId = root.graph_id;
  let graphLabel = root.graph_label;
  if (liveWm === "free") {
    workMode = "free";
    graphId = undefined;
    graphLabel = undefined;
  } else if (liveWm === "graph" || liveWm.startsWith("hard_graph")) {
    workMode = "graph";
    graphId = panelMain.graph_id || root.graph_id;
    graphLabel = panelMain.graph_label || root.graph_label;
  } else if (prevWm === "free" || prevWm === "graph" || prevWm.startsWith("hard_graph")) {
    workMode = prevWm === "free" ? "free" : "graph";
  }
  const nextRoot: StrixAgentStatus = {
    ...root,
    status: panelMain.status || root.status || "running",
    current_tool: panelMain.current_tool || root.current_tool,
    current_action: panelMain.current_action || root.current_action,
    current_detail: panelMain.current_detail || root.current_detail,
    last_tool: panelMain.last_tool || root.last_tool,
    highlighted: true,
    expert_id: eid || root.expert_id || panelMain.expert_id,
    // Live Node panel is burst-scoped; keep Case cumulative meters from the roster.
    model: String(panelMain.model || root.model || "").trim() || undefined,
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(workMode
      ? {
          work_mode: workMode,
          graph_id: workMode === "graph" ? graphId : undefined,
          graph_label: workMode === "graph" ? graphLabel : undefined,
        }
      : {}),
  };
  const nextKids = mergePanelChildren(
    prevKids,
    panelChildren,
    rootId,
    eid || nextRoot.expert_id,
  );
  return applyReleasedWorkerStatus([nextRoot, ...others, ...nextKids], released);
}

/**
 * Upsert live kids by normalized id; keep prior Subagents missing from this burst.
 * Does not invent terminal status — that is case_participants.merge_panel_agents.
 */
function mergePanelChildren(
  prevKids: StrixAgentStatus[],
  panelChildren: StrixAgentStatus[],
  rootId: string,
  expertId?: string,
): StrixAgentStatus[] {
  const normalizeId = (child: StrixAgentStatus) =>
    child.id.startsWith(rootId) ? child.id : `${rootId}-${child.id}`;

  const byId = new Map<string, StrixAgentStatus>();
  for (const kid of prevKids) {
    byId.set(kid.id, { ...kid, parent_id: rootId });
  }
  for (const child of panelChildren) {
    const id = normalizeId(child);
    byId.set(id, {
      ...child,
      id,
      parent_id: rootId,
      expert_id: expertId || child.expert_id,
    });
  }

  const out: StrixAgentStatus[] = [];
  const seen = new Set<string>();
  for (const kid of prevKids) {
    const row = byId.get(kid.id);
    if (row && !seen.has(row.id)) {
      out.push(row);
      seen.add(row.id);
    }
  }
  for (const child of panelChildren) {
    const id = normalizeId(child);
    const row = byId.get(id);
    if (row && !seen.has(id)) {
      out.push(row);
      seen.add(id);
    }
  }
  return out;
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
 * Legacy FE archaeology used `plan-phase-intake|recon|…` nodes synthesized from
 * status phase labels (not Expert Graph L1 / agent todo). Those must never paint
 * Tasks for Default/assistant chat, and must not stick after a real empty snapshot.
 */
export function isLegacySyntheticPhasePlan(nodes: PlanNode[]): boolean {
  if (!nodes.length) return false;
  return nodes.every((n) => {
    const id = String(n.node_id || n.id || "").trim();
    return id.startsWith("plan-phase-");
  });
}

/**
 * Prefer the tree that still has Graph L1 structure when a snapshot refresh
 * would otherwise flatten Tasks (work_items only).
 * Never preserve legacy synthetic phase lists when next is empty/real.
 */
export function preferRicherPlanTree(prev: PlanNode[], next: PlanNode[]): PlanNode[] {
  // Incoming archaeology shells must never paint — including the first snapshot
  // of a brand-new Case (prev is empty; old code returned `next` as-is).
  if (isLegacySyntheticPhasePlan(next)) next = [];
  if (!prev.length) return next;
  if (!next.length) {
    // Empty authoritative snapshot: drop archaeology-only fake phases; keep live Graph.
    if (isLegacySyntheticPhasePlan(prev)) return [];
    return prev;
  }
  // Real plan must win over leftover synthetic phase shells.
  if (isLegacySyntheticPhasePlan(prev) && !isLegacySyntheticPhasePlan(next)) return next;
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
export function mergePlanTreeByOwner(
  prev: PlanNode[],
  incoming: PlanNode[],
  ownerHint?: { owner_expert_id?: string; owner_expert_name?: string },
): PlanNode[] {
  const ownerKey = (node: PlanNode) =>
    String(node.owner_expert_id || node.owner_expert_name || "").trim();
  if (!incoming.length) {
    const hint = String(
      ownerHint?.owner_expert_id || ownerHint?.owner_expert_name || "",
    ).trim();
    if (hint) {
      const aliases = new Set(
        [hint, String(ownerHint?.owner_expert_id || "").trim(), String(ownerHint?.owner_expert_name || "").trim()].filter(
          Boolean,
        ),
      );
      return prev.filter((node) => {
        const owner = ownerKey(node);
        if (!owner) return false;
        return !aliases.has(owner);
      });
    }
    const owners = new Set(prev.map(ownerKey).filter(Boolean));
    // Unowned or single-role tree: empty is a full replace (Case d84fb991 ghost chip).
    if (owners.size <= 1) return [];
    return prev;
  }
  if (!prev.length) return dedupePlanTreePreferOwner(incoming);

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

