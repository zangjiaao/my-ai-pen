import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { SecurityAsset, SecurityVulnerability } from "../lib/securityTypes";
import type { PlanNode, PlanStatus, StrixAgentStatus } from "../lib/panelTypes";
import {
  StrixAgentList,
  agentStatusCount,
  orderStrixAgents,
} from "./AgentCollaborationTree";
import { formatCaseMeteringDetail, formatCaseMeteringHeader } from "../lib/caseMetering";
import {
  SurfaceTreeView,
  attachFindingsToSurface,
  projectSurfaceEntriesFromLedger,
  ensureSurfaceLedger,
  buildSurfaceTree,
  resolveFindingSurfaceKey,
  surfaceKeyToDisplay,
  groupFindingsByKind,
  findingsTabHoverTitle,
  attackSurfaceItems,
  type SurfaceEntry,
  type SurfaceLedger,
} from "./SurfaceInventory";
import FindingCard from "./cards/FindingCard";
import { IntelList } from "./IntelList";
import type { IntelRow } from "../lib/intelView";
import { GraphAwareTodoList } from "./TasksPlanList";
import TasksMapHeader from "./TasksMapHeader";
import ConfirmDialog from "./ConfirmDialog";
import type { TaskMapRevision } from "../lib/taskMapHistory";
import { isViewingHistory, planTreeForView } from "../lib/taskMapHistory";
import { discloseTaskListCap, TASKS_WORK_ITEM_CAP } from "../lib/tasksListCap";
import { authFetch } from "../lib/api";
import { handleTypedInput, useRenderAudit } from "../lib/renderAudit";
import {
  TRAFFIC_EMPTY_COPY,
  bodyDisplayText,
  filterTrafficListRows,
  formatHeadersBlock,
  projectTrafficDetail,
  projectTrafficListRows,
  trafficSourceDisplay,
  type TrafficExchange,
  type TrafficListRow,
  type TrafficSourceFilter,
} from "../lib/trafficAuditView";

export { TASKS_WORK_ITEM_CAP };

type Tab = "status" | "surface" | "findings" | "traffic";
type WorkflowPhaseId = "recon" | "testing" | "verification" | "summary";

type KanbanBucket = { id: string; title: string; done: number; total: number; status: PlanStatus };
type KanbanSummary = {
  workflow_kind?: string;
  elapsed_seconds?: number;
  current_stage?: string;
  totals?: {
    discovered?: number;
    processed?: number;
    pending?: number;
    running?: number;
    confirmed?: number;
    negative?: number;
    blocked?: number;
    inconclusive?: number;
    percent?: number;
  };
  buckets?: KanbanBucket[];
};

type StrixNote = {
  id: string;
  title: string;
  content?: string;
  category?: string;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
};

type StrixRun = {
  run_id?: string;
  run_name?: string;
  status?: string;
  start_time?: string;
  end_time?: string;
  scan_mode?: string;
  targets_info?: Array<{ type?: string; target?: string; original?: string }>;
  llm_usage?: {
    requests?: number;
    input_tokens?: number;
    cached_tokens?: number;
    output_tokens?: number;
    reasoning_tokens?: number;
    total_tokens?: number;
    cost?: number;
    agent_count?: number;
  };
};

type PhasePlan = {
  id: WorkflowPhaseId;
  label: string;
  status: "pending" | "running" | "done";
  items: PlanNode[];
};

type CaseRunSummary = {
  started_at?: string;
  last_active_at?: string;
  participant_count?: number;
  llm_usage?: {
    total_tokens?: number;
    cost?: number;
    requests?: number;
  };
};

interface Props {
  phase?: string;
  activeTool?: string;
  intakeResult?: Record<string, unknown>;
  intakeStatus?: string;
  progress?: { current: number; total: number; percent: number };
  kanban?: KanbanSummary;
  workflowKind?: string;
  running?: boolean;
  planTree?: PlanNode[];
  strixAgents?: StrixAgentStatus[];
  strixNotes?: StrixNote[];
  strixRun?: StrixRun;
  /** Case-level rollup (multi-role tokens / start). */
  caseRun?: CaseRunSummary;
  /** Spec #309: Case traffic audit store projection (replaces Activity timeline). */
  trafficExchanges?: TrafficExchange[];
  /** Spec #368 / #375: Case surface_ledger (snapshot + live upserts) — sole Surface inventory SoT. */
  surfaceLedger?: SurfaceLedger | null;
  findings?: Array<Record<string, unknown>>;
  /** Living notebook clues for Case Scope ∩ Host/Service. */
  intel?: IntelRow[];
  intelForgotten?: IntelRow[];
  intelSealed?: IntelRow[];
  currentTaskId?: string | null;
  assets?: Array<Record<string, unknown>>;
  /** Authorized engagement from conversation.context.task (target + scope.allow). */
  taskContext?: Record<string, unknown>;
  /** Spec #163 Graph engagement close-out (Product state). */
  engagementCloseout?: Record<string, unknown>;
  /** Spec #321 Task Map history (product-state; FE view-only for archives). */
  taskMapRevisions?: TaskMapRevision[];
  liveRevisionId?: string | null;
  viewedRevisionId?: string | null;
  onSelectTaskMapRevision?: (revisionId: string) => void;
  onReturnToLiveTaskMap?: () => void;
  onOpenVulnerability?: (finding: Partial<SecurityVulnerability>) => void;
  onOpenAsset?: (asset: Partial<SecurityAsset>) => void;
  /** After user promotes a Surface origin into the owner ledger. */
  onEnrolledAsset?: (asset: Record<string, unknown>) => void;
  /** Spec #308: open Worker process audit dialog. */
  onWorkerClick?: (agent: StrixAgentStatus, workerOrdinal?: number) => void;
  /** Spec #354: Case id for Session Reset/Delete APIs. */
  conversationId?: string | null;
  /** Spec #354 S4: expert ids with pending incomplete-map handoff. */
  pendingHandoffExpertIds?: string[];
  /** Spec #354: refresh Case snapshot after Session Reset/Delete. */
  onSessionLifecycleDone?: () => void;
  /** Spec #354 S2: Case Task package status light (sync Sidebar ↔ collab Main). */
  packageStatus?: string | null;
  packageWorking?: boolean;
  /** Expert id of the current Task package (only their Main uses package light). */
  packageExpertId?: string | null;
}

const RIGHT_PANEL_WIDTH_KEY = "my_ai_pen_right_panel_width";
const MIN_RIGHT_PANEL_WIDTH = 380;
const DEFAULT_RIGHT_PANEL_WIDTH = 480;
const MAX_RIGHT_PANEL_WIDTH = 760;
const MIN_MAIN_CONTENT_WIDTH = 520;

function loadRightPanelWidth(): number {
  try {
    const saved = Number(window.localStorage.getItem(RIGHT_PANEL_WIDTH_KEY));
    return clampRightPanelWidth(Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_RIGHT_PANEL_WIDTH);
  } catch {
    return clampRightPanelWidth(DEFAULT_RIGHT_PANEL_WIDTH);
  }
}

