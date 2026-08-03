import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { SecurityAsset, SecurityVulnerability } from "../lib/securityTypes";
import type { PlanNode, PlanStatus, StrixAgentStatus } from "../lib/panelTypes";
import {
  StrixAgentList,
  agentStatusCount,
  friendlyToolLabel,
  orderStrixAgents,
} from "./AgentCollaborationTree";
import {
  SurfaceTreeView,
  collectSurfaceEntries,
  attachFindingsToSurface,
  parseEngagementTargets,
  parseSurfaceInventoryKey,
  parseSurfaceRef,
  toSurfaceEntry,
  buildSurfaceTree,
  resolveFindingSurfaceKey,
  surfaceKeyToDisplay,
  groupFindingsByKind,
  findingsTabHoverTitle,
  attackSurfaceItems,
  type SurfaceEntry,
} from "./SurfaceInventory";
import FindingCard from "./cards/FindingCard";
import { GraphAwareTodoList } from "./TasksPlanList";

type Tab = "status" | "surface" | "findings" | "activity";
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

type TimelineEvent = {
  id: string;
  at?: string;
  category: string;
  title: string;
  detail?: string;
  status?: string;
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
  timeline?: TimelineEvent[];
  timelineCursorAt?: string;
  findings?: Array<Record<string, unknown>>;
  assets?: Array<Record<string, unknown>>;
  /** Authorized engagement from conversation.context.task (target + scope.allow). */
  taskContext?: Record<string, unknown>;
  /** Spec #163 Graph engagement close-out (Product state). */
  engagementCloseout?: Record<string, unknown>;
  onOpenVulnerability?: (finding: Partial<SecurityVulnerability>) => void;
  onOpenAsset?: (asset: Partial<SecurityAsset>) => void;
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
  timeline = [],
  timelineCursorAt,
  findings = [],
  assets = [],
  taskContext,
  onOpenVulnerability,
  onOpenAsset,
}: Props) {
  const [tab, setTab] = useState<Tab>("status");
  const engagementTargets = useMemo(() => parseEngagementTargets(taskContext), [taskContext]);
  // Host → port/service → path inventory (not path-only under "/").
  const baseSurfaceEntries = useMemo(
    () => collectSurfaceEntries(planTree, assets, [], engagementTargets),
    [planTree, assets, engagementTargets],
  );
  const surfaceKeyList = useMemo(() => baseSurfaceEntries.map((e) => e.key), [baseSurfaceEntries]);
  const findingAttachment = useMemo(
    () => attachFindingsToSurface(findings, surfaceKeyList, baseSurfaceEntries),
    [findings, surfaceKeyList, baseSurfaceEntries],
  );
  const surfaceEntries = useMemo(() => {
    const byKey = new Map(baseSurfaceEntries.map((e) => [e.key.toLowerCase(), e]));
    for (const [pathKey, tags] of findingAttachment.byPath) {
      if (byKey.has(pathKey.toLowerCase())) continue;
      const raw = tags[0] ? String(tags[0].finding.__surface_path || pathKey) : pathKey;
      // Prefer inventory-key parse (`host:port|web|/path`) — parseSurfaceRef only accepts URLs/paths.
      const parsed = parseSurfaceInventoryKey(raw) || parseSurfaceRef(raw);
      if (!parsed) continue;
      const entry = toSurfaceEntry(parsed, { source: "finding" });
      byKey.set(entry.key.toLowerCase(), entry);
    }
    return Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key));
  }, [baseSurfaceEntries, findingAttachment]);
  const findingsByPath = findingAttachment.byPath;
  const unlinkedFindings = findingAttachment.unlinked;
  const surfaceTree = useMemo(() => buildSurfaceTree(surfaceEntries, findingsByPath), [surfaceEntries, findingsByPath]);
  const surfaceItems = surfaceEntries;
  // Unique findings on routes (1:1 with Findings list items that have a path).
  const surfaceLinkedCount = findingAttachment.linkedUnique;
  const surfaceFindingsTotal = findings.length;
  // Kind chip counts — exclusive, matches Findings group sizes (Vuln / Key / Flags).
  const surfaceKindCounts = findingAttachment.kindCounts;
  const orderedStrixAgents = orderStrixAgents(strixAgents);
  const kanbanSummary = normalizeKanban(kanban, planTree, progress, workflowKind);
  const isStrixWorkflow = workflowKind === "strix" || kanbanSummary.workflow_kind === "strix" || planTree.some((node) => String(node.source || "") === "strix_todo");
  // Unified right-panel layout (Node3 baseline) for both Strix and Node2/pentest.
  // If the conversation is no longer running, never leave Main/Worker agents stuck on "running"
  // (stale checkpoint.panel_agents can lag behind conversation status).
  const displayAgents = normalizeAgentsForConversationRunning(
    orderedStrixAgents.length > 0
      ? orderedStrixAgents
      : synthesizeMainAgent(activeTool, running, workflowKind),
    running,
  );
  const hasStatusData = running || Boolean(activeTool) || planTree.length > 0 || displayAgents.length > 0 || findings.length > 0 || assets.length > 0 || timeline.length > 0 || Boolean(strixRun) || Boolean(caseRun?.started_at || caseRun?.llm_usage?.total_tokens) || Boolean(engagementCloseout && Object.keys(engagementCloseout).length);
  const visiblePlanTree = isStrixWorkflow ? mainAgentPlanTree(planTree, displayAgents) : planTree;
  const phasePlan = hasStatusData ? buildPhasePlan(visiblePlanTree, kanbanSummary.current_stage, activeTool, running, findings.length, isStrixWorkflow) : [];
  // Node3-style flat task list for all workflows (phase tree remains available via plan data).
  // Trust plan_tree status only — do not force pending/running → done from conversation.status
  // (that caused false-green todos when status/running lagged open checklist items).
  const taskItems = isStrixWorkflow
    ? phasePlan.flatMap((phase) => phase.items)
    : unifiedTodoItems(visiblePlanTree);
  const displayRun = useMemo(
    () => mergeCaseRunIntoDisplayRun(strixRun, caseRun, running),
    [strixRun, caseRun, running],
  );
  // Prefer the larger of kanban.elapsed_seconds and the run start/end window so
  // Elapsed stays aligned with Started/Ended even when conversation row times lag.
  const elapsedBaseSeconds = Math.max(
    normalizeSeconds(kanbanSummary.elapsed_seconds),
    elapsedSecondsFromRun(displayRun || strixRun, running),
    elapsedSecondsFromCaseRun(caseRun, running),
  );
  const intake = normalizeIntake(intakeResult, intakeStatus);
  const [elapsedClock, setElapsedClock] = useState(() => ({ seconds: elapsedBaseSeconds, anchorSeconds: elapsedBaseSeconds, anchorMs: Date.now() }));
  const [panelWidth, setPanelWidth] = useState(loadRightPanelWidth);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    setElapsedClock((current) => {
      if (running && elapsedBaseSeconds <= current.seconds) return current;
      return { seconds: elapsedBaseSeconds, anchorSeconds: elapsedBaseSeconds, anchorMs: Date.now() };
    });
  }, [elapsedBaseSeconds]);

  useEffect(() => {
    if (!running) {
      setElapsedClock((current) => ({ seconds: elapsedBaseSeconds, anchorSeconds: elapsedBaseSeconds, anchorMs: Date.now() }));
      return;
    }
    const update = () => {
      const nowMs = Date.now();
      setElapsedClock((current) => {
        const seconds = current.anchorSeconds + Math.floor((nowMs - current.anchorMs) / 1000);
        return seconds === current.seconds ? current : { ...current, seconds };
      });
    };
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [elapsedBaseSeconds, running]);

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

  const elapsedText = formatDuration(elapsedClock.seconds);
  const findingGroups = groupFindingsByKind(findings);
  const findingsTabTitle = findingsTabHoverTitle(findingGroups);
  const tabs: { key: Tab; label: string; title?: string }[] = [
    { key: "status", label: "Status" },
    { key: "surface", label: countLabel("Surface", surfaceItems.length) },
    { key: "findings", label: countLabel("Findings", findings.length), title: findingsTabTitle },
    { key: "activity", label: countLabel("Activity", timeline.length) },
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
      <div className="flex-1 overflow-y-auto p-4">
        {tab === "status" && (
          <div className="space-y-4">
            {/* Run summary: elapsed / budget (tokens·cost) / targets (asset context) */}
            {displayRun ? (
              <StrixRunSummary run={displayRun} elapsedText={elapsedText} />
            ) : (
              <section>
                <p className="mb-1 text-xs text-ink-muted">Elapsed</p>
                <p className="font-mono text-xl font-semibold leading-none tracking-normal">{elapsedText}</p>
              </section>
            )}
            {/* Case multi-role roster (one root per product expert / default seat) */}
            {displayAgents.length > 0 && (
              <section>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-xs text-ink-muted">
                    {displayAgents.filter((a) => !a.parent_id).length > 1 ? "Case participants" : "Agent collaboration"}
                  </p>
                  <p className="font-mono text-[11px] text-ink-muted">{agentStatusCount(displayAgents)}</p>
                </div>
                <StrixAgentList agents={displayAgents} />
              </section>
            )}
            {/* Intentional TODO / work packages — Expert Graph L1 stages + L2 todos when present */}
            <section>
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs text-ink-muted">Tasks</p>
                {taskItems.length > 0 && (
                  <p className="font-mono text-[11px] text-ink-muted">
                    {taskItems.filter((item) => isTerminalPlanStatus(item.status)).length}/{taskItems.length}
                  </p>
                )}
              </div>
              <GraphAwareTodoList planTree={visiblePlanTree} workItems={taskItems} running={running} />
            </section>
            {engagementCloseout && Object.keys(engagementCloseout).length > 0 && (
              <EngagementCloseoutCard closeout={engagementCloseout} />
            )}
            {intake && <IntakeSummary intake={intake} />}
          </div>
        )}
        {tab === "surface" && (
          surfaceItems.length === 0 ? (
            <p className="text-sm text-ink-muted">No attack surface recorded yet</p>
          ) : (
            <SurfaceTreeView
              roots={surfaceTree}
              total={surfaceItems.length}
              linkedCount={surfaceLinkedCount}
              findingsTotal={surfaceFindingsTotal}
              kindCounts={surfaceKindCounts}
              unlinked={unlinkedFindings}
              onOpenVulnerability={onOpenVulnerability}
            />
          )
        )}
        {tab === "findings" && (
          findings.length === 0 ? (
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
          )
        )}
        {tab === "activity" && <TimelineList events={timeline} cursorAt={timelineCursorAt} />}
      </div>
    </aside>
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

function StrixRunSummary({ run, elapsedText }: { run: StrixRun; elapsedText: string }) {
  const usage = run.llm_usage || {};
  const targets = Array.isArray(run.targets_info) ? run.targets_info : [];
  const hasUsage = Number(usage.total_tokens || usage.requests || 0) > 0;
  const hasTargets = targets.some((target) => target.target || target.original);
  if (!run.start_time && !run.end_time && !hasTargets && !hasUsage) return null;
  return (
    <section className="space-y-3 text-xs">
      <TimeSummary elapsedText={elapsedText} startTime={run.start_time} endTime={run.end_time} />
      {hasUsage && <LlmUsageSummary usage={usage} />}
      {hasTargets && <TargetSummary targets={targets} />}
    </section>
  );
}

function TimeSummary({ elapsedText, startTime, endTime }: { elapsedText: string; startTime?: string; endTime?: string }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <div className="min-w-0 px-2 py-1">
        <SummarySubLabel>Elapsed</SummarySubLabel>
        <p className="mt-0.5 font-mono text-xl font-semibold leading-none text-ink">{elapsedText}</p>
      </div>
      <div className="min-w-0 px-2 py-1">
        <SummarySubLabel>Started</SummarySubLabel>
        <SummaryValue>{startTime ? formatDateTime(startTime) : "-"}</SummaryValue>
      </div>
      <div className="min-w-0 px-2 py-1">
        <SummarySubLabel>Ended</SummarySubLabel>
        <SummaryValue>{endTime ? formatDateTime(endTime) : "-"}</SummaryValue>
      </div>
    </div>
  );
}

function LlmUsageSummary({ usage }: { usage: NonNullable<StrixRun["llm_usage"]> }) {
  const tokenDetail = `Input: ${formatNumber(usage.input_tokens)}\nOutput: ${formatNumber(usage.output_tokens)}\nCached: ${formatNumber(usage.cached_tokens)}\nReasoning: ${formatNumber(usage.reasoning_tokens)}`;
  return (
    <div className="grid grid-cols-3 gap-2">
      <div className="min-w-0 px-2 py-1">
        <SummarySubLabel>Requests</SummarySubLabel>
        <SummaryValue>{formatNumber(usage.requests)}</SummaryValue>
      </div>
      <div className="min-w-0 px-2 py-1" title={tokenDetail}>
        <SummarySubLabel>Tokens</SummarySubLabel>
        <SummaryValue>{formatCompactNumber(usage.total_tokens)}</SummaryValue>
      </div>
      <div className="min-w-0 px-2 py-1">
        <SummarySubLabel>Cost</SummarySubLabel>
        <SummaryValue>{Number(usage.cost || 0) > 0 ? `$${formatCost(usage.cost)}` : "-"}</SummaryValue>
      </div>
    </div>
  );
}

function TargetSummary({ targets }: { targets: NonNullable<StrixRun["targets_info"]> }) {
  const items = targets.map((target) => ({
    type: target.type || "target",
    value: target.target || target.original || "",
  })).filter((target) => target.value);
  if (!items.length) return null;
  return (
    <div className="min-w-0">
      <SummaryLabel>Target</SummaryLabel>
      <div className="space-y-1">
        {items.map((target, index) => (
          <div key={`${target.value}-${index}`} className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded-sm bg-canvas-inset px-1.5 py-0.5 text-[10px] uppercase text-ink-secondary">{target.type}</span>
            <span className="min-w-0 break-words font-mono text-xs font-medium text-ink [overflow-wrap:anywhere]">{target.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SummaryLabel({ children }: { children: ReactNode }) {
  return <p className="mb-1 text-xs text-ink-muted">{children}</p>;
}

function SummarySubLabel({ children }: { children: ReactNode }) {
  return <p className="text-[10px] text-ink-muted">{children}</p>;
}

function SummaryValue({ children }: { children: ReactNode }) {
  return <p className="mt-0.5 min-w-0 break-words font-mono text-sm font-medium text-ink [overflow-wrap:anywhere]">{children}</p>;
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

function TimelineList({ events, cursorAt }: { events: TimelineEvent[]; cursorAt?: string }) {
  if (!events.length) return <p className="text-sm text-ink-muted">No activity yet</p>;
  const cursorMs = cursorAt ? new Date(cursorAt).getTime() : Number.POSITIVE_INFINITY;
  return (
    <div className="space-y-0" data-testid="workflow-timeline">
      {events.map((event, index) => {
        const eventMs = event.at ? new Date(event.at).getTime() : Number.NEGATIVE_INFINITY;
        const occurred = Number.isFinite(cursorMs) && Number.isFinite(eventMs) ? eventMs <= cursorMs : true;
        return (
          <div key={event.id || index} className={`relative flex min-w-0 gap-2 pb-3 transition-opacity last:pb-0 ${occurred ? "opacity-100" : "opacity-35"}`}>
            {index < events.length - 1 && <span aria-hidden="true" className={`absolute left-[5px] top-3 h-full w-px ${occurred ? "bg-hairline-soft" : "bg-hairline-soft/60"}`} />}
            <span aria-hidden="true" className={`relative mt-1 h-2.5 w-2.5 shrink-0 rounded-full border ${occurred ? timelineDotClass(event.category, event.status) : "border-hairline bg-canvas"}`} />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <p className={`min-w-0 break-words text-sm font-medium [overflow-wrap:anywhere] ${occurred ? "text-ink" : "text-ink-muted"}`}>{event.title}</p>
                {event.at && <time className="shrink-0 font-mono text-[10px] text-ink-muted">{formatTimelineTime(event.at)}</time>}
              </div>
              <div className="mt-0.5 flex min-w-0 items-start gap-2">
                <span className="shrink-0 rounded-sm bg-canvas-inset px-1.5 py-0.5 text-[10px] text-ink-secondary">{timelineCategoryLabel(event.category)}</span>
                {event.detail && <p className="min-w-0 break-words text-[11px] text-ink-muted [overflow-wrap:anywhere]">{event.detail}</p>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
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
 */
function unifiedTodoItems(nodes: PlanNode[]): PlanNode[] {
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

  return deduped
    .sort((left, right) => {
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
    })
    .slice(0, 40);
}

function synthesizeMainAgent(activeTool: string | undefined, running: boolean, workflowKind?: string): StrixAgentStatus[] {
  // Only synthesize for pentest/Node2 when the platform did not send multi-agent rows.
  if (workflowKind === "strix") return [];
  if (!running && !activeTool) return [];
  const tool = String(activeTool || "").trim();
  return [{
    id: "node4-main",
    name: "Agent",
    status: running ? "running" : "completed",
    parent_id: null,
    task: "",
    skills: [],
    pending_count: 0,
    role: "main",
    current_tool: tool,
    current_action: running ? (tool ? "tool_running" : "llm_waiting") : "finished",
    current_detail: running
      ? (tool ? `正在${friendlyToolLabel(tool)}` : "等待模型思考与回复")
      : "本轮工作已结束",
  }];
}

/** Align collaboration tree with conversation lifecycle (timer already stopped when running=false). */
function normalizeAgentsForConversationRunning(agents: StrixAgentStatus[], running: boolean): StrixAgentStatus[] {
  if (running || agents.length === 0) return agents;
  const open = new Set(["running", "pending", "todo", "llm_waiting", "tool_running", "working", "chat", "starting", ""]);
  return agents.map((agent) => {
    const status = String(agent.status || "").toLowerCase();
    if (!open.has(status)) return agent;
    return {
      ...agent,
      status: "completed",
      current_tool: "",
      current_action: "finished",
      current_detail: "本轮工作已结束",
      pending_count: 0,
    };
  });
}

function hasRunSummaryData(run: StrixRun | undefined): boolean {
  if (!run) return false;
  const usage = run.llm_usage || {};
  const targets = Array.isArray(run.targets_info) ? run.targets_info : [];
  return Boolean(
    run.start_time ||
    run.end_time ||
    run.scan_mode ||
    Number(usage.total_tokens || usage.requests || 0) > 0 ||
    targets.some((target) => target.target || target.original),
  );
}

/** Fold Case multi-role rollup (tokens/start) into the Status top strip. */
function mergeCaseRunIntoDisplayRun(
  run: StrixRun | undefined,
  caseRun: CaseRunSummary | undefined,
  _running: boolean,
): StrixRun | undefined {
  const base = run && hasRunSummaryData(run) ? { ...run, llm_usage: { ...(run.llm_usage || {}) } } : undefined;
  const crUsage = caseRun?.llm_usage || {};
  const crTokens = Number(crUsage.total_tokens || 0);
  const crCost = Number(crUsage.cost || 0);
  const crRequests = Number(crUsage.requests || 0);
  if (!base && !caseRun) return undefined;
  if (!base) {
    if (!crTokens && !caseRun?.started_at && !crRequests) return undefined;
    return {
      start_time: caseRun?.started_at,
      llm_usage: {
        total_tokens: crTokens || undefined,
        cost: crCost || undefined,
        requests: crRequests || undefined,
        agent_count: caseRun?.participant_count,
      },
    };
  }
  const baseTokens = Number(base.llm_usage?.total_tokens || 0);
  if (crTokens > baseTokens) {
    base.llm_usage = {
      ...base.llm_usage,
      total_tokens: crTokens,
      cost: Math.max(Number(base.llm_usage?.cost || 0), crCost),
      requests: Math.max(Number(base.llm_usage?.requests || 0), crRequests),
      agent_count: Math.max(
        Number(base.llm_usage?.agent_count || 0),
        Number(caseRun?.participant_count || 0),
      ) || undefined,
    };
  }
  if (!base.start_time && caseRun?.started_at) {
    base.start_time = caseRun.started_at;
  }
  return hasRunSummaryData(base) ? base : undefined;
}

function elapsedSecondsFromCaseRun(caseRun: CaseRunSummary | undefined, running: boolean): number {
  if (!caseRun?.started_at) return 0;
  const start = Date.parse(caseRun.started_at);
  if (!Number.isFinite(start)) return 0;
  const endRaw = running ? Date.now() : Date.parse(String(caseRun.last_active_at || "")) || Date.now();
  if (!Number.isFinite(endRaw) || endRaw < start) return 0;
  return Math.max(0, Math.floor((endRaw - start) / 1000));
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

function timelineCategoryLabel(category: string): string {
  const normalized = category.toLowerCase();
  if (normalized === "workflow") return "Workflow";
  if (normalized === "task") return "Task";
  if (normalized === "finding") return "Finding";
  if (normalized === "asset") return "Asset";
  if (normalized === "approval") return "Approval";
  if (normalized === "gate") return "Gate";
  if (normalized === "status") return "Status";
  return category;
}

function timelineDotClass(category: string, status?: string): string {
  const normalized = `${category} ${status || ""}`.toLowerCase();
  if (normalized.includes("blocked") || normalized.includes("fail") || normalized.includes("error")) return "border-severity-critical bg-severity-critical";
  if (normalized.includes("finding") || normalized.includes("vulnerability")) return "border-severity-high bg-severity-high";
  if (normalized.includes("evidence")) return "border-status-success bg-status-success";
  if (normalized.includes("workflow")) return "border-ink bg-ink";
  return "border-hairline bg-canvas";
}


function formatTimelineTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function isTerminalPlanStatus(status: PlanStatus | undefined): boolean {
  return status === "done" || status === "blocked" || status === "failed" || status === "skipped";
}

function planItemDotClass(status: string): string {
  if (status === "running") return "bg-ink";
  if (isTerminalPlanStatus(status)) return "bg-hairline";
  return "bg-canvas-inset";
}

function normalizeSeconds(seconds: unknown): number {
  const value = Number(seconds || 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Total run seconds from StrixRun start/end (or start→now while running). */
function elapsedSecondsFromRun(run: StrixRun | undefined, running: boolean): number {
  if (!run?.start_time) return 0;
  const startMs = Date.parse(run.start_time);
  if (!Number.isFinite(startMs)) return 0;
  let endMs: number;
  if (run.end_time) {
    endMs = Date.parse(run.end_time);
  } else if (running) {
    endMs = Date.now();
  } else {
    return 0;
  }
  if (!Number.isFinite(endMs) || endMs < startMs) return 0;
  return Math.floor((endMs - startMs) / 1000);
}

function formatDuration(seconds: unknown): string {
  const total = normalizeSeconds(seconds);
  if (total <= 0) return "00:00";
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (item: number) => String(item).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatNumber(value: unknown): string {
  const numberValue = Number(value || 0);
  if (!Number.isFinite(numberValue) || numberValue <= 0) return "0";
  return new Intl.NumberFormat().format(numberValue);
}

function formatCompactNumber(value: unknown): string {
  const numberValue = Number(value || 0);
  if (!Number.isFinite(numberValue) || numberValue <= 0) return "0";
  return new Intl.NumberFormat([], { notation: "compact", maximumFractionDigits: 1 }).format(numberValue);
}

function formatCost(value: unknown): string {
  const numberValue = Number(value || 0);
  if (!Number.isFinite(numberValue) || numberValue <= 0) return "0";
  return numberValue < 0.01 ? numberValue.toFixed(4) : numberValue.toFixed(2);
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