function clampRightPanelWidth(width: number): number {
  const viewportWidth = typeof window === "undefined" ? 1440 : window.innerWidth;
  const availableWidth = Math.max(MIN_RIGHT_PANEL_WIDTH, viewportWidth - MIN_MAIN_CONTENT_WIDTH);
  const maxWidth = Math.min(MAX_RIGHT_PANEL_WIDTH, availableWidth);
  return Math.max(MIN_RIGHT_PANEL_WIDTH, Math.min(maxWidth, Math.round(width)));
}

export default function RightPanel({
  activeTool,
  intakeResult,
  intakeStatus,
  progress,
  kanban,
  workflowKind,
  running = false,
  engagementCloseout,
  planTree = [],
  strixAgents = [],
  strixNotes = [],
  strixRun,
  caseRun,
  trafficExchanges = [],
  surfaceLedger = null,
  findings = [],
  intel = [],
  intelForgotten = [],
  intelSealed = [],
  currentTaskId = null,
  assets = [],
  taskContext,
  taskMapRevisions = [],
  liveRevisionId = null,
  viewedRevisionId = null,
  onSelectTaskMapRevision,
  onReturnToLiveTaskMap,
  onOpenVulnerability,
  onOpenAsset,
  onEnrolledAsset,
  onWorkerClick,
  conversationId = null,
  pendingHandoffExpertIds = [],
  onSessionLifecycleDone,
  packageStatus = null,
  packageWorking = false,
  packageExpertId = null,
}: Props) {
  useRenderAudit("RightPanel");
  const [tab, setTab] = useState<Tab>("status");
  const [selectedTrafficId, setSelectedTrafficId] = useState<string | null>(null);
  const [sessionActionBusy, setSessionActionBusy] = useState(false);
  const [sessionConfirm, setSessionConfirm] = useState<null | {
    kind: "reset" | "delete";
    expertId: string | null;
    label: string;
  }>(null);
  const [sessionActionError, setSessionActionError] = useState<string | null>(null);

  const runSessionLifecycle = async (kind: "reset" | "delete") => {
    if (!conversationId || !sessionConfirm || sessionConfirm.kind !== kind) return;
    setSessionActionBusy(true);
    setSessionActionError(null);
    try {
      const path =
        kind === "reset"
          ? `/api/conversations/${conversationId}/sessions/reset`
          : `/api/conversations/${conversationId}/sessions/delete`;
      await authFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expert_id: sessionConfirm.expertId }),
      });
      setSessionConfirm(null);
      onSessionLifecycleDone?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e || "请求失败");
      setSessionActionError(msg);
    } finally {
      setSessionActionBusy(false);
    }
  };

  const trafficRows = useMemo(
    () => projectTrafficListRows(trafficExchanges as TrafficExchange[]),
    [trafficExchanges],
  );
  const selectedTraffic = useMemo(() => {
    if (!selectedTrafficId) return null;
    return (trafficExchanges as TrafficExchange[]).find(
      (row) => String(row.exchange_id || "") === selectedTrafficId,
    ) || null;
  }, [selectedTrafficId, trafficExchanges]);
  // Spec #375 D10: Surface inventory from Case surface_ledger only (empty ledger ⇒ empty panel).
  const surfaceEntries = useMemo(
    () => projectSurfaceEntriesFromLedger(ensureSurfaceLedger(surfaceLedger)),
    [surfaceLedger],
  );
  const surfaceKeyList = useMemo(() => surfaceEntries.map((e) => e.key), [surfaceEntries]);
  const findingAttachment = useMemo(
    () => attachFindingsToSurface(findings, surfaceKeyList, surfaceEntries),
    [findings, surfaceKeyList, surfaceEntries],
  );
  const findingsByPath = findingAttachment.byPath;
  const unlinkedFindings = findingAttachment.unlinked;
  const surfaceTree = useMemo(() => buildSurfaceTree(surfaceEntries, findingsByPath), [surfaceEntries, findingsByPath]);
  const surfaceItems = surfaceEntries;
  // Unique findings on routes (1:1 with Findings list items that have a path).
  const surfaceLinkedCount = findingAttachment.linkedUnique;
  const surfaceFindingsTotal = findings.length;
  // Kind chip counts — exclusive, matches Findings group sizes (Vuln / Key / Flags).
  const surfaceKindCounts = findingAttachment.kindCounts;
  const knownSurfaceAssets = useMemo(
    () =>
      assets.map((raw) => {
        const rec = raw || {};
        const props = (rec.properties && typeof rec.properties === "object" ? rec.properties : {}) as Record<
          string,
          unknown
        >;
        const aliasRaw = rec.aliases || props.aliases;
        const aliases = Array.isArray(aliasRaw)
          ? aliasRaw
              .map((item) => {
                if (typeof item === "string") return item.trim();
                if (item && typeof item === "object") {
                  const row = item as Record<string, unknown>;
                  return String(row.value || row.address || row.host || "").trim();
                }
                return "";
              })
              .filter(Boolean)
          : [];
        const services = Array.isArray(rec.services) ? rec.services : Array.isArray(props.services) ? props.services : [];
        const ports = services
          .map((svc) => (svc && typeof svc === "object" ? String((svc as { port?: unknown }).port || "") : ""))
          .filter(Boolean);
        // AssetOut exposes open_ports at top level; snapshot/properties may nest them.
        const openPortRaw = [
          ...(Array.isArray(rec.open_ports) ? rec.open_ports : []),
          ...(Array.isArray(props.open_ports) ? props.open_ports : []),
        ];
        const extraPorts = openPortRaw.map((p) => String(p || "").trim()).filter(Boolean);
        return {
          address: String(rec.address || rec.host || rec.name || ""),
          aliases,
          ports: [...new Set([...ports, ...extraPorts])],
        };
      }),
    [assets],
  );
  const orderedStrixAgents = orderStrixAgents(strixAgents);
  const kanbanSummary = normalizeKanban(kanban, planTree, progress, workflowKind);
  const isStrixWorkflow = workflowKind === "strix" || kanbanSummary.workflow_kind === "strix" || planTree.some((node) => String(node.source || "") === "strix_todo");
  // Unified right-panel layout (Node3 baseline) for both Strix and Node2/pentest.
  // Spec #354: never invent a synthetic Main card (node4-main). Empty roster shows
  // a one-line empty state like Tasks — Session appears after the user talks / work runs.
  // If the conversation is no longer running, never leave Main/Worker agents stuck on "running"
  // (stale checkpoint.panel_agents can lag behind conversation status).
  const displayAgents = normalizeAgentsForConversationRunning(orderedStrixAgents, running);
  const hasStatusData = running || Boolean(activeTool) || planTree.length > 0 || displayAgents.length > 0 || findings.length > 0 || assets.length > 0 || trafficExchanges.length > 0 || surfaceItems.length > 0 || Boolean(strixRun) || Boolean(caseRun?.started_at || caseRun?.llm_usage?.total_tokens) || Boolean(engagementCloseout && Object.keys(engagementCloseout).length);
  // Spec #321: history selection shows frozen revision plan_tree; live stays default.
  const viewedPlanTree = planTreeForView({
    planTree,
    revisions: taskMapRevisions,
    liveRevisionId,
    viewedRevisionId,
  });
  const visiblePlanTree = isStrixWorkflow
    ? mainAgentPlanTree(viewedPlanTree, displayAgents)
    : viewedPlanTree;
  const phasePlan = hasStatusData ? buildPhasePlan(visiblePlanTree, kanbanSummary.current_stage, activeTool, running, findings.length, isStrixWorkflow) : [];
  // Node3-style flat task list for all workflows (phase tree remains available via plan data).
  // Trust plan_tree status only — do not force pending/running → done from conversation.status
  // (that caused false-green todos when status/running lagged open checklist items).
  const taskList = isStrixWorkflow
    ? { items: phasePlan.flatMap((phase) => phase.items), hiddenCount: 0 }
    : unifiedTodoItems(visiblePlanTree);
  const taskItems = taskList.items;
  const tasksHiddenCount = taskList.hiddenCount;
  const tasksViewingHistory = isViewingHistory(viewedRevisionId, liveRevisionId);
  const intake = normalizeIntake(intakeResult, intakeStatus);
  // Spec #324: Status no longer owns elapsed clock (S2 / #325: composer + B1).
  const [panelWidth, setPanelWidth] = useState(loadRightPanelWidth);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    const handleResize = () => setPanelWidth((current) => clampRightPanelWidth(current));
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(panelWidth));
    } catch {
      // Ignore storage failures; resizing should still work for the current page.
    }
  }, [panelWidth]);

  const handlePanelResizeStart = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panelWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setResizing(true);

    const handleMove = (moveEvent: PointerEvent) => {
      const nextWidth = startWidth - (moveEvent.clientX - startX);
      setPanelWidth(clampRightPanelWidth(nextWidth));
    };

    const handleEnd = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      setResizing(false);
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleEnd);
      window.removeEventListener("pointercancel", handleEnd);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleEnd);
    window.addEventListener("pointercancel", handleEnd);
  };

  const findingGroups = groupFindingsByKind(findings);
  const caseMeteringText = formatCaseMeteringHeader(caseRun);
  const caseActiveLine = displayAgents.length > 0 ? agentStatusCount(displayAgents) : "";
  const caseMeteringDetail = formatCaseMeteringDetail(caseRun, { activeLine: caseActiveLine });
  const findingsTabTitle = findingsTabHoverTitle(findingGroups);
  const tabs: { key: Tab; label: string; title?: string }[] = [
    { key: "status", label: "Status" },
    { key: "surface", label: countLabel("Surface", surfaceItems.length) },
    { key: "findings", label: countLabel("Findings", findings.length), title: findingsTabTitle },
    { key: "traffic", label: countLabel("Traffic", trafficRows.length) },
  ];

  return (
    <aside
      className={`right-panel-enter relative flex flex-shrink-0 flex-col border-l border-hairline bg-canvas ${resizing ? "select-none" : ""}`}
      style={{ width: panelWidth, minWidth: MIN_RIGHT_PANEL_WIDTH }}
    >
      <button
        type="button"
        aria-label="Resize status panel"
        title="Resize status panel"
        onPointerDown={handlePanelResizeStart}
        className={`group absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize touch-none bg-transparent outline-none transition-colors hover:bg-status-running/10 focus-visible:bg-status-running/10 ${resizing ? "bg-status-running/10" : ""}`}
      >
        <span aria-hidden="true" className={`absolute left-1/2 top-1/2 h-12 w-px -translate-x-1/2 -translate-y-1/2 rounded-pill transition-colors ${resizing ? "bg-status-running" : "bg-transparent group-hover:bg-status-running/60 group-focus-visible:bg-status-running/60"}`} />
      </button>
      <nav className="grid grid-cols-4 border-b border-hairline-soft">
        {tabs.map((item) => (
          <button
            key={item.key}
            data-testid={`right-tab-${item.key}`}
            title={item.title || item.label}
            onClick={() => setTab(item.key)}
            className={`px-0.5 py-2.5 text-[13px] font-medium transition-colors ${tab === item.key ? "border-b-2 border-ink text-ink" : "border-b-2 border-transparent text-ink-secondary hover:text-ink"}`}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="no-scrollbar flex-1 overflow-y-auto p-4">
        {tab === "status" && (
          <div className="space-y-4">
            {/* Spec #324 D1: Case tokens+cost primary; active count secondary. No elapsed hero. */}
            {(displayAgents.length > 0 || Boolean(caseRun?.llm_usage) || Boolean(conversationId)) && (
              <section data-testid="case-collab-section">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="min-w-0 text-xs text-ink-muted">
                    {displayAgents.filter((a) => !a.parent_id).length > 1 ? "Case participants" : "Agent collaboration"}
                  </p>
                  <p
                    className="shrink-0 cursor-default font-mono text-[11px] text-ink-muted"
                    data-testid="case-metering-header"
                    title={caseMeteringDetail}
                  >
                    {caseMeteringText}
                  </p>
                </div>
                {pendingHandoffExpertIds.length > 0 && (
                  <p
                    className="mb-2 rounded-md bg-severity-medium/15 px-2 py-1 text-[11px] text-ink-secondary"
                    data-testid="pending-handoff-badge"
                  >
                    Pending handoff · {pendingHandoffExpertIds.join(", ")} — same expert re-entry resumes checklist
                  </p>
                )}
                {displayAgents.length > 0 ? (
                  <StrixAgentList
                    agents={displayAgents}
                    onWorkerClick={onWorkerClick}
                    packageStatus={packageStatus}
                    packageWorking={packageWorking}
                    packageExpertId={packageExpertId}
                    sessionLifecycle={
                      conversationId
                        ? {
                            busy: sessionActionBusy,
                            onRequestReset: (agent) => {
                              setSessionActionError(null);
                              setSessionConfirm({
                                kind: "reset",
                                expertId: String(agent.expert_id || "").trim() || null,
                                label: agentDisplayLabel(agent),
                              });
                            },
                            onRequestDelete: (agent) => {
                              setSessionActionError(null);
                              setSessionConfirm({
                                kind: "delete",
                                expertId: String(agent.expert_id || "").trim() || null,
                                label: agentDisplayLabel(agent),
                              });
                            },
                          }
                        : undefined
                    }
                  />
                ) : (
                  <p className="text-sm text-ink-muted" data-testid="collab-empty">
                    No collaboration sessions yet — send a message or dispatch an expert to start
                  </p>
                )}
              </section>
            )}
            {/* Intentional TODO / work packages — Expert Graph L1 stages + L2 todos when present */}
            <section data-testid="tasks-section">
              <TasksMapHeader
                revisions={taskMapRevisions}
                liveRevisionId={liveRevisionId}
                viewedRevisionId={viewedRevisionId}
                doneCount={taskItems.filter((item) => isTerminalPlanStatus(item.status)).length}
                totalCount={taskItems.length}
                hiddenCount={tasksHiddenCount}
                onSelectRevision={(id) => onSelectTaskMapRevision?.(id)}
                onReturnToLive={() => onReturnToLiveTaskMap?.()}
              />
              <GraphAwareTodoList
                planTree={visiblePlanTree}
                workItems={taskItems}
                running={tasksViewingHistory ? false : running}
                agents={displayAgents}
              />
              {tasksHiddenCount > 0 && (
                <p className="mt-1 px-2 text-[11px] text-ink-muted" data-testid="tasks-overflow-disclosure">
                  +{tasksHiddenCount} more task{tasksHiddenCount === 1 ? "" : "s"} not shown
                </p>
              )}
            </section>
            {engagementCloseout && Object.keys(engagementCloseout).length > 0 && (
              <EngagementCloseoutCard closeout={engagementCloseout} />
            )}
            {intake && <IntakeSummary intake={intake} />}
          </div>
        )}
        {tab === "surface" && (
          surfaceItems.length === 0 ? (
            <p className="text-sm text-ink-muted" data-testid="surface-empty">
              No attack surface recorded yet
            </p>
          ) : (
            <SurfaceTreeView
              roots={surfaceTree}
              total={surfaceItems.length}
              linkedCount={surfaceLinkedCount}
              findingsTotal={surfaceFindingsTotal}
              kindCounts={surfaceKindCounts}
              unlinked={unlinkedFindings}
              knownAssets={knownSurfaceAssets}
              onOpenVulnerability={onOpenVulnerability}
              onEnrolledAsset={onEnrolledAsset}
            />
          )
        )}
        {tab === "findings" && (
          <div className="space-y-6">
            {findings.length === 0 ? (
              <p className="text-sm text-ink-muted">No findings yet</p>
            ) : (
              <div className="space-y-4" title={findingsTabTitle}>
                {findingGroups.map((group) =>
                  group.items.length === 0 ? null : (
                    <section key={group.id} className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-medium text-ink-muted">
                          {group.label} ({group.items.length})
                        </p>
                        <span className="font-mono text-[10px] text-ink-muted">{group.hint}</span>
                      </div>
                      {group.items.map((finding, index) => (
                        <FindingCard
                          key={(finding.id as string) || (finding.vulnerability_id as string) || `${group.id}-${index}`}
                          caseStartedAt={caseRun?.started_at || strixRun?.start_time}
                          finding={{
                            ...finding,
                            // Keep group assignment exclusive (Vuln / Key / Flag).
                            finding_kind: group.id === "auth" ? "auth" : group.id,
                            kind: group.id === "auth" ? "auth" : group.id,
                            category: group.id === "auth" ? "auth" : group.id,
                          }}
                          onOpen={(opened) => {
                            const resolved =
                              resolveFindingSurfaceKey(
                                finding,
                                surfaceKeyList,
                                new Set(surfaceKeyList.map((p) => p.toLowerCase())),
                                surfaceEntries,
                              ) || String((finding as { __surface_path?: string }).__surface_path || "");
                            onOpenVulnerability?.({
                              ...opened,
                              ...(resolved
                                ? {
                                    __surface_path: resolved,
                                    __surface_display: surfaceKeyToDisplay(resolved),
                                  }
                                : {}),
                            } as Partial<SecurityVulnerability>);
                          }}
                        />
                      ))}
                    </section>
                  ),
                )}
              </div>
            )}
            <section data-testid="intel-clues-section" className="space-y-2 border-t border-hairline-soft pt-4">
              <p className="text-xs font-medium text-ink-muted">线索</p>
              <IntelList
                rows={[...intel, ...intelForgotten, ...intelSealed]}
                currentTaskId={currentTaskId}
                conversationId={conversationId}
                emptyCopy="还没有线索。Agent 笔记本会把值得记住的东西记在这里。"
                showHang
              />
            </section>
          </div>
        )}
        {tab === "traffic" && (
          <TrafficAuditList
            rows={trafficRows}
            emptyCopy={TRAFFIC_EMPTY_COPY}
            onOpen={(id) => setSelectedTrafficId(id)}
          />
        )}
      </div>
      {selectedTrafficId &&
        typeof document !== "undefined" &&
        createPortal(
          <TrafficDetailDialog
            exchange={selectedTraffic}
            onClose={() => setSelectedTrafficId(null)}
          />,
          document.body,
        )}
      {/* Spec #354: platform ConfirmDialog for Session Reset / Delete (not window.confirm). */}
      <ConfirmDialog
        open={sessionConfirm?.kind === "reset"}
        title="重置 Session"
        description={
          sessionConfirm?.kind === "reset"
            ? `确定重置「${sessionConfirm.label}」的模型工作记忆？\n未完成的 Tasks 会保留，不会冷 reseed 清单。`
            : ""
        }
        confirmLabel="重置"
        cancelLabel="取消"
        busy={sessionActionBusy}
        error={sessionConfirm?.kind === "reset" ? sessionActionError : null}
        onCancel={() => {
          if (sessionActionBusy) return;
          setSessionConfirm(null);
          setSessionActionError(null);
        }}
        onConfirm={() => {
          void runSessionLifecycle("reset");
        }}
      />
      <ConfirmDialog
        open={sessionConfirm?.kind === "delete"}
        title="删除 Session"
        description={
          sessionConfirm?.kind === "delete"
            ? `确定删除「${sessionConfirm.label}」？\n未完成的 Tasks 会进入 Case pending handoff，同 expert 再入时自动接续。`
            : ""
        }
        confirmLabel="删除"
        cancelLabel="取消"
        busy={sessionActionBusy}
        error={sessionConfirm?.kind === "delete" ? sessionActionError : null}
        onCancel={() => {
          if (sessionActionBusy) return;
          setSessionConfirm(null);
          setSessionActionError(null);
        }}
        onConfirm={() => {
          void runSessionLifecycle("delete");
        }}
      />
    </aside>
  );
}

function agentDisplayLabel(agent: StrixAgentStatus): string {
  const name = String(agent.name || agent.expert_id || agent.pack_id || "Session").trim();
  return name || "Session";
}

function TrafficAuditList({
  rows,
  emptyCopy,
  onOpen,
}: {
  rows: TrafficListRow[];
  emptyCopy: string;
  onOpen: (exchangeId: string) => void;
}) {
  useRenderAudit("TrafficAuditList");
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<TrafficSourceFilter>("all");
  const visible = useMemo(
    () => filterTrafficListRows(rows, { query, source: sourceFilter }),
    [rows, query, sourceFilter],
  );

  return (
    <div className="space-y-2" data-testid="traffic-audit-list">
      <div className="flex flex-wrap items-center gap-2" data-testid="traffic-toolbar">
        <input
          type="search"
          value={query}
          onChange={handleTypedInput("TrafficAuditList", setQuery)}
          placeholder="Search method, domain, path…"
          data-testid="traffic-search"
          className="min-w-0 flex-1 rounded-md border border-hairline bg-canvas px-2.5 py-1.5 text-[12px] text-ink placeholder:text-ink-muted outline-none focus:border-ink"
        />
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as TrafficSourceFilter)}
          data-testid="traffic-source-filter"
          className="shrink-0 rounded-md border border-hairline bg-canvas px-2 py-1.5 text-[12px] text-ink outline-none focus:border-ink"
          aria-label="Filter by source"
        >
          <option value="all">All sources</option>
          <option value="http">http</option>
          <option value="browser">browser</option>
          <option value="curl">curl</option>
        </select>
      </div>
      {!rows.length ? (
        <p className="text-sm text-ink-muted" data-testid="traffic-empty">
          {emptyCopy}
        </p>
      ) : !visible.length ? (
        <p className="text-sm text-ink-muted" data-testid="traffic-filter-empty">
          No exchanges match search/filter
        </p>
      ) : (
        <div className="overflow-x-auto border-t border-hairline-soft">
          <table className="w-full min-w-[420px] border-collapse text-left" data-testid="traffic-table">
            <thead>
              <tr className="border-b border-hairline-soft text-[10px] font-medium uppercase tracking-wide text-ink-muted">
                <th className="px-1 py-1.5 font-medium">#</th>
                <th className="px-1 py-1.5 font-medium">Method</th>
                <th className="px-1 py-1.5 font-medium">Domain</th>
                <th className="px-1 py-1.5 font-medium">Path</th>
                <th className="px-1 py-1.5 font-medium">Status</th>
                <th className="px-1 py-1.5 font-medium">Source</th>
                <th className="px-1 py-1.5 font-medium">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline-soft">
              {visible.map((row) => (
                <tr
                  key={row.exchange_id}
                  data-testid={`traffic-row-${row.exchange_id}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpen(row.exchange_id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onOpen(row.exchange_id);
                    }
                  }}
                  className="cursor-pointer font-mono text-[11px] text-ink transition-colors hover:bg-canvas-inset/60 focus-visible:bg-canvas-inset/60 focus-visible:outline-none"
                  title={row.url}
                >
                  <td className="whitespace-nowrap px-1 py-1.5 text-ink-muted">{row.index}</td>
                  <td className={`whitespace-nowrap px-1 py-1.5 font-semibold ${trafficMethodTextClass(row.method)}`}>
                    {row.method}
                  </td>
                  <td className="max-w-[7rem] truncate px-1 py-1.5" title={row.domain}>
                    {row.domain || "—"}
                  </td>
                  <td className="max-w-[10rem] truncate px-1 py-1.5" title={row.path}>
                    {row.path || "/"}
                  </td>
                  <td className={`whitespace-nowrap px-1 py-1.5 font-medium ${trafficStatusTextClass(row)}`}>
                    {row.status}
                  </td>
                  <td className="whitespace-nowrap px-1 py-1.5 text-ink-muted">{row.source}</td>
                  <td className="whitespace-nowrap px-1 py-1.5 text-ink-muted">{row.duration}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
/** Method column color (DevTools-style). */
function trafficMethodTextClass(method: string): string {
  switch (String(method || "").toUpperCase()) {
    case "GET":
      return "text-status-running";
    case "POST":
      return "text-status-success";
    case "PUT":
    case "PATCH":
      return "text-severity-high";
    case "DELETE":
      return "text-severity-critical";
    case "HEAD":
    case "OPTIONS":
      return "text-ink-secondary";
    default:
      return "text-ink";
  }
}

/** Status column color by phase / HTTP class. */
function trafficStatusTextClass(row: Pick<TrafficListRow, "status" | "pending" | "phase">): string {
  if (row.pending) return "text-status-running";
  if (row.phase === "failed" || row.status === "failed" || row.status === "err") {
    return "text-severity-critical";
  }
  const code = Number(row.status);
  if (!Number.isFinite(code)) return "text-ink-secondary";
  if (code >= 200 && code < 300) return "text-status-success";
  if (code >= 300 && code < 400) return "text-status-running";
  if (code >= 400 && code < 500) return "text-severity-high";
  if (code >= 500) return "text-severity-critical";
  return "text-ink-secondary";
}

function TrafficDetailDialog({
  exchange,
  onClose,
}: {
  exchange: TrafficExchange | null | undefined;
  onClose: () => void;
}) {
  const detail = projectTrafficDetail(exchange || null);
  if (!detail) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center theme-overlay px-4" onClick={onClose}>
        <div
          className="w-full max-w-3xl rounded-lg border border-hairline-soft bg-canvas p-6 shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-sm text-ink-muted">Exchange not found.</p>
          <button type="button" onClick={onClose} className="mt-4 rounded-md border border-hairline px-3 py-1.5 text-xs">
            Close
          </button>
        </div>
      </div>
    );
  }

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  };

  const requestRaw = [
    `${detail.method} ${detail.url}`,
    formatHeadersBlock(detail.request_headers),
    "",
    bodyDisplayText({
      body: detail.request_body,
      binary: detail.request_binary,
      truncated: detail.request_truncated,
      bytes: detail.request_bytes,
      hash: detail.request_hash,
    }),
  ].join("\n");

  const responseRaw = detail.waiting_response
    ? bodyDisplayText({ body: null, waiting: true })
    : [
        detail.status_code != null ? `HTTP ${detail.status_code}` : detail.error ? `Error: ${detail.error}` : "Response",
        formatHeadersBlock(detail.response_headers),
        "",
        bodyDisplayText({
          body: detail.response_body,
          binary: detail.response_binary,
          truncated: detail.response_truncated,
          bytes: detail.response_bytes,
          hash: detail.response_hash,
          emptyLabel: detail.error ? `(${detail.error})` : "(empty)",
        }),
      ].join("\n");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center theme-overlay px-4 py-6" onClick={onClose} data-testid="traffic-detail-dialog">
      <div
        className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-hairline-soft bg-canvas shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-hairline-soft px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-muted">Traffic</p>
            <h2 className="break-all font-mono text-sm font-semibold text-ink">
              <span className="mr-2 rounded-sm bg-canvas-inset px-1.5 py-0.5 text-[11px]">{detail.method}</span>
              {detail.status_code != null && (
                <span className="mr-2 rounded-sm bg-canvas-inset px-1.5 py-0.5 text-[11px]">{detail.status_code}</span>
              )}
              {detail.waiting_response && (
                <span className="mr-2 rounded-sm bg-status-running/15 px-1.5 py-0.5 text-[11px] text-status-running">pending</span>
              )}
              <span className="text-ink-secondary">{detail.url}</span>
            </h2>
            <p className="mt-1 text-[11px] text-ink-muted">
              source={trafficSourceDisplay(detail.source)} · phase={detail.phase}
            </p>
          </div>
          <button type="button" onClick={onClose} className="shrink-0 rounded-md border border-hairline px-3 py-1.5 text-xs hover:bg-surface-default">
            Close
          </button>
        </div>
        <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto p-5 md:grid-cols-2">
          <section className="min-w-0">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Request</h3>
              <button type="button" className="text-[11px] text-ink-secondary hover:text-ink" onClick={() => void copyText(requestRaw)}>
                Copy
              </button>
            </div>
            <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-all rounded-md border border-hairline-soft bg-canvas-inset p-3 font-mono text-[11px] leading-relaxed text-ink">
              {requestRaw}
            </pre>
          </section>
          <section className="min-w-0">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Response</h3>
              <button type="button" className="text-[11px] text-ink-secondary hover:text-ink" onClick={() => void copyText(responseRaw)}>
                Copy
              </button>
            </div>
            <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-all rounded-md border border-hairline-soft bg-canvas-inset p-3 font-mono text-[11px] leading-relaxed text-ink">
              {responseRaw}
            </pre>
          </section>
        </div>
      </div>
    </div>
  );
}

function OverallProgress({ progress }: { progress: { percent: number; label: string } }) {
  return (
    <section data-testid="overall-progress">
      <div className="mb-1 flex items-center justify-between gap-3">
        <p className="text-xs text-ink-muted">Overall progress</p>
        <p className="font-mono text-[11px] text-ink-muted">{progress.label}</p>
      </div>
      <div className="h-1.5 overflow-hidden rounded-pill bg-canvas-inset">
        <div className="h-full rounded-pill bg-ink transition-[width]" style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }} />
      </div>
    </section>
  );
}

function WorkflowPlan({ phases }: { phases: PhasePlan[]; running?: boolean }) {
  if (!phases.length) {
    return <p className="text-sm text-ink-muted">No active task plan yet</p>;
  }
  return (
    <div className="space-y-3" data-testid="workflow-plan">
      {phases.map((phase, index) => {
        const current = phase.status === "running";
        const done = phase.status === "done";
        return (
          <section key={phase.id} className="relative">
            {index < phases.length - 1 && <span aria-hidden="true" className="absolute left-[5px] top-5 h-[calc(100%+0.75rem)] w-px bg-hairline-soft" />}
            <div className="flex min-w-0 items-center gap-2">
              <span aria-hidden="true" className={`relative mt-1 h-2.5 w-2.5 shrink-0 rounded-full border ${current ? "border-ink bg-ink" : done ? "border-hairline bg-hairline" : "border-hairline bg-canvas"}`} />
              <p className={`truncate text-sm ${current ? "font-semibold text-ink" : done ? "font-medium text-ink-muted" : "font-medium text-ink-secondary"}`}>{phase.label}</p>
            </div>
            <div className="ml-5 mt-1.5 space-y-1.5">
              {phase.items.length ? (
                phase.items.map((item, itemIndex) => <PlanItem key={planNodeKey(item, itemIndex)} item={item} />)
              ) : (
                <p className="text-xs text-ink-muted">No tasks in this stage</p>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function PlanItem({ item }: { item: PlanNode }) {
  const status = String(item.status || "pending");
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span aria-hidden="true" className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${planItemDotClass(status)}`} />
      <div className="min-w-0 flex-1">
        <p className={`break-words text-xs [overflow-wrap:anywhere] ${isTerminalPlanStatus(status) ? "text-ink-muted" : "text-ink-secondary"}`}>{String(item.title || "Untitled plan item")}</p>
        {item.notes && <p className="mt-0.5 break-words text-[11px] text-ink-muted [overflow-wrap:anywhere]">{clip(item.notes, 140)}</p>}
      </div>
    </div>
  );
}


function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <p className="text-xs text-ink-muted">{title}</p>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function IntakeSummary({ intake }: { intake: ReturnType<typeof normalizeIntake> }) {
  if (!intake) return null;
  return (
    <section data-testid="intake-result" className="rounded-md border border-hairline-soft p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">Preflight</p>
        <span className={`rounded-pill px-2 py-0.5 text-[11px] font-medium ${intake.ok ? "bg-status-success text-white" : "bg-severity-critical text-white"}`}>{intake.label}</span>
      </div>
      <div className="space-y-1 text-xs text-ink-secondary">
        {intake.target && <p className="break-all">Target: {intake.target}</p>}
        {intake.dns && <p className="break-all">DNS: {intake.dns}</p>}
        {intake.connectivity && <p className="break-all">Connectivity: {intake.connectivity}</p>}
        {intake.reason && <p className="break-all text-severity-critical">{intake.reason}</p>}
      </div>
    </section>
  );
}

function normalizeKanban(input: KanbanSummary | undefined, nodes: PlanNode[], progress?: { current: number; total: number; percent: number }, workflowKind?: string): KanbanSummary {
  if (input?.totals || input?.buckets?.length) {
    return {
      ...input,
      workflow_kind: input.workflow_kind || workflowKind,
      totals: input.totals || { discovered: progress?.total || 0, processed: progress?.current || 0, percent: progress?.percent || 0 },
      buckets: input.buckets || [],
    };
  }
  const surfaces = attackSurfaceItems(nodes);
  const tests = nodes.filter((node) => node.kind === "test");
  const processed = tests.filter((node) => isTerminalPlanStatus(node.status)).length;
  const discovered = tests.length || surfaces.length || progress?.total || 0;
  return {
    workflow_kind: workflowKind,
    current_stage: undefined,
    totals: {
      discovered,
      processed: tests.length ? processed : progress?.current || 0,
      pending: tests.filter((node) => node.status === "todo" || node.status === "pending").length,
      running: tests.filter((node) => node.status === "running").length,
      confirmed: tests.filter((node) => node.result === "confirmed").length,
      negative: tests.filter((node) => node.result === "negative").length,
      blocked: tests.filter((node) => node.result === "blocked" || node.status === "blocked").length,
      inconclusive: tests.filter((node) => node.result === "inconclusive" && !isTerminalPlanStatus(node.status)).length,
      percent: discovered ? Math.round(((tests.length ? processed : progress?.current || 0) / discovered) * 100) : progress?.percent || 0,
    },
    buckets: [],
  };
}

function buildPhasePlan(nodes: PlanNode[], currentStage: string | undefined, activeTool: string | undefined, running: boolean, findingsCount: number, strixWorkflow = false): PhasePlan[] {
  const items = agentPlanItems(nodes);
  if (!activeTool && findingsCount === 0 && items.length === 0) {
    return [];
  }
  if (strixWorkflow) {
    const strixItems = items.sort((left, right) => Number(left.priority || 999) - Number(right.priority || 999) || String(left.title || "").localeCompare(String(right.title || ""))).slice(0, 12);
    if (!strixItems.length) return [];
    const status: PhasePlan["status"] = strixItems.some((item) => item.status === "running")
      ? "running"
      : strixItems.every((item) => isTerminalPlanStatus(item.status))
        ? "done"
        : running
          ? "running"
          : "pending";
    return [{ id: "testing", label: "Strix", status, items: strixItems }];
  }
  const activeId = lightweightStageId(currentStage, activeTool, running, findingsCount);
  const phases: PhasePlan[] = [
    { id: "recon", label: "Recon", status: "pending", items: [] },
    { id: "testing", label: "Testing", status: "pending", items: [] },
    { id: "verification", label: "Verification", status: "pending", items: [] },
    { id: "summary", label: "Summary", status: "pending", items: [] },
  ];
  const byId = new Map(phases.map((phase) => [phase.id, phase]));
  const activeIndex = activeId === "completed" ? phases.length : Math.max(0, phases.findIndex((phase) => phase.id === activeId));
  phases.forEach((phase, index) => {
    phase.status = activeId === "completed" || index < activeIndex ? "done" : index === activeIndex ? "running" : "pending";
  });
  for (const item of items) {
    byId.get(workflowPhaseForPlanItem(item))?.items.push(item);
  }
  for (const phase of phases) {
    phase.items = phase.items.sort((left, right) => Number(left.priority || 999) - Number(right.priority || 999) || String(left.title || "").localeCompare(String(right.title || ""))).slice(0, 7);
  }
  return phases;
}

function mainAgentPlanTree(nodes: PlanNode[], agents: StrixAgentStatus[]): PlanNode[] {
  const mainAgentId = mainStrixAgentId(agents);
  if (!mainAgentId) return nodes;
  return nodes.filter((node) => {
    if (String(node.source || "") !== "strix_todo") return true;
    const ownerAgentId = String(node.agent_id || "").trim();
    return !ownerAgentId || ownerAgentId === mainAgentId;
  });
}

function mainStrixAgentId(agents: StrixAgentStatus[]): string {
  const main = agents.find((agent) => String(agent.role || "").toLowerCase() === "main") || agents.find((agent) => !agent.parent_id);
  return String(main?.id || "").trim();
}

function agentPlanItems(nodes: PlanNode[]): PlanNode[] {
  return nodes.filter((node) => {
    if ((node.level || "work_item") !== "work_item") return false;
    if (!["agent", "strix_todo"].includes(String(node.source || ""))) return false;
    const kind = String(node.kind || "task");
    return !["tool", "browser", "http", "poc", "scan", "traffic", "finding"].includes(kind);
  });
}

/**
 * Intentional TODO list for Status — CTF/checklist plan items only.
 * Workers live under Agent collaboration (not duplicated here).
 * Tool telemetry / coverage(mark) / findings stay out of Tasks.
 * Spec #301: cap + hiddenCount via discloseTaskListCap (never silent truncate).
 */
function unifiedTodoItems(nodes: PlanNode[]): { items: PlanNode[]; hiddenCount: number } {
  const noiseKinds = new Set([
    "tool", "browser", "http", "poc", "scan", "traffic", "finding", "coverage", "verifier",
    "finish_scan", "workflow", "workflow_run", "workflow_list", "workflow_dynamic", "read", "actor",
    "surface", "request", "test", "worker", "stage",
  ]);

  const filtered = nodes
    .filter((node) => {
      if ((node.level || "work_item") !== "work_item") return false;
      const source = String(node.source || "");
      const kind = String(node.kind || "task");
      const parent = String(node.parent_id || "");
      const id = String(node.node_id || node.id || "");
      // Workers are shown in Agent collaboration, not Tasks.
      if (kind === "worker" || (source === "worker" && !id.startsWith("plan-followup-") && !/^Follow-up /i.test(String(node.title || "")))) {
        return false;
      }
      // Never show coverage matrix or tool telemetry.
      if (source === "coverage" || source === "pi_tool" || kind === "test") return false;
      if (noiseKinds.has(kind)) return false;
      // Explicit agent/plan checklist items (coverage plan, CTF rows, follow-ups).
      if (source === "agent" || source === "strix_todo" || source === "plan") return true;
      if (source === "worker" && (id.startsWith("plan-followup-") || /^Follow-up /i.test(String(node.title || "")))) return true;
      if (["task", "work", "work_item", "package", "objective"].includes(kind)) return true;
      if (parent.startsWith("workflow-") || id.startsWith("ctf-") || id.startsWith("workflow-")) return true;
      return false;
    });

  // Collapse checkpoint duplicates: same node_id with and without owner chip.
  const ownedIds = new Set(
    filtered
      .filter((n) => String(n.owner_expert_id || n.owner_expert_name || "").trim())
      .map((n) => String(n.node_id || n.id || "").trim())
      .filter(Boolean),
  );
  const seenOwnerKey = new Set<string>();
  const seenUnowned = new Set<string>();
  const deduped = filtered.filter((node) => {
    const id = String(node.node_id || node.id || "").trim();
    const owner = String(node.owner_expert_id || node.owner_expert_name || "").trim();
    if (!id) return true;
    if (owner) {
      const key = `${owner}:${id}`;
      if (seenOwnerKey.has(key)) return false;
      seenOwnerKey.add(key);
      return true;
    }
    if (ownedIds.has(id) || seenUnowned.has(id)) return false;
    seenUnowned.add(id);
    return true;
  });

  const sorted = deduped.sort((left, right) => {
    // Stable primary sort by priority/id so lists do not thrash order on every status tick.
    // Secondary: active work slightly preferred when priorities tie.
    const rank = (status: string | undefined) => {
      const s = String(status || "pending");
      if (s === "running") return 0;
      if (s === "todo" || s === "pending") return 1;
      if (s === "blocked") return 2;
      if (s === "failed") return 3;
      if (s === "skipped") return 4;
      return 5;
    };
    const byPri = Number(left.priority || 500) - Number(right.priority || 500);
    if (byPri !== 0) return byPri;
    const byStatus = rank(left.status) - rank(right.status);
    if (byStatus !== 0) return byStatus;
    return String(left.node_id || left.id || left.title || "").localeCompare(String(right.node_id || right.id || right.title || ""));
  });
  return discloseTaskListCap(sorted, TASKS_WORK_ITEM_CAP);
}

/** Align collaboration tree with conversation lifecycle (timer already stopped when running=false). */
function normalizeAgentsForConversationRunning(agents: StrixAgentStatus[], running: boolean): StrixAgentStatus[] {
  if (running || agents.length === 0) return agents;
  const open = new Set(["running", "pending", "todo", "llm_waiting", "llm_stalled", "tool_running", "working", "chat", "starting", ""]);
  return agents.map((agent) => {
    const status = String(agent.status || "").toLowerCase();
    if (!open.has(status)) return agent;
    return {
      ...agent,
      status: "completed",
      current_tool: "",
      current_action: "finished",
      // Spec #324: do not invent “本轮工作已结束” narration; badge/dot carry runtime.
      current_detail: "",
      pending_count: 0,
    };
  });
}

function countLabel(base: string, count: number): string {
  return count > 0 ? `${base} (${count})` : base;
}

function workflowPhaseForPlanItem(item: PlanNode): WorkflowPhaseId {
  const explicit = explicitWorkflowPhase(item.parent_id) || explicitWorkflowPhase(item.node_id) || explicitWorkflowPhase(item.id);
  if (explicit) return explicit;
  const text = `${item.title || ""} ${item.notes || ""}`.toLowerCase();
  if (hasAny(text, ["summary", "report", "final", "cleanup"])) return "summary";
  if (hasAny(text, ["verify", "verification", "evidence", "finding", "validate", "confirm", "reproduce"])) return "verification";
  if (hasAny(text, ["test", "probe", "payload", "sqli", "sql injection", "xss", "csrf", "upload", "traversal", "injection"])) return "testing";
  return "recon";
}

function explicitWorkflowPhase(value: string | null | undefined): WorkflowPhaseId | null {
  const normalized = String(value || "").toLowerCase();
  if (["workflow-recon", "recon"].includes(normalized) || normalized.includes("workflow-recon")) return "recon";
  if (["workflow-testing", "testing", "test"].includes(normalized) || normalized.includes("workflow-testing")) return "testing";
  if (["workflow-verification", "verification", "verify"].includes(normalized) || normalized.includes("workflow-verification")) return "verification";
  if (["workflow-summary", "summary", "report"].includes(normalized) || normalized.includes("workflow-summary")) return "summary";
  return null;
}

function overallPlanProgress(phases: PhasePlan[], kanban: KanbanSummary, progress?: { current: number; total: number; percent: number }): { percent: number; label: string } {
  const items = phases.flatMap((phase) => phase.items);
  if (items.length) {
    const done = items.filter((item) => isTerminalPlanStatus(item.status)).length;
    return { percent: Math.round((done / items.length) * 100), label: `${done}/${items.length}` };
  }
  const stagePercent = stageProgressPercent(phases);
  if (stagePercent > 0) return { percent: stagePercent, label: `${stagePercent}%` };
  const fallback = progress?.percent ?? kanban.totals?.percent ?? 0;
  return { percent: fallback, label: fallback ? `${fallback}%` : "waiting" };
}

function stageProgressPercent(phases: PhasePlan[]): number {
  const done = phases.filter((phase) => phase.status === "done").length;
  const running = phases.some((phase) => phase.status === "running") ? 0.5 : 0;
  return Math.round(((done + running) / phases.length) * 100);
}

function lightweightStageId(currentStage: string | undefined, activeTool: string | undefined, running: boolean | undefined, findingsCount: number): WorkflowPhaseId | "completed" {
  if (currentStage === "completed") return "completed";
  if (currentStage === "summarizing" || currentStage === "incomplete") return "summary";
  const tool = String(activeTool || "").toLowerCase();
  if (["browser", "scan", "traffic"].includes(tool)) return "recon";
  if (["verifier", "finding"].includes(tool)) return "verification";
  if (["http", "poc", "coverage", "skill"].includes(tool)) return findingsCount > 0 ? "verification" : "testing";
  if (!running && findingsCount > 0) return "summary";
  return currentStage === "confirming" ? "recon" : "testing";
}

/** Structured attack-surface entry: host:port + service + optional web path. */
function markdownPreview(value: string): string {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/[#*_`>\-[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Spec #163: compact Graph engagement close-out from Product state (not a PDF report). */
function EngagementCloseoutCard({ closeout }: { closeout: Record<string, unknown> }) {
  const terminal = String(closeout.terminal || "unknown");
  const graphId = String(closeout.graphId || "");
  const processComplete = closeout.process_complete;
  const residual = String(closeout.residual_risk || "").trim();
  const residualClass = closeout.residual_class ? String(closeout.residual_class) : "";
  const findings = closeout.findings && typeof closeout.findings === "object"
    ? (closeout.findings as Record<string, unknown>)
    : {};
  const bookedN = Array.isArray(findings.booked_titles) ? findings.booked_titles.length : 0;
  const unbookedN = Array.isArray(findings.feedback_ok_unbooked) ? findings.feedback_ok_unbooked.length : 0;
  const stages = Array.isArray(closeout.stages) ? closeout.stages : [];
  const incomplete = processComplete === false || terminal === "blocked" || terminal === "failed";
  return (
    <section className="rounded-md border border-hairline bg-canvas/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-ink">Engagement close-out</p>
        <p className={`font-mono text-[11px] ${incomplete ? "text-severity-high" : "text-status-success"}`}>
          {terminal}
        </p>
      </div>
      <dl className="space-y-1 text-[12px] text-ink-muted">
        {graphId ? (
          <div className="flex justify-between gap-2">
            <dt>Graph</dt>
            <dd className="font-mono text-ink">{graphId}</dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-2">
          <dt>Process complete</dt>
          <dd className="font-mono text-ink">{processComplete === false ? "no" : processComplete === true ? "yes" : "—"}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Stages</dt>
          <dd className="font-mono text-ink">{stages.length}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Booked / unbooked</dt>
          <dd className="font-mono text-ink">{bookedN} / {unbookedN}</dd>
        </div>
        {residualClass ? (
          <div className="flex justify-between gap-2">
            <dt>Residual class</dt>
            <dd className="font-mono text-ink">{residualClass}</dd>
          </div>
        ) : null}
        {closeout.booking_tail_ran ? (
          <div className="flex justify-between gap-2">
            <dt>Booking tail</dt>
            <dd className="font-mono text-ink">ran</dd>
          </div>
        ) : null}
      </dl>
      {residual ? (
        <p className="mt-2 text-[12px] leading-snug text-ink">{residual.slice(0, 280)}</p>
      ) : null}
    </section>
  );
}

function isTerminalPlanStatus(status: PlanStatus | undefined): boolean {
  return status === "done" || status === "blocked" || status === "failed" || status === "skipped";
}

function planItemDotClass(status: string): string {
  if (status === "running") return "bg-ink";
  if (isTerminalPlanStatus(status)) return "bg-hairline";
  return "bg-canvas-inset";
}

function planNodeKey(node: PlanNode, index: number) {
  return String(node.node_id || node.id || `plan-node-${index}`);
}

function normalizeIntake(intakeResult?: Record<string, unknown>, intakeStatus?: string) {
  if (!intakeResult) return null;
  const ok = intakeResult.ok === true;
  const connectivity = intakeResult.connectivity as Record<string, unknown> | undefined;
  const dns = Array.isArray(intakeResult.dns_addresses) ? intakeResult.dns_addresses.join(", ") : "";
  const connText = connectivity?.checked
    ? `${connectivity.ok ? "reachable" : "unreachable"} ${connectivity.host || ""}${connectivity.port ? `:${connectivity.port}` : ""}`.trim()
    : "not checked";
  return {
    ok,
    label: ok ? "Passed" : "Failed",
    target: String(intakeResult.target || ""),
    dns,
    connectivity: connText,
    reason: String(intakeResult.reason || (intakeStatus === "failed" ? "Preflight failed" : "")),
  };
}

function hasAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function clip(value: string, limit: number): string {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}...` : normalized;
}
