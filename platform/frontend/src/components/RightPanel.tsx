import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Bot, CheckCircle2, ChevronDown, ChevronRight, Circle, CircleDashed, GitBranch, Search, Tag, XCircle } from "lucide-react";
import type { SecurityAsset, SecurityVulnerability } from "../lib/securityTypes";

type Tab = "status" | "surface" | "findings" | "activity";
type PlanStatus = "todo" | "pending" | "running" | "done" | "skipped" | "blocked" | "failed" | string;
type WorkflowPhaseId = "recon" | "testing" | "verification" | "summary";

type PlanNode = {
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
};

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

type StrixAgentStatus = {
  id: string;
  name: string;
  status: string;
  parent_id?: string | null;
  task?: string;
  skills?: string[];
  pending_count?: number;
  role?: string;
  current_tool?: string;
  current_action?: string;
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
  timeline?: TimelineEvent[];
  timelineCursorAt?: string;
  findings?: Array<Record<string, unknown>>;
  assets?: Array<Record<string, unknown>>;
  /** Authorized engagement from conversation.context.task (target + scope.allow). */
  taskContext?: Record<string, unknown>;
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
  planTree = [],
  strixAgents = [],
  strixNotes = [],
  strixRun,
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
  const displayAgents = orderedStrixAgents.length > 0
    ? orderedStrixAgents
    : synthesizeMainAgent(activeTool, running, workflowKind);
  const hasStatusData = running || Boolean(activeTool) || planTree.length > 0 || displayAgents.length > 0 || findings.length > 0 || assets.length > 0 || timeline.length > 0 || Boolean(strixRun);
  const visiblePlanTree = isStrixWorkflow ? mainAgentPlanTree(planTree, displayAgents) : planTree;
  const phasePlan = hasStatusData ? buildPhasePlan(visiblePlanTree, kanbanSummary.current_stage, activeTool, running, findings.length, isStrixWorkflow) : [];
  // Node3-style flat task list for all workflows (phase tree remains available via plan data).
  const taskItems = isStrixWorkflow
    ? phasePlan.flatMap((phase) => phase.items)
    : unifiedTodoItems(visiblePlanTree);
  const displayRun = strixRun && hasRunSummaryData(strixRun) ? strixRun : undefined;
  const elapsedBaseSeconds = normalizeSeconds(kanbanSummary.elapsed_seconds);
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
      className={`relative flex flex-shrink-0 flex-col border-l border-hairline bg-canvas ${resizing ? "select-none" : ""}`}
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
            {/* Agent collaboration tree */}
            {displayAgents.length > 0 && (
              <section>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-xs text-ink-muted">Agent collaboration</p>
                  <p className="font-mono text-[11px] text-ink-muted">{agentStatusCount(displayAgents)}</p>
                </div>
                <StrixAgentList agents={displayAgents} />
              </section>
            )}
            {/* Intentional TODO / work packages — not coverage mark noise */}
            <section>
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs text-ink-muted">Tasks</p>
                {taskItems.length > 0 && (
                  <p className="font-mono text-[11px] text-ink-muted">
                    {taskItems.filter((item) => isTerminalPlanStatus(item.status)).length}/{taskItems.length}
                  </p>
                )}
              </div>
              <StrixTodoList items={taskItems} running={running} />
            </section>
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
                      <button
                        key={(finding.id as string) || (finding.vulnerability_id as string) || `${group.id}-${index}`}
                        type="button"
                        onClick={() => {
                          const resolved =
                            resolveFindingSurfaceKey(
                              finding,
                              surfaceKeyList,
                              new Set(surfaceKeyList.map((p) => p.toLowerCase())),
                              surfaceEntries,
                            ) || String((finding as { __surface_path?: string }).__surface_path || "");
                          onOpenVulnerability?.({
                            ...(finding as Partial<SecurityVulnerability>),
                            finding_kind: group.id === "auth" ? "auth" : group.id,
                            kind: group.id === "auth" ? "auth" : group.id,
                            category: group.id === "auth" ? "auth" : group.id,
                            __surface_kind: group.id === "auth" ? "key" : group.id,
                            ...(resolved
                              ? {
                                  __surface_path: resolved,
                                  __surface_display: surfaceKeyToDisplay(resolved),
                                }
                              : {}),
                          } as Partial<SecurityVulnerability>);
                        }}
                        className="block w-full rounded-md border border-hairline-soft p-2 text-left transition-colors hover:bg-surface-default"
                      >
                        <div className="mb-1 flex min-w-0 items-center gap-1">
                          {group.id === "vuln" ? (
                            <span className={`inline-block shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase ${severityBadgeClass(finding.severity)}`}>
                              {normalizeFindingSeverity(finding.severity)}
                            </span>
                          ) : group.id === "auth" ? (
                            (() => {
                              const sub = classifyAuthSubtype(finding);
                              return (
                                <span className={`inline-block shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase ${sub.badgeClass}`}>
                                  {sub.label}
                                </span>
                              );
                            })()
                          ) : (
                            <span className={`inline-block shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase ${group.badgeClass}`}>
                              {group.shortLabel}
                            </span>
                          )}
                          <span className="truncate text-sm font-medium">{findingDisplayTitle(finding, group.id)}</span>
                        </div>
                        <p className="break-words text-xs text-ink-muted">{findingMetaLine(finding, group.id)}</p>
                      </button>
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
          <div key={`${target.value}-${index}`} className="flex min-w-0 items-start gap-2">
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

function StrixTodoList({ items, running = false }: { items: PlanNode[]; running?: boolean }) {
  if (!items.length) {
    return (
      <p className="text-sm text-ink-muted">
        {running
          ? "Waiting for structured tasks (workers / coverage plan)"
          : "No structured task plan — worker packages and coverage(plan) items show here"}
      </p>
    );
  }
  // Keep caller sort (active-first for Node2); do not re-sort by priority alone.
  return (
    <div className="space-y-1" data-testid="strix-todo-list">
      {items.map((item, index) => <StrixTodoItem key={planNodeKey(item, index)} item={item} />)}
    </div>
  );
}

function StrixTodoItem({ item }: { item: PlanNode }) {
  const status = normalizeTodoStatus(item.status);
  const Icon = todoStatusIcon(status);
  const isWorker = String(item.kind || "") === "worker" || String(item.source || "") === "worker";
  const workerBadge = isWorker ? workerOutcomeBadge(item) : null;
  const isFollowUp =
    String(item.source || "") === "worker" &&
    (/^follow-up\b/i.test(String(item.title || "")) || String(item.node_id || item.id || "").startsWith("plan-followup-"));
  // Show more of adjustment advice on failed follow-ups.
  const noteLimit = isFollowUp && (status === "failed" || workerBadge?.label === "failed") ? 320 : 150;
  return (
    <div className="flex min-w-0 items-start gap-2 rounded-md px-2 py-2 hover:bg-canvas-inset">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${todoStatusIconClass(status)}`} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <p className={`min-w-0 break-words text-sm font-medium [overflow-wrap:anywhere] ${todoTitleClass(status)}`}>{String(item.title || "Untitled task")}</p>
          {workerBadge && (
            <span className={`shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase ${workerBadge.className}`}>{workerBadge.label}</span>
          )}
        </div>
        {item.notes && (
          <p
            className="mt-0.5 break-words text-xs text-ink-muted [overflow-wrap:anywhere] whitespace-pre-wrap"
            title={String(item.notes)}
          >
            {clip(item.notes, noteLimit)}
          </p>
        )}
      </div>
    </div>
  );
}

function workerOutcomeBadge(item: PlanNode): { label: string; className: string } | null {
  const notes = String(item.notes || "").toLowerCase();
  const title = String(item.title || "").toLowerCase();
  const status = String(item.status || "").toLowerCase();
  const isFollowUp =
    String(item.source || "") === "worker" &&
    (/^follow-up\b/i.test(String(item.title || "")) || String(item.node_id || item.id || "").startsWith("plan-followup-"));

  if (status === "running") return { label: "running", className: "bg-status-running/15 text-status-running" };

  // Follow-up rows: explicit retry / failed / resolved (not the same as worker timeout chip).
  if (isFollowUp) {
    if (status === "done" || status === "completed" || /\[resolved\]/.test(title)) {
      return { label: "resolved", className: "bg-status-success/15 text-status-success" };
    }
    if (status === "failed" || /\[failed\]/.test(title) || /retries exhausted|adjustment suggestions/.test(notes)) {
      return { label: "failed", className: "bg-severity-critical-subtle text-severity-critical" };
    }
    if (status === "pending" || /\[retry\]/.test(title) || /retry budget/.test(notes)) {
      return { label: "retry", className: "bg-status-running/12 text-status-running" };
    }
    if (/\[timeout\]/.test(title) || status === "blocked") {
      return { label: "follow-up", className: "bg-severity-high-subtle text-severity-high" };
    }
  }

  if (/\[timeout\]|timed out|timeout/.test(notes) || /\[timeout\]/.test(title) || status === "blocked") {
    return { label: "timeout", className: "bg-severity-high-subtle text-severity-high" };
  }
  if (status === "failed" || /\[failed\]|\[aborted\]/.test(notes)) {
    return { label: status === "failed" && /abort/.test(notes) ? "aborted" : "failed", className: "bg-severity-critical-subtle text-severity-critical" };
  }
  if (status === "done" || status === "completed") {
    return { label: "done", className: "bg-status-success/15 text-status-success" };
  }
  return { label: status || "pending", className: "bg-canvas-inset text-ink-secondary" };
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

function StrixAgentList({ agents }: { agents: StrixAgentStatus[] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const roots = agents.filter((agent) => !agent.parent_id);
  const rootAgents = roots.length ? roots : agents.slice(0, 1);
  const childrenByParent = new Map<string, StrixAgentStatus[]>();
  const rootIds = new Set(rootAgents.map((agent) => agent.id));
  for (const agent of agents) {
    if (rootIds.has(agent.id)) continue;
    const parentId = agent.parent_id && agents.some((candidate) => candidate.id === agent.parent_id) ? agent.parent_id : rootAgents[0]?.id || "";
    if (!parentId) continue;
    childrenByParent.set(parentId, [...(childrenByParent.get(parentId) || []), agent]);
  }
  const renderAgentNode = (agent: StrixAgentStatus, primary = false, trail: string[] = [], lastSibling = true): ReactNode => {
    const children = childrenByParent.get(agent.id) || [];
    const open = expanded[agent.id] ?? true;
    const canToggle = children.length > 0;
    const nextTrail = [...trail, agent.id];
    const hasVisibleChildren = children.length > 0 && open;
    if (trail.includes(agent.id)) return null;
    return (
      <div key={agent.id} className="relative min-w-0">
        {!primary && (
          <>
            <svg
              aria-hidden="true"
              viewBox="0 0 26 28"
              className="pointer-events-none absolute -left-1.5 top-0 h-7 w-[26px] text-hairline"
              fill="none"
            >
              <path d="M0 0 V14 Q0 20 6 20 H16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            {!lastSibling && <span aria-hidden="true" className="pointer-events-none absolute bottom-0 -left-1.5 top-[21px] w-px bg-hairline" />}
          </>
        )}
        <div className="relative">
          {hasVisibleChildren && <span aria-hidden="true" className="pointer-events-none absolute bottom-0 left-[18px] top-[26px] w-px bg-hairline" />}
          <AgentRow
            agent={agent}
            primary={primary}
            secondary={!primary}
            childCount={children.length}
            expanded={open}
            onToggle={canToggle ? () => setExpanded((current) => ({ ...current, [agent.id]: !open })) : undefined}
          />
        </div>
        {children.length > 0 && (
          <>
            {open && <span aria-hidden="true" className="pointer-events-none block h-1 w-px bg-hairline ml-[18px]" />}
            <div className={`${open ? "block" : "hidden"} space-y-1 pl-6`}>
              {children.map((child, index) => renderAgentNode(child, false, nextTrail, index === children.length - 1))}
            </div>
          </>
        )}
      </div>
    );
  };
  return (
    <div className="space-y-1" data-testid="strix-agent-status">
      {rootAgents.map((agent) => renderAgentNode(agent, true))}
    </div>
  );
}

function AgentRow({
  agent,
  primary = false,
  secondary = false,
  childCount = 0,
  expanded = false,
  onToggle,
}: {
  agent: StrixAgentStatus;
  primary?: boolean;
  secondary?: boolean;
  childCount?: number;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const summary = summarizeAgentAction(agent);
  const status = agentStatusLabel(agent.status);
  const rowInteractive = Boolean(onToggle);
  const handleRowKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!rowInteractive) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onToggle?.();
  };
  return (
    <div
      className={`min-w-0 rounded-md py-2 pr-2 pl-3.5 bg-transparent ${rowInteractive ? "cursor-pointer hover:bg-canvas-inset focus-visible:outline focus-visible:outline-2 focus-visible:outline-status-running/40" : "hover:bg-canvas-inset"}`}
      onClick={rowInteractive ? onToggle : undefined}
      onKeyDown={handleRowKeyDown}
      role={rowInteractive ? "button" : undefined}
      tabIndex={rowInteractive ? 0 : undefined}
      aria-expanded={rowInteractive ? expanded : undefined}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span aria-hidden="true" className={`mt-2 h-2 w-2 shrink-0 rounded-full ${agentStatusDotClass(agent.status)}`} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-1.5">
                <AgentRoleBadge primary={primary} />
                <p className="min-w-0 flex-1 truncate text-sm font-medium">{agent.name || agent.id}</p>
              </div>
              <p className="mt-0.5 text-xs text-ink-secondary">{summary}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {childCount > 0 && <span className="font-mono text-[10px] text-ink-muted" title={`${childCount} sub-agents`}>{childCount}</span>}
              <span className={`rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase ${agentStatusBadgeClass(agent.status)}`}>{status}</span>
            </div>
          </div>
          <AgentMeta agent={agent} primary={primary && !secondary} />
        </div>
      </div>
    </div>
  );
}

function AgentRoleBadge({ primary }: { primary: boolean }) {
  const Icon = primary ? Bot : GitBranch;
  const label = primary ? "Main Agent" : "Sub Agent";
  return (
    <span
      title={label}
      aria-label={label}
      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center ${primary ? "text-ink" : "text-ink-muted"}`}
    >
      <Icon className="h-3 w-3" />
    </span>
  );
}

function AgentMeta({ agent, primary }: { agent: StrixAgentStatus; primary: boolean }) {
  const skills = Array.isArray(agent.skills) ? agent.skills.slice(0, primary ? 4 : 5) : [];
  const pendingCount = Number(agent.pending_count || 0);
  if (!skills.length && pendingCount <= 0) return null;
  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {pendingCount > 0 && <span className="rounded-sm bg-canvas-inset px-1.5 py-0.5 text-[10px] text-ink-muted" title="Queued messages or actions waiting for this agent">{pendingCount} queued</span>}
      {skills.map((skill) => <AgentSkillBadge key={skill} skill={skill} />)}
    </div>
  );
}

function AgentSkillBadge({ skill }: { skill: string }) {
  return (
    <span
      title={`Strix skill: ${skill}`}
      className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-sm bg-canvas-inset px-1.5 py-0.5 text-[10px] text-ink-muted"
    >
      <Tag className="h-3 w-3 shrink-0" />
      <span className="truncate">{friendlySkillName(skill)}</span>
    </span>
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

  return nodes
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
    })
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
  return [{
    id: "node2-main",
    name: "Main Agent",
    status: running ? "running" : "completed",
    parent_id: null,
    task: "",
    skills: [],
    pending_count: 0,
    role: "main",
    current_tool: activeTool || "",
    current_action: running ? "working" : "done",
  }];
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
type SurfaceEntry = {
  key: string;
  host: string;
  port: string;
  origin: string;
  service: string;
  path: string;
  method: string | null;
  source?: string;
  title?: string;
  /** Stable group for one logical asset (merges IP / private / docker aliases). */
  assetKey?: string;
  /** Root label shown in the tree (asset name or primary host). */
  assetLabel?: string;
  /** Other hostnames/IPs observed for the same asset. */
  hostAliases?: string[];
  /** Authorized engagement target (from task.target / scope.allow). */
  isTarget?: boolean;
  /** Discovered later (SSRF/internal/out-of-scope probe) — not the user TARGET. */
  isDiscovered?: boolean;
};

/** Parsed engagement targets for Surface classification. */
type EngagementTarget = {
  raw: string;
  host: string;
  port: string;
  origin: string;
};

type ParsedSurfaceRef = {
  host: string;
  port: string;
  origin: string;
  path: string;
  service: string;
  method: string;
};

/** Legacy adapter for kanban totals (counts inventory size). */
function attackSurfaceItems(nodes: PlanNode[], findings: Array<Record<string, unknown>> = []): PlanNode[] {
  return collectSurfaceEntries(nodes, [], findings, []).map((e) => ({
    endpoint: e.key,
    method: e.method,
    title: e.title || e.key,
    kind: "surface",
    level: "work_item",
    source: e.source,
  }));
}

function parseEngagementTargets(taskContext?: Record<string, unknown>): EngagementTarget[] {
  if (!taskContext) return [];
  const values: string[] = [];
  const target = taskContext.target;
  if (typeof target === "string" && target.trim()) values.push(target.trim());
  if (target && typeof target === "object") {
    const v = String((target as Record<string, unknown>).value || (target as Record<string, unknown>).url || "").trim();
    if (v) values.push(v);
  }
  const scope = taskContext.scope;
  if (scope && typeof scope === "object") {
    const allow = (scope as Record<string, unknown>).allow;
    if (Array.isArray(allow)) {
      for (const a of allow) if (typeof a === "string" && a.trim()) values.push(a.trim());
    }
  }
  const out: EngagementTarget[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const parsed = parseSurfaceRef(raw);
    if (!parsed || !parsed.host) continue;
    const origin = parsed.port ? `${parsed.host}:${parsed.port}` : parsed.host;
    const key = origin.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw, host: parsed.host, port: parsed.port, origin });
  }
  return out;
}

function isEngagementTargetHost(host: string, port: string, targets: EngagementTarget[]): boolean {
  if (!targets.length || !host) return false;
  const h = host.toLowerCase();
  for (const t of targets) {
    if (t.host.toLowerCase() !== h) continue;
    // Port match when both known; host-only target matches any port on that host.
    if (!t.port || !port || t.port === port) return true;
  }
  return false;
}

function isEngagementTargetOrigin(origin: string, targets: EngagementTarget[]): boolean {
  if (!targets.length || !origin) return false;
  const o = origin.toLowerCase();
  return targets.some((t) => t.origin.toLowerCase() === o || t.host.toLowerCase() === o.split(":")[0]);
}

/**
 * Inventory hosts, ports/services, and web routes.
 * Roots are assets; engagement TARGET is preferred and badge-marked.
 */
function collectSurfaceEntries(
  nodes: PlanNode[],
  assets: Array<Record<string, unknown>> = [],
  findings: Array<Record<string, unknown>> = [],
  engagementTargets: EngagementTarget[] = [],
): SurfaceEntry[] {
  const byKey = new Map<string, SurfaceEntry>();

  const pushParsed = (parsed: ParsedSurfaceRef | null, extra?: Partial<SurfaceEntry>) => {
    if (!parsed) return;
    const entry = toSurfaceEntry(parsed, extra);
    const existing = byKey.get(entry.key.toLowerCase());
    if (!existing) {
      byKey.set(entry.key.toLowerCase(), entry);
      return;
    }
    const methods = mergeMethodList(existing.method, entry.method);
    byKey.set(entry.key.toLowerCase(), {
      ...existing,
      method: methods.length ? methods.join(",") : existing.method,
      source: existing.source || entry.source,
    });
  };

  const considerRaw = (raw: string, method?: string | null, source?: string, serviceHint?: string) => {
    const parsed = parseSurfaceRef(raw, method, serviceHint);
    pushParsed(parsed, { source });
  };

  for (const node of nodes) {
    if ((node.level || "work_item") !== "work_item") continue;
    const kind = String(node.kind || "");
    const blob = `${node.title || ""} ${node.notes || ""} ${node.endpoint || ""}`;
    const serviceHint = inferServiceFromText(blob);
    if (kind === "surface" || kind === "request") {
      considerRaw(String(node.endpoint || node.title || ""), node.method, node.source || "plan", serviceHint);
      continue;
    }
    if (node.endpoint && ["test", "http", "browser", "scan", "traffic", "worker"].includes(kind)) {
      considerRaw(String(node.endpoint), node.method, kind, serviceHint);
    }
    // Port-only discoveries from scan notes: "open 6379/tcp redis"
    for (const m of blob.matchAll(/\b(\d{2,5})\s*\/\s*tcp\b/gi)) {
      const port = m[1];
      const hostMatch = blob.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/) || blob.match(/\b([a-z0-9.-]+\.[a-z]{2,})\b/i);
      const host = hostMatch ? hostMatch[1] : "";
      if (!host) continue;
      const svc = inferServiceFromText(blob) || serviceFromPort(port);
      pushParsed(
        {
          host,
          port,
          origin: `${host}:${port}`,
          path: svc === "web" ? "/" : "",
          service: svc,
          method: "",
        },
        { source: "scan" },
      );
    }
  }

  // Assets: host + open ports / services
  for (const asset of assets) {
    const host = normalizeAssetHost(String(asset.address || asset.name || ""));
    if (!host) continue;
    const ports = Array.isArray(asset.open_ports)
      ? asset.open_ports
      : Array.isArray((asset.properties as Record<string, unknown> | undefined)?.open_ports)
        ? ((asset.properties as Record<string, unknown>).open_ports as unknown[])
        : [];
    const services = Array.isArray(asset.services)
      ? asset.services
      : Array.isArray((asset.properties as Record<string, unknown> | undefined)?.services)
        ? ((asset.properties as Record<string, unknown>).services as unknown[])
        : [];

    for (const p of ports) {
      const port = String(p).replace(/\/.*$/, "").trim();
      if (!/^\d{1,5}$/.test(port)) continue;
      let svc = serviceFromPort(port);
      for (const s of services) {
        const rec = s && typeof s === "object" ? (s as Record<string, unknown>) : {};
        const sp = String(rec.port || rec.port_id || "").trim();
        const name = String(rec.name || rec.service || rec.product || "").toLowerCase();
        if (sp === port || name) {
          if (name) svc = normalizeServiceName(name) || svc;
        }
      }
      pushParsed(
        {
          host,
          port,
          origin: `${host}:${port}`,
          path: svc === "web" ? "/" : "",
          service: svc,
          method: "",
        },
        { source: "asset" },
      );
    }
    // Host-only asset with no ports still appears as a host shell via empty port web root? skip.
  }

  for (const finding of findings) {
    for (const ref of extractSurfaceRefsFromFinding(finding)) {
      pushParsed(ref, { source: "finding" });
    }
  }

  // Always seed authorized engagement targets so TARGET root exists even before recon.
  for (const t of engagementTargets) {
    pushParsed(
      {
        host: t.host,
        port: t.port,
        origin: t.origin,
        path: "/",
        service: "web",
        method: "",
      },
      { source: "target" },
    );
  }

  // Collapse (target) / public IP / private IP / docker aliases into asset roots.
  return canonicalizeSurfaceEntries(Array.from(byKey.values()), assets, engagementTargets);
}

function toSurfaceEntry(parsed: ParsedSurfaceRef, extra?: Partial<SurfaceEntry>): SurfaceEntry {
  const path = parsed.service === "web" ? parsed.path || "/" : parsed.path || "";
  const key =
    parsed.service === "web"
      ? `${parsed.origin}|web|${path}`
      : `${parsed.origin}|${parsed.service}`;
  return {
    key,
    host: parsed.host,
    port: parsed.port,
    origin: parsed.origin,
    service: parsed.service,
    path,
    method: parsed.method || null,
    source: extra?.source,
    title:
      parsed.service === "web"
        ? `${parsed.origin}${path === "/" ? "" : path}`
        : `${parsed.origin} (${parsed.service})`,
    assetKey: extra?.assetKey,
    assetLabel: extra?.assetLabel,
    hostAliases: extra?.hostAliases,
  };
}

/**
 * Prefer one root per logical asset so Surface does not splinter into
 * (target) + public IP + junk filenames for the same engagement.
 */
function canonicalizeSurfaceEntries(
  entries: SurfaceEntry[],
  assets: Array<Record<string, unknown>>,
  engagementTargets: EngagementTarget[] = [],
): SurfaceEntry[] {
  if (!entries.length) return entries;

  type AssetMeta = {
    key: string;
    label: string;
    hosts: Set<string>;
    primaryHost: string;
    primaryPort: string;
  };

  const assetMetas: AssetMeta[] = [];
  const hostToAsset = new Map<string, string>();

  const rememberHost = (host: string, assetKey: string) => {
    const h = host.toLowerCase();
    if (!h || isBogusHostLabel(h)) return;
    hostToAsset.set(h, assetKey);
  };

  for (const asset of assets) {
    const id = String(asset.id || asset.asset_id || asset.address || asset.name || "").trim();
    if (!id) continue;
    const rawAddr = String(asset.address || asset.name || "").trim();
    const host = normalizeAssetHost(rawAddr);
    if (!host) continue;
    let port = "";
    try {
      const withScheme = /^https?:\/\//i.test(rawAddr) ? rawAddr : `http://${rawAddr}`;
      const u = new URL(withScheme);
      port = u.port || "";
    } catch {
      const m = rawAddr.match(/:(\d{2,5})(?:\/|$)/);
      if (m) port = m[1];
    }
    const label = host + (port ? `:${port}` : "");
    assetMetas.push({
      key: id,
      label,
      hosts: new Set([host.toLowerCase()]),
      primaryHost: host,
      primaryPort: port,
    });
    rememberHost(host, id);
  }

  const pairMerge = maybeMergePairedHosts(entries);
  for (const [secondary, primary] of pairMerge) {
    rememberHost(secondary, hostToAsset.get(primary) || `host:${primary}`);
    if (!hostToAsset.has(primary)) rememberHost(primary, `host:${primary}`);
  }

  // Dominant host by entry count — path-only rows should fold into it.
  const hostCounts = new Map<string, number>();
  let pathOnlyCount = 0;
  for (const e of entries) {
    const h = (e.host || "").toLowerCase();
    if (!h || h === "(target)" || isBogusHostLabel(h)) {
      pathOnlyCount += 1;
      continue;
    }
    const mapped = pairMerge.get(h) || h;
    if (isLocalAliasHost(mapped)) continue;
    hostCounts.set(mapped, (hostCounts.get(mapped) || 0) + 1);
  }
  let dominantHost = "";
  let dominantCount = 0;
  for (const [h, c] of hostCounts) {
    if (c > dominantCount) {
      dominantHost = h;
      dominantCount = c;
    }
  }
  const totalHosted = [...hostCounts.values()].reduce((a, b) => a + b, 0);
  const dominantIsClear =
    Boolean(dominantHost) &&
    (hostCounts.size === 1 ||
      dominantCount >= Math.max(3, Math.ceil(totalHosted * 0.55)) ||
      (pathOnlyCount > 0 && dominantCount >= 1 && hostCounts.size <= 3));

  const localHosts = new Set(
    entries.map((e) => e.host.toLowerCase()).filter((h) => h && isLocalAliasHost(h)),
  );

  let defaultAssetKey = "";
  let defaultAssetLabel = "";
  let defaultPrimaryHost = "";
  let defaultPrimaryPort = "";

  // Engagement TARGET always wins as the default root when present.
  if (engagementTargets.length > 0) {
    const t = engagementTargets[0]!;
    const ak = hostToAsset.get(t.host.toLowerCase());
    const meta = ak ? assetMetas.find((m) => m.key === ak) : undefined;
    if (meta) {
      defaultAssetKey = meta.key;
      defaultAssetLabel = meta.label;
      defaultPrimaryHost = meta.primaryHost;
      defaultPrimaryPort = meta.primaryPort || t.port;
    } else {
      defaultAssetKey = `target:${t.origin}`;
      defaultPrimaryHost = t.host;
      defaultPrimaryPort = t.port;
      defaultAssetLabel = t.origin;
    }
    for (const et of engagementTargets) {
      rememberHost(et.host, defaultAssetKey);
    }
    for (const h of localHosts) rememberHost(h, defaultAssetKey);
    // Dominant host that matches target host also maps here.
    if (dominantHost && dominantHost === t.host.toLowerCase()) {
      rememberHost(dominantHost, defaultAssetKey);
    }
  } else if (dominantIsClear) {
    const ak = hostToAsset.get(dominantHost);
    const meta = ak ? assetMetas.find((m) => m.key === ak) : undefined;
    if (meta) {
      defaultAssetKey = meta.key;
      defaultAssetLabel = meta.label;
      defaultPrimaryHost = meta.primaryHost;
      defaultPrimaryPort = meta.primaryPort;
    } else {
      defaultAssetKey = `host:${dominantHost}`;
      defaultPrimaryHost = dominantHost;
      const ports = entries
        .filter((e) => (pairMerge.get(e.host.toLowerCase()) || e.host.toLowerCase()) === dominantHost && e.port)
        .map((e) => e.port);
      defaultPrimaryPort = mostCommon(ports) || "";
      defaultAssetLabel = defaultPrimaryPort ? `${dominantHost}:${defaultPrimaryPort}` : dominantHost;
    }
    for (const h of localHosts) rememberHost(h, defaultAssetKey);
    rememberHost(dominantHost, defaultAssetKey);
  } else if (assetMetas.length === 1) {
    defaultAssetKey = assetMetas[0]!.key;
    defaultAssetLabel = assetMetas[0]!.label;
    defaultPrimaryHost = assetMetas[0]!.primaryHost;
    defaultPrimaryPort = assetMetas[0]!.primaryPort;
    for (const h of localHosts) rememberHost(h, defaultAssetKey);
  } else if (hostCounts.size === 0 && localHosts.size > 0) {
    const only = [...localHosts][0]!;
    defaultAssetKey = `host:${only}`;
    defaultAssetLabel = only;
    defaultPrimaryHost = only;
    for (const h of localHosts) rememberHost(h, defaultAssetKey);
  }

  const resolveAsset = (
    host: string,
    entryPort?: string,
  ): { key: string; label: string; primaryHost: string; primaryPort: string } => {
    let h = (host || "").toLowerCase();
    if (isBogusHostLabel(h)) h = "";
    if (pairMerge.has(h)) h = pairMerge.get(h)!;

    if (h && hostToAsset.has(h)) {
      const ak = hostToAsset.get(h)!;
      const meta = assetMetas.find((m) => m.key === ak);
      if (meta) {
        return {
          key: meta.key,
          label: meta.label,
          primaryHost: meta.primaryHost,
          primaryPort: meta.primaryPort || entryPort || defaultPrimaryPort || "",
        };
      }
      if (ak.startsWith("host:")) {
        const ph = ak.slice(5);
        return {
          key: ak,
          label: defaultAssetLabel || ph,
          primaryHost: ph,
          primaryPort: defaultPrimaryPort || entryPort || "",
        };
      }
      return { key: ak, label: h, primaryHost: h, primaryPort: entryPort || "" };
    }

    if ((!h || h === "(target)" || isLocalAliasHost(h)) && defaultAssetKey) {
      return {
        key: defaultAssetKey,
        label: defaultAssetLabel,
        primaryHost: defaultPrimaryHost,
        primaryPort: defaultPrimaryPort || entryPort || "",
      };
    }

    if (h) {
      if (defaultAssetKey && (isLocalAliasHost(h) || isBogusHostLabel(h))) {
        return {
          key: defaultAssetKey,
          label: defaultAssetLabel,
          primaryHost: defaultPrimaryHost,
          primaryPort: defaultPrimaryPort || entryPort || "",
        };
      }
      // Authorized target host always maps to TARGET asset.
      if (defaultAssetKey && isEngagementTargetHost(h, entryPort || "", engagementTargets)) {
        return {
          key: defaultAssetKey,
          label: defaultAssetLabel,
          primaryHost: defaultPrimaryHost || h,
          primaryPort: defaultPrimaryPort || entryPort || "",
        };
      }
      // With an explicit engagement target, keep other real hosts as discovered (SSRF/out-of-scope).
      // Do not fold 192.x / 172.x into TARGET just because they are sparse.
      if (engagementTargets.length > 0) {
        return {
          key: `discovered:${h}`,
          label: host || h,
          primaryHost: host || h,
          primaryPort: entryPort || "",
        };
      }
      // No engagement target: sparse secondaries may fold into dominant host.
      if (defaultAssetKey && dominantIsClear && (hostCounts.get(h) || 0) <= 2 && dominantCount >= 5) {
        return {
          key: defaultAssetKey,
          label: defaultAssetLabel,
          primaryHost: defaultPrimaryHost,
          primaryPort: defaultPrimaryPort || entryPort || "",
        };
      }
      return { key: `host:${h}`, label: host || h, primaryHost: host || h, primaryPort: entryPort || "" };
    }

    if (defaultAssetKey) {
      return {
        key: defaultAssetKey,
        label: defaultAssetLabel,
        primaryHost: defaultPrimaryHost,
        primaryPort: defaultPrimaryPort || entryPort || "",
      };
    }
    return { key: "host:(target)", label: "(target)", primaryHost: "", primaryPort: "" };
  };

  const aliasesByAsset = new Map<string, Set<string>>();
  const rewritten: SurfaceEntry[] = [];

  for (const e of entries) {
    if (e.host && isBogusHostLabel(e.host)) {
      // Treat filename-like hosts as path-only under default asset.
      const asset = resolveAsset("", e.port);
      const primaryHost = asset.primaryHost;
      const port = e.port || asset.primaryPort;
      const origin = port ? `${primaryHost}:${port}` : primaryHost;
      const path = e.service === "web" ? (e.path && e.path !== "/" ? e.path : `/${e.host}`) : e.path || "";
      const key = e.service === "web" ? `${origin}|web|${path || "/"}` : `${origin}|${e.service}`;
      rewritten.push({
        ...e,
        host: primaryHost,
        port,
        origin,
        path: path || (e.service === "web" ? "/" : ""),
        key,
        assetKey: asset.key,
        assetLabel: asset.label,
      });
      continue;
    }

    const asset = resolveAsset(e.host, e.port);
    if (e.host) {
      const set = aliasesByAsset.get(asset.key) || new Set<string>();
      set.add(e.host);
      aliasesByAsset.set(asset.key, set);
    }
    const primaryHost = asset.primaryHost || e.host || "";
    // Path-only web rows inherit the engagement's primary port when known (e.g. :52799).
    const port =
      e.port ||
      (e.service === "web" && !e.host ? asset.primaryPort : "") ||
      (e.service === "web" && primaryHost === asset.primaryHost ? asset.primaryPort : "") ||
      "";
    const origin = port ? `${primaryHost}:${port}` : primaryHost || e.origin;
    const path = e.service === "web" ? e.path || "/" : e.path || "";
    const key = e.service === "web" ? `${origin}|web|${path}` : `${origin}|${e.service}`;
    const isTarget =
      Boolean(engagementTargets.length) &&
      (isEngagementTargetHost(primaryHost, port, engagementTargets) ||
        isEngagementTargetOrigin(origin, engagementTargets) ||
        asset.key === defaultAssetKey ||
        asset.key.startsWith("target:"));
    const isDiscovered = Boolean(engagementTargets.length) && !isTarget && Boolean(primaryHost);

    rewritten.push({
      ...e,
      host: primaryHost,
      port,
      origin,
      path,
      key,
      assetKey: asset.key,
      assetLabel: asset.label,
      isTarget,
      isDiscovered,
      title:
        e.service === "web"
          ? `${origin}${path === "/" ? "" : path}`
          : `${origin} (${e.service})`,
    });
  }

  const merged = new Map<string, SurfaceEntry>();
  for (const e of rewritten) {
    const k = e.key.toLowerCase();
    const prev = merged.get(k);
    const aliases = [...(aliasesByAsset.get(e.assetKey || "") || new Set())].filter(
      (h) => h && h.toLowerCase() !== (e.host || "").toLowerCase() && !isBogusHostLabel(h),
    );
    if (!prev) {
      merged.set(k, { ...e, hostAliases: aliases });
      continue;
    }
    const methods = mergeMethodList(prev.method, e.method);
    const aliasSet = new Set([...(prev.hostAliases || []), ...aliases]);
    merged.set(k, {
      ...prev,
      method: methods.length ? methods.join(",") : prev.method,
      source: prev.source || e.source,
      hostAliases: [...aliasSet],
      isTarget: prev.isTarget || e.isTarget,
      isDiscovered: (prev.isDiscovered || e.isDiscovered) && !(prev.isTarget || e.isTarget),
    });
  }

  return Array.from(merged.values());
}

function normalizeAssetHost(raw: string): string {
  let s = String(raw || "").trim();
  if (!s) return "";
  try {
    if (/^https?:\/\//i.test(s) || s.includes("/")) {
      const withScheme = /^https?:\/\//i.test(s) ? s : `http://${s}`;
      const u = new URL(withScheme);
      s = u.hostname || "";
    }
  } catch {
    s = s.replace(/^https?:\/\//i, "").split("/")[0].split(":")[0];
  }
  s = s.split(":")[0].trim();
  if (!s || isBogusHostLabel(s)) return "";
  if (!/^[\w.-]+$/.test(s)) return "";
  return s;
}

function isBogusHostLabel(host: string): boolean {
  const h = host.toLowerCase();
  if (!h || h === "(target)") return true;
  // Filenames mistaken as hosts (e.g. reflected.php from bad asset records).
  if (/\.(php|phtml|asp|aspx|jsp|html?|js|css|map|json|txt|bak|swp|git|env|xml|svg|png|jpe?g|gif|ico|woff2?|ttf|eot)$/i.test(h)) {
    return true;
  }
  if (h.includes("/") || h.includes("\\") || h.includes("?")) return true;
  return false;
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  let best = "";
  let n = 0;
  for (const [v, c] of counts) {
    if (c > n) {
      best = v;
      n = c;
    }
  }
  return best;
}

/** Loopback / docker DNS only — not LAN privates (those may be distinct targets). */
function isLocalAliasHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "localhost"
    || h === "127.0.0.1"
    || h === "0.0.0.0"
    || h === "::1"
    || h === "host.docker.internal"
    || h === "gateway.docker.internal"
    || h.endsWith(".localhost")
  );
}

/**
 * When exactly one "primary" host exists alongside another host that only
 * differs as a known alias pair (e.g. public + docker name already handled),
 * or path-only rows — folding is done in canonicalize. Additionally, if two
 * hosts share the exact same open port set and one is private while the other
 * is public, prefer merging under the public address for display.
 */
function maybeMergePairedHosts(entries: SurfaceEntry[]): Map<string, string> {
  const map = new Map<string, string>(); // host -> primaryHost
  const byHost = new Map<string, Set<string>>(); // host -> ports
  for (const e of entries) {
    if (!e.host || !e.port) continue;
    const h = e.host.toLowerCase();
    const set = byHost.get(h) || new Set<string>();
    set.add(e.port);
    byHost.set(h, set);
  }
  const hosts = [...byHost.keys()];
  if (hosts.length !== 2) return map;
  const [a, b] = hosts as [string, string];
  const portsA = byHost.get(a)!;
  const portsB = byHost.get(b)!;
  const samePorts =
    portsA.size === portsB.size && [...portsA].every((p) => portsB.has(p));
  if (!samePorts || portsA.size === 0) return map;
  const aPriv = isPrivateIp(a);
  const bPriv = isPrivateIp(b);
  // public + private with identical port inventory → one asset (common dual-address host)
  if (aPriv !== bPriv) {
    const primary = aPriv ? b : a;
    const secondary = aPriv ? a : b;
    map.set(secondary, primary);
  }
  return map;
}

function isPrivateIp(host: string): boolean {
  const h = host.toLowerCase();
  return (
    /^10\.\d+\.\d+\.\d+$/.test(h)
    || /^192\.168\.\d+\.\d+$/.test(h)
    || /^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(h)
  );
}

function serviceFromPort(port: string): string {
  const p = Number(port);
  if ([80, 443, 8080, 8000, 8008, 8081, 8443, 8888, 3000, 5000, 9000, 9443].includes(p)) return "web";
  if (p === 6379) return "redis";
  if (p === 22) return "ssh";
  if (p === 21) return "ftp";
  if (p === 25 || p === 587 || p === 465) return "smtp";
  if (p === 3306) return "mysql";
  if (p === 5432) return "postgres";
  if (p === 27017) return "mongodb";
  if (p === 11211) return "memcached";
  if (p === 9200 || p === 9300) return "elasticsearch";
  if (p === 5672 || p === 15672) return "rabbitmq";
  if (p === 3389) return "rdp";
  if (p === 445 || p === 139) return "smb";
  return "unknown";
}

function normalizeServiceName(name: string): string {
  const n = name.toLowerCase();
  if (/http|https|www|nginx|apache|iis|tomcat|web/.test(n)) return "web";
  if (/redis/.test(n)) return "redis";
  if (/ssh|openssh/.test(n)) return "ssh";
  if (/mysql|mariadb/.test(n)) return "mysql";
  if (/postgres|pgsql/.test(n)) return "postgres";
  if (/mongo/.test(n)) return "mongodb";
  if (/elastic/.test(n)) return "elasticsearch";
  if (/memcache/.test(n)) return "memcached";
  if (/ftp/.test(n)) return "ftp";
  if (/smtp|mail/.test(n)) return "smtp";
  if (/rdp|ms-wbt/.test(n)) return "rdp";
  if (/smb|microsoft-ds/.test(n)) return "smb";
  return n.slice(0, 24) || "unknown";
}

function inferServiceFromText(text: string): string {
  return normalizeServiceName(text);
}

/**
 * Parse host:port, URL, path-only, or "METHOD url" into a structured surface ref.
 */
function parseSurfaceRef(raw: string, methodHint?: string | null, serviceHint?: string): ParsedSurfaceRef | null {
  let text = String(raw || "").trim();
  if (!text || text === "-") return null;
  if (/^\s*[{[]/.test(text) || /"traffic_id"|"evidence_id"/.test(text)) return null;
  if (text.length > 300) return null;

  let method = normalizeHttpMethod(methodHint, text);
  const methodMatch = text.match(/^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/i);
  if (methodMatch) {
    method = methodMatch[1].toUpperCase();
    text = methodMatch[2];
  }

  // Full URL (trim at first whitespace so "http://h/p?id=1 UNION…" still parses)
  try {
    if (/^https?:\/\//i.test(text)) {
      const urlToken = text.match(/^https?:\/\/\S+/i)?.[0] || text;
      const cleaned = urlToken.replace(/[.,;:]+$/, "");
      const u = new URL(cleaned);
      const host = u.hostname;
      const port = u.port || (u.protocol === "https:" ? "443" : "80");
      let path = u.pathname || "/";
      path = path.split(/[?#]/)[0] || "/";
      if (path.length > 1) path = path.replace(/\/+$/, "");
      if (isNoiseSurfacePath(path) && path !== "/") return null;
      return {
        host,
        port,
        origin: `${host}:${port}`,
        path: path || "/",
        service: "web",
        method,
      };
    }
  } catch {
    // Fall through — may still extract path via regex below.
  }

  // host:port/path or host:port
  const hostPort = text.match(
    /^(?:\/\/)?([\w.-]+|\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?(\/[^?#\s]*)?$/i,
  );
  if (hostPort && !text.startsWith("/")) {
    const host = hostPort[1];
    const port = hostPort[2] || "";
    let path = hostPort[3] || "";
    if (path) {
      path = path.split(/[?#]/)[0] || path;
      if (path.length > 1) path = path.replace(/\/+$/, "");
      if (isNoiseSurfacePath(path) && path !== "/") return null;
    }
    const svc = serviceHint || (port ? serviceFromPort(port) : "web");
    const origin = port ? `${host}:${port}` : host;
    if (svc !== "web" && !path) {
      return { host, port: port || "", origin, path: "", service: svc, method };
    }
    return {
      host,
      port: port || (svc === "web" ? "" : ""),
      origin: port ? `${host}:${port}` : host,
      path: path || "/",
      service: path || !port || serviceFromPort(port) === "web" ? "web" : svc,
      method,
    };
  }

  // Path-only (legacy single-target web) — keep under implicit origin ""
  if (text.startsWith("/") || looksLikeUrlPath(text)) {
    const path = normalizeSurfacePath(text);
    if (!path) return null;
    return {
      host: "",
      port: "",
      origin: "",
      path,
      service: "web",
      method,
    };
  }

  return null;
}

type SurfaceFindingTag = {
  id: string;
  kind: "vuln" | "flag" | "key";
  /** Short chip text shown on the tree row. */
  label: string;
  title: string;
  severity?: string;
  finding: Record<string, unknown>;
};

function extractSurfaceRefsFromFinding(finding: Record<string, unknown>): ParsedSurfaceRef[] {
  const fields = [
    finding.location,
    finding.url,
    finding.endpoint,
    finding.poc,
    finding.reproduction,
    finding.title,
    finding.description,
    finding.impact,
    finding.affected_asset,
  ];
  const found: ParsedSurfaceRef[] = [];
  const seen = new Set<string>();

  const consider = (raw: string) => {
    const parsed = parseSurfaceRef(raw);
    if (!parsed) return;
    // Host-only / site root is a weak candidate — keep but rank lower.
    const entry = toSurfaceEntry(parsed);
    if (seen.has(entry.key.toLowerCase())) return;
    seen.add(entry.key.toLowerCase());
    found.push(parsed);
  };

  for (const field of fields) {
    const text = String(field || "").trim();
    if (!text) continue;
    consider(text);
    // Absolute URLs (stop at whitespace so SQL payloads in query don't break parsing)
    for (const m of text.matchAll(/https?:\/\/[^\s"'<>)}\]]+/gi)) {
      consider(m[0].replace(/[.,;:]+$/, ""));
    }
    // "at /level1/index.php", "via /login", plain paths
    for (const m of text.matchAll(
      /(?:^|[\s"'=(]|(?:at|via|on|to|from)\s+)(\/(?:[A-Za-z0-9._~%+\-{}[\]]+\/?)+)/gi,
    )) {
      consider(m[1]);
    }
    // METHOD /path or METHOD http://...
    for (const m of text.matchAll(/\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/gi)) {
      consider(m[1]);
    }
    // filename.php mentioned in title when no leading slash
    for (const m of text.matchAll(
      /(?:^|[\s/])((?:level\d+\/)?[A-Za-z0-9_.-]+\.(?:php|phtml|asp|aspx|jsp|html?))(?:\b|$|\?)/gi,
    )) {
      consider(`/${m[1].replace(/^\//, "")}`);
    }
  }

  // Prefer specific paths over bare site roots.
  return found.sort((a, b) => {
    const ap = a.path === "/" ? 0 : a.path.length;
    const bp = b.path === "/" ? 0 : b.path.length;
    if (bp !== ap) return bp - ap;
    return (b.origin?.length || 0) - (a.origin?.length || 0);
  });
}

/** @deprecated path-only helper kept for soft matching segments */
function extractPathsFromFinding(finding: Record<string, unknown>): string[] {
  return extractSurfaceRefsFromFinding(finding).map((r) => {
    const e = toSurfaceEntry(r);
    return e.key;
  });
}

function attachFindingsToSurface(
  findings: Array<Record<string, unknown>>,
  surfaceKeys: string[],
  surfaceEntries: SurfaceEntry[] = [],
): {
  byPath: Map<string, SurfaceFindingTag[]>;
  unlinked: SurfaceFindingTag[];
  total: number;
  linkedUnique: number;
  kindCounts: { vuln: number; flag: number; key: number };
} {
  const surfaceSet = new Set(surfaceKeys.map((p) => p.toLowerCase()));
  const byPath = new Map<string, SurfaceFindingTag[]>();
  const unlinked: SurfaceFindingTag[] = [];
  const kindCounts = { vuln: 0, flag: 0, key: 0 };
  let linkedUnique = 0;

  findings.forEach((finding, index) => {
    const resolved = resolveFindingSurfaceKey(finding, surfaceKeys, surfaceSet, surfaceEntries);
    const kindId = classifyFindingKind(finding);
    const tag = toSurfaceFindingTagForKind(finding, resolved || "", index, kindId, 0);
    if (tag.kind === "flag") kindCounts.flag += 1;
    else if (tag.kind === "key") kindCounts.key += 1;
    else kindCounts.vuln += 1;

    if (!resolved) {
      unlinked.push(tag);
      return;
    }
    linkedUnique += 1;
    const key = resolved.toLowerCase();
    tag.finding = {
      ...tag.finding,
      __surface_path: resolved,
      // Human path aligned with Surface tree (host:port/path)
      __surface_display: surfaceKeyToDisplay(resolved),
    };
    const list = byPath.get(key) || [];
    list.push(tag);
    byPath.set(key, list);
  });

  return {
    byPath,
    unlinked,
    total: findings.length,
    linkedUnique,
    kindCounts,
  };
}

/**
 * Hang a finding on the most specific web path that exists in the surface inventory.
 * Never prefer bare origin root ("/") when a deeper path is available.
 */
function resolveFindingSurfaceKey(
  finding: Record<string, unknown>,
  _surfaceKeys: string[],
  surfaceSet: Set<string>,
  surfaceEntries: SurfaceEntry[],
): string {
  const webEntries = surfaceEntries.filter((e) => e.service === "web");
  const refs = extractSurfaceRefsFromFinding(finding);

  // 1) Exact key match (path-only keys rewritten against known origins)
  for (const r of refs) {
    const direct = toSurfaceEntry(r).key;
    if (surfaceSet.has(direct.toLowerCase())) return direct;
    if (!r.origin) {
      for (const e of webEntries) {
        if (normalizeWebPath(e.path) === normalizeWebPath(r.path)) return e.key;
      }
    }
  }

  // 2) Exact path match (ignore origin), longest path wins — skip bare "/"
  let bestExact = "";
  let bestExactLen = -1;
  for (const r of refs) {
    const pl = normalizeWebPath(r.path);
    if (!pl || pl === "/") continue;
    for (const e of webEntries) {
      if (normalizeWebPath(e.path) !== pl) continue;
      if (pl.length > bestExactLen) {
        bestExact = e.key;
        bestExactLen = pl.length;
      }
    }
  }
  if (bestExact) return bestExact;

  // 3) Longest surface path that is a prefix of a finding path (finding deeper than inventory leaf)
  let bestPrefix = "";
  let bestPrefixLen = -1;
  for (const r of refs) {
    const pl = normalizeWebPath(r.path);
    if (!pl || pl === "/") continue;
    for (const e of webEntries) {
      const el = normalizeWebPath(e.path);
      if (!el || el === "/") continue;
      if (pl === el || pl.startsWith(`${el}/`)) {
        if (el.length > bestPrefixLen) {
          bestPrefix = e.key;
          bestPrefixLen = el.length;
        }
      }
    }
  }
  if (bestPrefix) return bestPrefix;

  // 4) Soft segment match — never return bare "/"
  const soft = softMatchSurfacePath(
    finding,
    webEntries.map((e) => e.path).filter((p) => p && p !== "/"),
  );
  if (soft) {
    const hit = webEntries.find((e) => normalizeWebPath(e.path) === normalizeWebPath(soft));
    if (hit) return hit.key;
  }

  // 5) Specific path candidate not yet in inventory → create leaf under target origin if possible
  for (const r of refs) {
    const pl = normalizeWebPath(r.path);
    if (!pl || pl === "/") continue;
    // Directory-only hints like /level3 are handled in step 5b (do not pick a sibling leaf).
    if (/^\/level\d+$/i.test(pl)) continue;
    if (r.origin) return toSurfaceEntry(r).key;
    const bound = bindPathToDominantOrigin(pl, r.method || "", webEntries);
    if (bound) return bound;
    return toSurfaceEntry(r).key;
  }

  // 5b) Level-only signal (title "L3 …", "Level 3", blob "level3") with no file path.
  // Hang on /levelN under the dominant web origin — never invent a sibling leaf file.
  const levelDirs = extractLevelDirectoryPaths(finding);
  for (const levelPath of levelDirs) {
    const bound = bindPathToDominantOrigin(levelPath, "", webEntries);
    if (bound) return bound;
  }

  // 6) Only site-root candidates left — attach to origin root ONLY if we truly have no path signal.
  // (Flags/vulns with a path in title/poc should have been caught above.)
  const hasSpecificPath =
    refs.some((r) => {
      const pl = normalizeWebPath(r.path);
      return Boolean(pl && pl !== "/");
    }) || levelDirs.length > 0;
  if (!hasSpecificPath) {
    for (const r of refs) {
      if (normalizeWebPath(r.path) !== "/") continue;
      if (r.origin) {
        const k = toSurfaceEntry({ ...r, path: "/" }).key;
        if (surfaceSet.has(k.toLowerCase())) return k;
        const hit = webEntries.find(
          (e) => e.origin.toLowerCase() === r.origin.toLowerCase() && normalizeWebPath(e.path) === "/",
        );
        if (hit) return hit.key;
      }
    }
    // Prefer any web root under the dominant origin rather than inventing keys.
    const root = webEntries.find((e) => normalizeWebPath(e.path) === "/");
    if (root) return root.key;
  }

  return "";
}

/** Bind a path-only web route onto the most common origin in the inventory. */
function bindPathToDominantOrigin(
  path: string,
  method: string,
  webEntries: SurfaceEntry[],
): string {
  const pl = normalizeWebPath(path);
  if (!pl || pl === "/") return "";
  const originCounts = new Map<string, number>();
  for (const e of webEntries) {
    if (!e.origin) continue;
    originCounts.set(e.origin, (originCounts.get(e.origin) || 0) + 1);
  }
  let topOrigin = "";
  let topN = 0;
  for (const [o, n] of originCounts) {
    if (n > topN) {
      topOrigin = o;
      topN = n;
    }
  }
  if (!topOrigin) return "";
  const host = topOrigin.split(":")[0] || "";
  const port = topOrigin.includes(":") ? topOrigin.split(":").slice(1).join(":") : "";
  return toSurfaceEntry({
    host,
    port,
    origin: topOrigin,
    path: pl,
    service: "web",
    method,
  }).key;
}

/**
 * Infer CTF-style level directories from free text when no concrete file path is known.
 * "L3 Challenge", "Level 3", "level3" → ["/level3"]
 */
function extractLevelDirectoryPaths(finding: Record<string, unknown>): string[] {
  const blob = [
    finding.title,
    finding.location,
    finding.url,
    finding.endpoint,
    finding.description,
    finding.poc,
    finding.reproduction,
    finding.impact,
  ]
    .map((v) => String(v || ""))
    .join("\n");
  const levels = new Set<number>();
  for (const m of blob.matchAll(/\bL(\d{1,2})\b/gi)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 30) levels.add(n);
  }
  for (const m of blob.matchAll(/\bLevel\s*(\d{1,2})\b/gi)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 30) levels.add(n);
  }
  for (const m of blob.matchAll(/\blevel(\d{1,2})\b/gi)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 30) levels.add(n);
  }
  return [...levels].sort((a, b) => a - b).map((n) => `/level${n}`);
}

function normalizeWebPath(path: string): string {
  let p = String(path || "").trim() || "/";
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p.toLowerCase();
}

/** Convert inventory key `host:port|web|/path` → `host:port/path` for detail UI. */
function surfaceKeyToDisplay(key: string): string {
  const parts = String(key || "").split("|");
  if (parts.length >= 3 && parts[1] === "web") {
    const origin = parts[0] || "";
    const path = parts.slice(2).join("|") || "/";
    if (!origin) return path;
    return path === "/" ? origin : `${origin}${path.startsWith("/") ? path : `/${path}`}`;
  }
  if (parts.length >= 2) {
    // host:port|redis
    return parts[0] ? `${parts[0]} (${parts[1]})` : key;
  }
  return key;
}

/** Parse inventory key produced by toSurfaceEntry back into a surface ref. */
function parseSurfaceInventoryKey(key: string): ParsedSurfaceRef | null {
  const parts = String(key || "").split("|");
  if (parts.length >= 3 && parts[1] === "web") {
    const origin = parts[0] || "";
    const path = parts.slice(2).join("|") || "/";
    if (!origin && !path) return null;
    const host = origin.includes(":") ? origin.split(":")[0] || "" : origin;
    const port = origin.includes(":") ? origin.split(":").slice(1).join(":") : "";
    return {
      host,
      port,
      origin: origin || "",
      path: path || "/",
      service: "web",
      method: "",
    };
  }
  if (parts.length === 2 && parts[0] && parts[1] && parts[1] !== "web") {
    const origin = parts[0];
    const host = origin.includes(":") ? origin.split(":")[0] || "" : origin;
    const port = origin.includes(":") ? origin.split(":").slice(1).join(":") : "";
    return {
      host,
      port,
      origin,
      path: "",
      service: parts[1],
      method: "",
    };
  }
  return null;
}

const SURFACE_SOFT_STOPWORDS = new Set([
  "api", "rest", "v1", "v2", "v3", "http", "https", "www", "com", "org", "net",
  "user", "users", "admin", "login", "index", "home", "page", "test", "data",
  "null", "true", "false", "json", "html", "php", "asp", "jsp", "static",
  "assets", "public", "file", "files", "img", "images", "css", "js",
]);

function softMatchSurfacePath(finding: Record<string, unknown>, surfaceKeys: string[]): string {
  const blob = [
    finding.title,
    finding.location,
    finding.url,
    finding.endpoint,
    finding.description,
    finding.poc,
    finding.reproduction,
    finding.impact,
  ]
    .map((v) => String(v || "").toLowerCase())
    .join("\n");
  if (!blob.trim()) return "";

  // Expand "L3" / "Level 3" so they can match inventory segment "level3".
  const levelAliases = new Set<string>();
  for (const m of blob.matchAll(/\bl(\d{1,2})\b/gi)) levelAliases.add(`level${m[1]}`);
  for (const m of blob.matchAll(/\blevel\s*(\d{1,2})\b/gi)) levelAliases.add(`level${m[1]}`);
  for (const m of blob.matchAll(/\blevel(\d{1,2})\b/gi)) levelAliases.add(`level${m[1]}`);

  let best = "";
  let bestScore = 0;
  let bestFileScore = 0;
  let secondScore = 0;
  for (const surface of surfaceKeys) {
    const sl = surface.toLowerCase();
    const segments = sl.split("/").filter(Boolean);
    if (segments.length === 0) continue;
    let score = 0;
    let fileScore = 0;
    // Full path mention
    if (blob.includes(sl)) score += 100 + sl.length;
    // Distinctive segments (skip stopwords / short tokens)
    for (const seg of segments) {
      if (seg.length < 4 || SURFACE_SOFT_STOPWORDS.has(seg)) continue;
      if (/^level\d+$/i.test(seg)) continue;
      if (blob.includes(seg)) {
        const add = 10 + seg.length;
        score += add;
        fileScore += add;
      }
    }
    // levelN style CTF paths are supportive, not alone sufficient to pick a sibling file
    for (const seg of segments) {
      if (!/^level\d+$/i.test(seg)) continue;
      if (blob.includes(seg) || levelAliases.has(seg)) score += 30;
    }
    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      bestFileScore = fileScore;
      best = surface;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }
  // Require a file/path signal (not level-only). Level-only hang uses /levelN directories.
  if (bestFileScore < 14 && bestScore < 100) return "";
  // Ambiguous: two surfaces scored the same → do not soft-pick.
  if (bestScore > 0 && bestScore === secondScore) return "";
  return bestScore >= 14 ? best : "";
}

function normalizeFindingSeverity(value: unknown): "critical" | "high" | "medium" | "low" | "info" {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "critical" || raw === "high" || raw === "medium" || raw === "low" || raw === "info") return raw;
  return "medium";
}

function toSurfaceFindingTagForKind(
  finding: Record<string, unknown>,
  path: string,
  index: number,
  kindId: FindingKindId,
  kindIndex = 0,
): SurfaceFindingTag {
  const kind: SurfaceFindingTag["kind"] = kindId === "flag" ? "flag" : kindId === "auth" ? "key" : "vuln";
  const severity = normalizeFindingSeverity(finding.severity);
  // Vuln: severity only. Flag: Flag. Key: PASSWORD/JWT/APIKEY/…
  const label =
    kind === "flag" ? "Flag" : kind === "key" ? classifyAuthSubtype(finding).label : severity;
  const flagToken = kind === "flag" ? extractFlagFromFinding(finding) : undefined;
  const title = String(flagToken || finding.title || "Finding").trim();
  const baseId = String(finding.id || finding.vulnerability_id || finding.finding_id || `finding-${index}`);
  const id = `${baseId}:${kind}:${kindIndex}`.slice(0, 160);
  return {
    id,
    kind,
    label,
    title,
    severity,
    finding,
  };
}

function findingTagClass(tag: SurfaceFindingTag): string {
  if (tag.kind === "flag") return "bg-status-success/15 text-status-success";
  if (tag.kind === "key") return classifyAuthSubtype(tag.finding).badgeClass;
  return severityBadgeClass(tag.severity);
}

/** Open detail with the chip's category so FLAG does not open as Vulnerability detail. */
function openFindingFromTag(tag: SurfaceFindingTag): Partial<SecurityVulnerability> {
  const kind = tag.kind === "key" ? "auth" : tag.kind;
  return {
    ...(tag.finding as Partial<SecurityVulnerability>),
    finding_kind: kind,
    kind,
    category: kind,
    __surface_kind: tag.kind,
  } as Partial<SecurityVulnerability>;
}

/**
 * True only for values that look like real URL paths / endpoints.
 * Rejects free-text finding titles, probe notes, and English sentences.
 */
function looksLikeUrlPath(value: string): boolean {
  const raw = String(value || "").trim();
  if (!raw || raw === "-") return false;
  if (raw.length > 220) return false;
  // JSON / tool dumps
  if (/^\s*[{[]/.test(raw) || /"traffic_id"|"evidence_id"|"runner"\s*:/.test(raw)) return false;
  // host:port or host:port/path
  if (/^(?:https?:\/\/)?[\w.-]+(?::\d{1,5})?(?:\/\S*)?$/i.test(raw) && !/\s/.test(raw)) return true;
  // Multi-word English prose (the main source of dirty surface rows).
  if (/\s/.test(raw)) {
    // Allow "GET /path" or "POST http://x/y" only.
    if (!/^\s*(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+/i.test(raw)) return false;
    const rest = raw.replace(/^\s*(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i, "");
    if (/\s/.test(rest.split(/[?#]/)[0])) return false;
  }
  // Sentence-ish titles
  if (/\b(allows|with|using|file|directive|executed|vulnerability|injection|detected|found)\b/i.test(raw)
    && !/^https?:\/\//i.test(raw)
    && !/^\s*(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\//i.test(raw)
    && !raw.startsWith("/")
    && !/^[\w.-]+(?::\d{1,5})?(?:\/\S*)?$/i.test(raw)) {
    return false;
  }
  return true;
}

function normalizeSurfacePath(endpoint: string): string {
  let path = String(endpoint || "").trim();
  if (!path || path === "-" || !looksLikeUrlPath(path)) return "";
  // Titles like "GET /level9/.git/config" → path only.
  const titled = path.match(/^\s*(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S+)/i);
  if (titled) path = titled[1];
  try {
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname || path;
  } catch {
    return "";
  }
  path = (path.split(/[?#]/)[0] || path).trim();
  if (!path || path === "-") return "";
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/{2,}/g, "/");
  // Drop trailing slash except root: /upload/ → /upload
  if (path.length > 1) path = path.replace(/\/+$/, "");
  // Segment check: no spaces, no sentence punctuation runs, reasonable length.
  const segments = path.split("/").filter(Boolean);
  for (const seg of segments) {
    if (!seg || seg.length > 96) return "";
    if (/\s/.test(seg)) return "";
    // Path tokens only (supports .htaccess, file.php, {id}, %20, etc.)
    if (!/^[A-Za-z0-9._~!$&'()*+,;=:@%{}\[\]-]+$/.test(seg)) return "";
    // Reject "word.word.word ..." that is clearly prose glued (multiple spaces already rejected)
    if (seg.split(".").length > 6 && seg.length > 40) return "";
  }
  // Entire path still looks like prose somehow (e.g. "/.htaccess file..." if spaces slipped through)
  if (/\s/.test(path)) return "";
  if (isNoiseSurfacePath(path)) return "";
  return path;
}

/**
 * Scanner placeholders and non-resources that should not appear in the Surface tree.
 * Aligns with node2 isNoiseEndpoint intent (FUZZ, bare API roots, static assets).
 */
function isNoiseSurfacePath(path: string): boolean {
  const p = String(path || "").trim().toLowerCase();
  if (!p || p === "/" || p === "-" || p === "/.") return true;
  if (/\.(?:css|js|mjs|map|png|jpe?g|gif|ico|svg|woff2?|ttf|eot|mp4|webm|webp|avif)(?:$)/i.test(p)) return true;
  // FUZZ / placeholder tokens (common ffuf/dirsearch markers).
  if (/(?:^|\/)(?:fuzz|\{fuzz\}|wfuzz|placeholder|wordlist|null|undefined|\*|%2a)(?:\/|$)/i.test(p)) return true;
  // Bare API framework roots without a resource.
  if (/^\/(?:api|rest|graphql|v\d+)\/?$/i.test(p)) return true;
  const segments = p.split("/").filter(Boolean);
  if (segments.length === 0) return true;
  if (segments.some((seg) => /^(?:fuzz|\{fuzz\}|wfuzz|placeholder|wordlist|null|undefined|\*|%2a)$/i.test(seg))) {
    return true;
  }
  // Single ultra-short junk segments from truncated scanners.
  if (segments.length === 1 && segments[0]!.length <= 1) return true;
  return false;
}

/** Prefer stable lowercase path when merging case variants of the same route. */
function preferCanonicalPath(a: string, b: string): string {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al === bl) {
    // Prefer all-lowercase display form.
    if (a === al) return a;
    if (b === bl) return b;
    return a.length <= b.length ? a : b;
  }
  return a.length <= b.length ? a : b;
}

function normalizeHttpMethod(method: unknown, title?: unknown): string {
  let raw = String(method || "").trim().toUpperCase();
  if (!raw || ["SURFACE", "REQUEST", "ENDPOINT", "TEST", "HTTP", "WORKER", "SCAN", "TRAFFIC", "BROWSER"].includes(raw)) {
    const fromTitle = String(title || "").match(/^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/i);
    raw = fromTitle ? fromTitle[1].toUpperCase() : "";
  }
  if (!raw) return "";
  return raw
    .split(/[,\s|/]+/)
    .map((m) => m.trim().toUpperCase())
    .filter((m) => ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(m))
    .join(",");
}

function mergeMethodList(...parts: Array<string | null | undefined>): string[] {
  const set = new Set<string>();
  for (const part of parts) {
    for (const m of String(part || "").split(/[,\s|/]+/)) {
      const up = m.trim().toUpperCase();
      if (["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(up)) set.add(up);
    }
  }
  const order = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
  return order.filter((m) => set.has(m));
}

function mergeStringList(...lists: Array<string[] | undefined | null>): string[] {
  const set = new Set<string>();
  for (const list of lists) {
    for (const item of list || []) {
      const v = String(item || "").trim();
      if (v) set.add(v);
    }
  }
  return Array.from(set);
}

function surfaceMethodChips(method: unknown): string[] {
  return mergeMethodList(String(method || ""));
}

function dedupeFindingTags(tags: SurfaceFindingTag[]): SurfaceFindingTag[] {
  const seen = new Set<string>();
  const out: SurfaceFindingTag[] = [];
  for (const tag of tags) {
    if (seen.has(tag.id)) continue;
    seen.add(tag.id);
    out.push(tag);
  }
  return out;
}

/**
 * Surface tree: host → port/service → web path segments.
 * Multi-target webs stay under their own host:port; redis/ssh etc. are service leaves.
 */
type SurfaceTreeNode = {
  id: string;
  label: string;
  path: string;
  /** host | port | path | service */
  nodeKind?: "host" | "port" | "path" | "service";
  service?: string;
  /** Extra hostnames/IPs for the same asset (shown muted on the root). */
  aliases?: string[];
  isTarget?: boolean;
  isDiscovered?: boolean;
  children: SurfaceTreeNode[];
  /** Leaf payload (web route or non-web service). */
  entries: SurfaceEntry[];
  methods: string[];
  leafCount: number;
  findingTags: SurfaceFindingTag[];
  subtreeFindingTags: SurfaceFindingTag[];
};

function pathSegments(path: string): string[] {
  const raw = String(path || "").trim();
  if (!raw || raw === "/") return [];
  return raw.split("/").map((s) => s.trim()).filter(Boolean);
}

function buildSurfaceTree(
  items: SurfaceEntry[],
  findingsByPath: Map<string, SurfaceFindingTag[]> = new Map(),
): SurfaceTreeNode[] {
  // One root per logical asset (not per raw hostname string).
  const assets = new Map<string, SurfaceTreeNode>();

  const ensureAsset = (entry: SurfaceEntry): SurfaceTreeNode => {
    const assetKey = entry.assetKey || `host:${entry.host || "(target)"}`;
    let node = assets.get(assetKey);
    if (node) {
      if (entry.hostAliases?.length) {
        const set = new Set([...(node.aliases || []), ...entry.hostAliases]);
        node.aliases = [...set].filter((h) => h.toLowerCase() !== node!.label.toLowerCase());
      }
      if (entry.isTarget) {
        node.isTarget = true;
        node.isDiscovered = false;
      } else if (entry.isDiscovered && !node.isTarget) {
        node.isDiscovered = true;
      }
      return node;
    }
    const label = entry.assetLabel || entry.host || "(target)";
    node = {
      id: `asset:${assetKey}`,
      label,
      path: label,
      nodeKind: "host",
      aliases: (entry.hostAliases || []).filter((h) => h.toLowerCase() !== label.toLowerCase()),
      isTarget: Boolean(entry.isTarget),
      isDiscovered: Boolean(entry.isDiscovered) && !entry.isTarget,
      children: [],
      entries: [],
      methods: [],
      leafCount: 0,
      findingTags: [],
      subtreeFindingTags: [],
    };
    assets.set(assetKey, node);
    return node;
  };

  const ensurePort = (hostNode: SurfaceTreeNode, entry: SurfaceEntry): SurfaceTreeNode => {
    // Group by port+service under the asset (not by original hostname alias).
    const portLabel = entry.port ? `:${entry.port}` : entry.service !== "web" ? entry.service : "service";
    const id = `${hostNode.id}|:${entry.port || "0"}|${entry.service}`;
    let node = hostNode.children.find((c) => c.id === id);
    if (node) return node;
    node = {
      id,
      label: portLabel,
      path: entry.origin || portLabel,
      nodeKind: entry.service === "web" ? "port" : "service",
      service: entry.service,
      children: [],
      entries: [],
      methods: [],
      leafCount: 0,
      // Tags attach when the matching entry is processed (root path → port; deeper → path node).
      findingTags: [],
      subtreeFindingTags: [],
    };
    hostNode.children.push(node);
    return node;
  };

  for (const entry of items) {
    const hostNode = ensureAsset(entry);
    const portNode = ensurePort(hostNode, entry);

    if (entry.service !== "web") {
      portNode.entries.push(entry);
      const tags = findingsByPath.get(entry.key.toLowerCase()) || [];
      portNode.findingTags = dedupeFindingTags([...portNode.findingTags, ...tags]);
      continue;
    }

    const segs = pathSegments(entry.path);
    if (segs.length === 0) {
      // Web root of this origin
      portNode.entries.push(entry);
      for (const m of surfaceMethodChips(entry.method)) {
        if (!portNode.methods.includes(m)) portNode.methods.push(m);
      }
      const tags = findingsByPath.get(entry.key.toLowerCase()) || [];
      portNode.findingTags = dedupeFindingTags([...portNode.findingTags, ...tags]);
      continue;
    }

    let cursor = portNode;
    let accPath = entry.origin;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      accPath = `${accPath}/${seg}`;
      const childId = `${portNode.id}|/${segs.slice(0, i + 1).join("/")}`;
      let child = cursor.children.find((c) => c.id === childId);
      if (!child) {
        child = {
          id: childId,
          label: seg,
          path: `/${segs.slice(0, i + 1).join("/")}`,
          nodeKind: "path",
          service: "web",
          children: [],
          entries: [],
          methods: [],
          leafCount: 0,
          findingTags: [],
          subtreeFindingTags: [],
        };
        cursor.children.push(child);
      }
      cursor = child;
    }
    cursor.entries.push(entry);
    for (const m of surfaceMethodChips(entry.method)) {
      if (!cursor.methods.includes(m)) cursor.methods.push(m);
    }
    const tags = findingsByPath.get(entry.key.toLowerCase()) || [];
    cursor.findingTags = dedupeFindingTags([...cursor.findingTags, ...tags]);
  }

  const finalize = (node: SurfaceTreeNode): number => {
    let leaves = node.entries.length > 0 ? Math.max(1, node.entries.length) : 0;
    // path leaves count as 1 each even if multiple methods merged
    if (node.nodeKind === "path" && node.entries.length) leaves = 1;
    if (node.nodeKind === "service" && node.entries.length) leaves = 1;
    let subtreeTags = [...node.findingTags];
    const methods = new Set(node.methods);
    for (const child of node.children) {
      leaves += finalize(child);
      for (const m of child.methods) methods.add(m);
      subtreeTags = subtreeTags.concat(child.subtreeFindingTags);
    }
    // Port-only web root without children still counts
    if (node.nodeKind === "port" && node.entries.length && !node.children.length) leaves = Math.max(leaves, 1);
    node.leafCount = leaves;
    node.subtreeFindingTags = dedupeFindingTags(subtreeTags);
    node.methods = Array.from(methods);
    node.children.sort((a, b) => {
      // ports numeric when possible
      const ap = a.label.startsWith(":") ? Number(a.label.slice(1)) : NaN;
      const bp = b.label.startsWith(":") ? Number(b.label.slice(1)) : NaN;
      if (Number.isFinite(ap) && Number.isFinite(bp) && ap !== bp) return ap - bp;
      const af = a.subtreeFindingTags.length;
      const bf = b.subtreeFindingTags.length;
      if (bf !== af) return bf - af;
      return a.label.localeCompare(b.label);
    });
    return leaves;
  };

  const roots = Array.from(assets.values());
  for (const h of roots) finalize(h);
  // TARGET first, then discovered, then alpha.
  roots.sort((a, b) => {
    if (a.isTarget !== b.isTarget) return a.isTarget ? -1 : 1;
    if (a.isDiscovered !== b.isDiscovered) return a.isDiscovered ? 1 : -1;
    return a.label.localeCompare(b.label);
  });
  return roots;
}

type SurfaceKindFilter = "all" | "vuln" | "key" | "flag" | "findings";

function SurfaceTreeView({
  roots,
  total,
  linkedCount = 0,
  findingsTotal = 0,
  kindCounts = { vuln: 0, flag: 0, key: 0 },
  unlinked = [],
  onOpenVulnerability,
}: {
  roots: SurfaceTreeNode[];
  total: number;
  /** Unique findings successfully hung on a route. */
  linkedCount?: number;
  /** Same as Findings tab unique count (findings.length). */
  findingsTotal?: number;
  /** Chip counts by kind — exclusive, matches Findings Vuln / Key / Flags. */
  kindCounts?: { vuln: number; flag: number; key: number };
  unlinked?: SurfaceFindingTag[];
  onOpenVulnerability?: (finding: Partial<SecurityVulnerability>) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<SurfaceKindFilter>("all");

  const filterActive = Boolean(query.trim()) || kindFilter !== "all";

  const filteredRoots = useMemo(
    () => filterSurfaceTree(roots, query, kindFilter),
    [roots, query, kindFilter],
  );

  const filteredUnlinked = useMemo(() => {
    const q = query.trim().toLowerCase();
    return unlinked.filter((tag) => {
      if (kindFilter === "vuln" && tag.kind !== "vuln") return false;
      if (kindFilter === "key" && tag.kind !== "key") return false;
      if (kindFilter === "flag" && tag.kind !== "flag") return false;
      // "findings" and "all" keep unlinked (they are findings without a path)
      if (!q) return true;
      return `${tag.label} ${tag.title} ${tag.kind}`.toLowerCase().includes(q);
    });
  }, [unlinked, query, kindFilter]);

  const isOpen = (node: SurfaceTreeNode, depth: number) => {
    if (collapsed[node.id] !== undefined) return !collapsed[node.id];
    // Expand matches while searching / filtering so hits are visible.
    if (filterActive) return true;
    if (node.subtreeFindingTags.length > 0 && depth < 4) return true;
    return depth < 2;
  };

  const toggle = (id: string, depth: number, node: SurfaceTreeNode) => {
    setCollapsed((prev) => {
      const currentlyOpen = prev[id] !== undefined ? !prev[id] : isOpen(node, depth);
      return { ...prev, [id]: currentlyOpen };
    });
  };

  const unlinkedCount = filteredUnlinked.length;
  const visibleLeafHint = filterActive
    ? countSurfaceLeaves(filteredRoots)
    : total;

  const filterChips: Array<{ id: SurfaceKindFilter; label: string; count: number; title?: string }> = [
    { id: "all", label: "All", count: total, title: `${total} surfaces · ${findingsTotal} findings · ${linkedCount} linked` },
    { id: "findings", label: "Findings", count: findingsTotal, title: "Only routes with linked findings" },
    { id: "vuln", label: "Vuln", count: kindCounts.vuln },
    { id: "key", label: "Key", count: kindCounts.key },
    { id: "flag", label: "Flag", count: kindCounts.flag },
  ];

  return (
    <div className="space-y-2.5">
      <div className="space-y-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search host, path, finding…"
            className="w-full rounded-md border border-hairline-soft bg-canvas-inset py-1.5 pl-7 pr-2 text-xs text-ink placeholder:text-ink-muted focus:border-hairline focus:outline-none"
            aria-label="Search attack surface"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {filterChips.map((chip) => {
            const active = kindFilter === chip.id;
            const empty = chip.id !== "all" && chip.count === 0;
            return (
              <button
                key={chip.id}
                type="button"
                disabled={empty}
                title={chip.title}
                onClick={() => setKindFilter(chip.id)}
                className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  active
                    ? chip.id === "flag"
                      ? "bg-status-success/15 text-status-success"
                      : chip.id === "key"
                        ? "bg-status-running/12 text-status-running"
                        : chip.id === "vuln"
                          ? "bg-severity-high-subtle text-severity-high"
                          : "bg-ink text-white"
                    : "bg-canvas-inset text-ink-muted hover:bg-surface-default hover:text-ink"
                }`}
              >
                <span>{chip.label}</span>
                <span className={active && chip.id === "all" ? "opacity-80" : "opacity-70"}>{chip.count}</span>
              </button>
            );
          })}
          {filterActive && (
            <span className="ml-auto font-mono text-[10px] text-ink-muted">
              {visibleLeafHint} match{visibleLeafHint === 1 ? "" : "es"}
            </span>
          )}
        </div>
      </div>

      {filteredRoots.length === 0 && unlinkedCount === 0 ? (
        <p className="py-4 text-center text-xs text-ink-muted">No surfaces match this search / filter</p>
      ) : (
        <div className="space-y-0.5">
          {filteredRoots.map((node) => (
            <SurfaceTreeNodeRow
              key={node.id}
              node={node}
              depth={0}
              isOpen={isOpen}
              onToggle={toggle}
              onOpenVulnerability={onOpenVulnerability}
            />
          ))}
        </div>
      )}

      {unlinkedCount > 0 && (
        <section className="space-y-1.5 border-t border-hairline-soft pt-3">
          <p className="text-xs font-medium text-ink-muted">
            Unlinked findings ({unlinkedCount})
          </p>
          <p className="text-[11px] text-ink-muted">
            Included in Findings count but no route path to attach.
          </p>
          <div className="space-y-1">
            {filteredUnlinked.map((tag) => (
              <button
                key={tag.id}
                type="button"
                title={tag.title}
                onClick={() => onOpenVulnerability?.(openFindingFromTag(tag))}
                className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-1 text-left hover:bg-surface-default"
              >
                <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase ${findingTagClass(tag)}`}>
                  {tag.label}
                </span>
                <span className="min-w-0 truncate text-[12px] text-ink">{tag.title}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function surfaceTagMatchesKind(tag: SurfaceFindingTag, kind: SurfaceKindFilter): boolean {
  if (kind === "all" || kind === "findings") return true;
  return tag.kind === kind;
}

function surfaceNodeSearchBlob(node: SurfaceTreeNode): string {
  const parts = [
    node.label,
    node.path,
    node.service || "",
    ...(node.aliases || []),
    ...node.methods,
    ...node.findingTags.flatMap((t) => [t.label, t.title, t.kind]),
    ...(node.entries || []).flatMap((e) => [e.key, e.title || "", e.path, e.origin, e.host]),
  ];
  return parts.join(" ").toLowerCase();
}

function filterSurfaceTree(
  roots: SurfaceTreeNode[],
  query: string,
  kind: SurfaceKindFilter,
): SurfaceTreeNode[] {
  const q = query.trim().toLowerCase();
  if (!q && kind === "all") return roots;

  const filterNode = (node: SurfaceTreeNode): SurfaceTreeNode | null => {
    const children = node.children
      .map((child) => filterNode(child))
      .filter((child): child is SurfaceTreeNode => child != null);

    const ownTags = node.findingTags.filter((t) => surfaceTagMatchesKind(t, kind));
    const searchSelf = !q || surfaceNodeSearchBlob(node).includes(q);

    // Keep ancestors of matching descendants.
    if (children.length > 0) {
      const subtreeTags = dedupeFindingTags([
        ...ownTags,
        ...children.flatMap((c) => c.subtreeFindingTags),
      ]);
      return {
        ...node,
        children,
        findingTags: kind === "all" ? node.findingTags : ownTags,
        subtreeFindingTags: kind === "all"
          ? dedupeFindingTags([...node.findingTags, ...children.flatMap((c) => c.subtreeFindingTags)])
          : subtreeTags,
        leafCount: children.reduce((n, c) => n + (c.leafCount || 0), 0) || node.leafCount,
      };
    }

    // Leaf (no surviving children)
    if (q && !searchSelf) return null;
    if (kind === "findings" && ownTags.length === 0) return null;
    if (kind !== "all" && kind !== "findings" && ownTags.length === 0) return null;

    return {
      ...node,
      children: [],
      findingTags: kind === "all" ? node.findingTags : ownTags,
      subtreeFindingTags: kind === "all" ? node.subtreeFindingTags : ownTags,
    };
  };

  return roots.map(filterNode).filter((n): n is SurfaceTreeNode => n != null);
}

function countSurfaceLeaves(roots: SurfaceTreeNode[]): number {
  let n = 0;
  const walk = (node: SurfaceTreeNode) => {
    if (!node.children.length) {
      n += 1;
      return;
    }
    for (const c of node.children) walk(c);
  };
  for (const r of roots) walk(r);
  return n;
}

function SurfaceTreeNodeRow({
  node,
  depth,
  isOpen,
  onToggle,
  onOpenVulnerability,
}: {
  node: SurfaceTreeNode;
  depth: number;
  isOpen: (node: SurfaceTreeNode, depth: number) => boolean;
  onToggle: (id: string, depth: number, node: SurfaceTreeNode) => void;
  onOpenVulnerability?: (finding: Partial<SecurityVulnerability>) => void;
}) {
  const hasChildren = node.children.length > 0;
  const hasEntries = (node.entries?.length || 0) > 0;
  if (!hasChildren && !hasEntries && !(node.findingTags?.length || 0)) return null;

  const open = isOpen(node, depth);
  const canExpand = hasChildren;
  const paddingLeft = 8 + depth * 12;
  const showMethodsOnRow = node.methods.length > 0 && (!hasChildren || !open);
  // When expanded, only show tags that belong to THIS node (not children).
  // When collapsed, preview subtree tags so users still see vuln count under the port/host.
  const allPreview = dedupeFindingTags([...node.findingTags, ...node.subtreeFindingTags]);
  const rowTags = !hasChildren || !open ? allPreview.slice(0, 3) : node.findingTags.slice(0, 3);
  const extraTagCount = !hasChildren || !open
    ? Math.max(0, allPreview.length - rowTags.length)
    : Math.max(0, node.findingTags.length - rowTags.length);
  const visibleTags = rowTags;

  const displayLabel =
    node.nodeKind === "path" ? `/${node.label}` : node.label;
  const serviceBadge =
    node.service && node.service !== "web" && (node.nodeKind === "port" || node.nodeKind === "service")
      ? node.service.toUpperCase()
      : node.nodeKind === "port" && node.service === "web"
        ? "WEB"
        : "";

  return (
    <div>
      <div
        className="flex min-w-0 items-center gap-1 rounded-md px-1 py-1 hover:bg-surface-default"
        style={{ paddingLeft }}
      >
        {canExpand ? (
          <button
            type="button"
            aria-label={open ? "Collapse" : "Expand"}
            onClick={() => onToggle(node.id, depth, node)}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-muted hover:bg-canvas-inset hover:text-ink"
          >
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        ) : (
          <span className="inline-block h-5 w-5 shrink-0" />
        )}
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <button
            type="button"
            onClick={() => canExpand && onToggle(node.id, depth, node)}
            className="flex min-w-0 items-center gap-1.5 text-left"
          >
            <span className="truncate font-mono text-[13px] font-medium text-ink">{displayLabel}</span>
            {node.nodeKind === "host" && node.isTarget && (
              <span className="shrink-0 rounded bg-status-running/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-status-running">
                Target
              </span>
            )}
            {node.nodeKind === "host" && node.isDiscovered && !node.isTarget && (
              <span className="shrink-0 rounded bg-canvas-inset px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase text-ink-muted">
                Discovered
              </span>
            )}
            {serviceBadge && (
              <span className="shrink-0 rounded bg-status-running/10 px-1 py-0.5 font-mono text-[10px] font-medium uppercase text-status-running">
                {serviceBadge}
              </span>
            )}
            {node.nodeKind === "host" && node.aliases && node.aliases.length > 0 && (
              <span
                className="min-w-0 truncate font-mono text-[10px] text-ink-muted"
                title={node.aliases.join(", ")}
              >
                ≈ {node.aliases.slice(0, 2).join(", ")}
                {node.aliases.length > 2 ? ` +${node.aliases.length - 2}` : ""}
              </span>
            )}
            {hasChildren && node.leafCount > 0 && (
              <span className="shrink-0 font-mono text-[10px] text-ink-muted">{node.leafCount}</span>
            )}
            {showMethodsOnRow &&
              node.methods.map((m) => (
                <span key={m} className="rounded bg-canvas-inset px-1 py-0.5 font-mono text-[10px] uppercase text-ink-secondary">
                  {m}
                </span>
              ))}
          </button>
          {visibleTags.length > 0 && (
            <span className="flex min-w-0 flex-wrap items-center gap-0.5">
              {visibleTags.map((tag) => (
                <button
                  key={tag.id}
                  type="button"
                  title={tag.title}
                  onClick={() => onOpenVulnerability?.(openFindingFromTag(tag))}
                  className={`inline-block shrink-0 rounded px-1 py-0.5 font-mono text-[10px] font-medium uppercase ${findingTagClass(tag)} hover:opacity-90`}
                >
                  {tag.label}
                </button>
              ))}
              {extraTagCount > 0 && (
                <span className="font-mono text-[10px] text-ink-muted" title={allPreview.map((t) => t.title).join("\n")}>
                  +{extraTagCount}
                </span>
              )}
            </span>
          )}
        </div>
      </div>

      {open && hasChildren && (
        <div>
          {node.children.map((child) => (
            <SurfaceTreeNodeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              isOpen={isOpen}
              onToggle={onToggle}
              onOpenVulnerability={onOpenVulnerability}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type FindingKindId = "vuln" | "auth" | "flag";

type FindingKindGroup = {
  id: FindingKindId;
  label: string;
  shortLabel: string;
  hint: string;
  badgeClass: string;
  items: Array<Record<string, unknown>>;
};

function severityRank(severity: unknown): number {
  const s = normalizeFindingSeverity(severity);
  if (s === "critical") return 0;
  if (s === "high") return 1;
  if (s === "medium") return 2;
  if (s === "low") return 3;
  return 4; // info
}

/** Vuln list: critical → high → medium → low → info; stable title tie-break. */
function sortFindingsBySeverity(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return [...items].sort((a, b) => {
    const bySev = severityRank(a.severity) - severityRank(b.severity);
    if (bySev !== 0) return bySev;
    return String(a.title || "").localeCompare(String(b.title || ""));
  });
}

function groupFindingsByKind(findings: Array<Record<string, unknown>>): FindingKindGroup[] {
  // Exclusive: each finding is exactly one of Vuln | Key | Flag (independent objects).
  const buckets: Record<FindingKindId, Array<Record<string, unknown>>> = { vuln: [], auth: [], flag: [] };
  for (const finding of findings) {
    buckets[classifyFindingKind(finding)].push(finding);
  }
  return [
    {
      id: "vuln",
      label: "Vuln",
      shortLabel: "Vuln",
      hint: "by severity",
      badgeClass: "bg-severity-high-subtle text-severity-high",
      items: sortFindingsBySeverity(buckets.vuln),
    },
    {
      id: "auth",
      label: "Key",
      shortLabel: "Key",
      hint: "password · jwt · apikey · …",
      // Default; row badges use classifyAuthSubtype (cool palette, not severity red).
      badgeClass: "bg-status-running/10 text-status-running",
      items: buckets.auth,
    },
    {
      id: "flag",
      label: "Flags",
      shortLabel: "Flag",
      hint: "CTF / challenge tokens",
      badgeClass: "bg-status-success/15 text-status-success",
      items: buckets.flag,
    },
  ];
}

function findingsTabHoverTitle(groups: FindingKindGroup[]): string {
  const parts = groups.filter((g) => g.items.length > 0).map((g) => `${g.label} ${g.items.length}`);
  return parts.length ? parts.join(" · ") : "Findings";
}

function findingTextBlob(finding: Record<string, unknown>): string {
  return [
    finding.title,
    finding.description,
    finding.impact,
    finding.poc,
    finding.reproduction,
    finding.location,
    finding.flag_value,
  ]
    .map((v) => String(v || ""))
    .join("\n");
}

function hasFlagInFinding(finding: Record<string, unknown>): boolean {
  return Boolean(extractFlagFromFinding(finding));
}

function hasAuthInFinding(finding: Record<string, unknown>): boolean {
  const blob = findingTextBlob(finding);
  return (
    /\b(api[_-]?key|access[_-]?key|secret[_-]?key|aws[_-]?secret|private[_-]?key|akia[0-9a-z]{12,})\b/i.test(blob) ||
    /\b(password|passwd|pwd|credential|credentials)\b/i.test(blob) ||
    /\b(ak\/sk|accesskeyid|secretaccesskey)\b/i.test(blob) ||
    /\b(jwt|bearer\s+[a-z0-9._\-]+|session[_-]?id|cookie)\b/i.test(blob)
  );
}

/** Severity chip styles (vuln rows — no separate VULN badge). */
function severityBadgeClass(severity: unknown): string {
  const s = normalizeFindingSeverity(severity);
  if (s === "critical") return "bg-severity-critical-subtle text-severity-critical";
  if (s === "high") return "bg-severity-high-subtle text-severity-high";
  if (s === "medium") return "bg-severity-medium-subtle text-severity-medium";
  if (s === "low") return "bg-severity-low-subtle text-severity-low";
  return "bg-severity-info-subtle text-severity-info";
}

type AuthSubtype = {
  label: string;
  badgeClass: string;
};

/**
 * Key subtype badge: PASSWORD / JWT / APIKEY / … — cool palette, not vuln severity reds.
 */
function classifyAuthSubtype(finding: Record<string, unknown>): AuthSubtype {
  const blob = findingTextBlob(finding).toLowerCase();
  // Order: more specific first.
  if (/\bjwt\b|\bjson\s*web\s*token\b|\beyj[a-z0-9_-]+\.[a-z0-9_-]+/i.test(blob)) {
    return { label: "JWT", badgeClass: "bg-status-running/12 text-status-running" };
  }
  if (
    /\b(api[_-]?key|access[_-]?key|secret[_-]?key|akia[0-9a-z]{12,}|accesskeyid|secretaccesskey|ak\/sk)\b/i.test(blob)
  ) {
    return { label: "APIKEY", badgeClass: "bg-[#ecfeff] text-[#0e7490]" };
  }
  if (/\b(password|passwd|pwd|口令|密码)\b/i.test(blob)) {
    return { label: "PASSWORD", badgeClass: "bg-[#f5f3ff] text-[#6d28d9]" };
  }
  if (/\b(session[_-]?id|session[_-]?token|phpsessid|jsessionid)\b/i.test(blob)) {
    return { label: "SESSION", badgeClass: "bg-[#f0fdfa] text-[#0f766e]" };
  }
  if (/\b(bearer\s+[a-z0-9._\-]{8,}|oauth|refresh[_-]?token|access[_-]?token)\b/i.test(blob)) {
    return { label: "TOKEN", badgeClass: "bg-[#eef2ff] text-[#4338ca]" };
  }
  if (/\b(private[_-]?key|secret|credential|credentials)\b/i.test(blob)) {
    return { label: "SECRET", badgeClass: "bg-[#f8fafc] text-[#475569]" };
  }
  return { label: "KEY", badgeClass: "bg-status-running/10 text-status-running" };
}

function hasVulnSignalsInFinding(finding: Record<string, unknown>): boolean {
  if (finding.cwe && String(finding.cwe).trim()) return true;
  const title = String(finding.title || "");
  const blob = findingTextBlob(finding);
  return (
    /\b(sql\s*injection|sqli|xss|cross[- ]site|rce|remote\s*code|command\s*injection|ssrf|lfi|rfi|xxe|ssti|idor|path\s*traversal|file\s*upload|deserialization|csrf|open\s*redirect|auth(?:entication|orization)?\s*(?:bypass|flaw)|privilege\s*escalation|insecure|vulnerability|漏洞|注入|越权)\b/i.test(
      title,
    ) || /\b(sql\s*injection|sqli|reflected\s*xss|stored\s*xss|rce|ssrf|cwe-\d+)\b/i.test(blob)
  );
}

function normalizeExplicitKind(finding: Record<string, unknown>): FindingKindId | undefined {
  const explicit = String(finding.finding_kind || finding.kind || finding.category || "")
    .trim()
    .toLowerCase();
  if (["vuln", "vulnerability", "vulns"].includes(explicit)) return "vuln";
  if (
    ["auth", "credential", "credentials", "secret", "secrets", "password", "apikey", "api_key", "aksk", "key"].includes(
      explicit,
    )
  ) {
    return "auth";
  }
  if (["flag", "flags", "ctf"].includes(explicit)) return "flag";
  return undefined;
}

/** Primary kind for a single badge (chat / exclusive contexts). */
function classifyFindingKind(finding: Record<string, unknown>): FindingKindId {
  const explicit = normalizeExplicitKind(finding);
  if (explicit) return explicit;

  const flagPresent = hasFlagInFinding(finding);
  const vulnish = hasVulnSignalsInFinding(finding);
  const authish = hasAuthInFinding(finding);

  if (flagPresent && !vulnish) {
    const title = String(finding.title || "").trim();
    if (/\b(?:ctf\s*)?flag\b/i.test(title) || /^flag\{/i.test(title) || !authish) return "flag";
  }
  if (authish && !vulnish) return "auth";
  return "vuln";
}

function extractFlagFromFinding(finding: Record<string, unknown>): string | undefined {
  const direct = String(finding.flag_value || "").trim();
  if (direct) return direct;
  const blob = [finding.title, finding.description, finding.poc, finding.reproduction, finding.impact]
    .map((v) => String(v || ""))
    .join("\n");
  const m = blob.match(/flag\{[^{}\n]{2,120}\}/i) || blob.match(/FLAG\{[^{}\n]{2,120}\}/);
  return m ? m[0] : undefined;
}

function findingDisplayTitle(finding: Record<string, unknown>, kind: FindingKindId): string {
  if (kind === "flag") {
    const flag = extractFlagFromFinding(finding);
    if (flag) return flag;
  }
  return String(finding.title || "Untitled finding");
}

/** Card subtitle: short issue description (not path soup / agent noise). */
function findingMetaLine(finding: Record<string, unknown>, _kind?: FindingKindId): string {
  const desc = String(finding.description || finding.impact || "").replace(/\s+/g, " ").trim();
  if (desc) return desc.length > 160 ? `${desc.slice(0, 157)}…` : desc;
  if (_kind === "flag") {
    const flag = extractFlagFromFinding(finding);
    if (flag) return flag;
  }
  const loc = String(finding.location || finding.endpoint || finding.url || "").trim();
  return loc || "";
}

function markdownPreview(value: string): string {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/[#*_`>\-[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function orderStrixAgents(agents: StrixAgentStatus[]): StrixAgentStatus[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const depth = (agent: StrixAgentStatus): number => {
    let count = 0;
    let parentId = agent.parent_id || "";
    const seen = new Set<string>();
    while (parentId && byId.has(parentId) && !seen.has(parentId)) {
      seen.add(parentId);
      count += 1;
      parentId = byId.get(parentId)?.parent_id || "";
    }
    return count;
  };
  return [...agents].sort((left, right) => depth(left) - depth(right) || String(left.parent_id || "").localeCompare(String(right.parent_id || "")) || left.name.localeCompare(right.name));
}

function agentStatusCount(agents: StrixAgentStatus[]): string {
  const active = agents.filter((agent) => isActiveAgentStatus(agent.status)).length;
  return `${active}/${agents.length} active`;
}

function isActiveAgentStatus(status: string | undefined): boolean {
  return ["running", "waiting", "pending"].includes(String(status || "").toLowerCase());
}

function agentStatusLabel(status: string | undefined): string {
  const normalized = String(status || "running").toLowerCase();
  if (normalized === "completed") return "done";
  if (normalized === "crashed") return "failed";
  if (normalized === "waiting") return "pending";
  if (normalized === "timed_out" || normalized === "timeout") return "timeout";
  return normalized;
}

function isInterruptedAgentStatus(status: string): boolean {
  return ["failed", "stopped", "interrupted", "canceled", "cancelled", "timeout", "aborted"].includes(status);
}

function agentStatusDotClass(status: string | undefined): string {
  const normalized = agentStatusLabel(status);
  if (normalized === "running") return "bg-status-running";
  if (normalized === "pending") return "bg-[#d97706]";
  if (normalized === "timeout") return "bg-severity-high";
  if (isInterruptedAgentStatus(normalized)) return "bg-severity-critical";
  if (normalized === "done") return "bg-status-success";
  return "bg-canvas-inset";
}

function agentStatusBadgeClass(status: string | undefined): string {
  const normalized = agentStatusLabel(status);
  if (normalized === "running") return "bg-status-running/10 text-status-running";
  if (normalized === "done") return "bg-status-success/10 text-status-success";
  if (normalized === "timeout") return "bg-severity-high-subtle text-severity-high";
  if (isInterruptedAgentStatus(normalized)) return "bg-severity-critical-subtle text-severity-critical";
  if (normalized === "pending") return "bg-[#fff7ed] text-[#d97706]";
  return "bg-canvas-inset text-ink-secondary";
}

function summarizeAgentAction(agent: StrixAgentStatus): string {
  const tool = String(agent.current_tool || "").trim();
  const action = String(agent.current_action || "").trim();
  const status = agentStatusLabel(agent.status);
  if (status === "timeout") return "Timed out before package finished";
  if (status === "failed") return "Worker failed — re-dispatch or continue probes";
  if (status === "aborted" || status === "stopped") return "Worker stopped early";
  if (tool) {
    const toolLabel = friendlyActionName(tool);
    if (action) return clip(`${toolLabel}: ${compactAgentAction(action)}`, 110);
    return `${toolLabel} running`;
  }
  if (action && !["done", "completed", "timeout", "failed"].includes(action)) return compactAgentAction(action);
  if (agent.task) return clip(agent.task, 90);
  return status === "done" ? "Finished assigned work" : "Waiting for work";
}

function compactAgentAction(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (/^running command:/i.test(text)) return "Running a command";
  if (/^creating sub-agent:/i.test(text)) return text.replace(/^creating sub-agent:/i, "Delegating to").trim();
  if (/^reporting finding:/i.test(text)) return text.replace(/^reporting finding:/i, "Recording").trim();
  return clip(text, 90);
}

function friendlyActionName(tool: string): string {
  return tool.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function friendlySkillName(skill: string): string {
  const explicit: Record<string, string> = {
    authentication_jwt: "Auth / JWT",
    business_logic: "Business logic",
    sql_injection: "SQL injection",
    ssrf: "SSRF",
    ssti: "SSTI",
    csrf: "CSRF",
    rce: "RCE",
    xss: "XSS",
  };
  const normalized = String(skill || "").trim();
  return explicit[normalized.toLowerCase()] || friendlyActionName(normalized);
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

function normalizeTodoStatus(status: PlanStatus | undefined): "running" | "done" | "failed" | "blocked" | "skipped" | "pending" {
  const normalized = String(status || "pending").toLowerCase();
  if (["completed", "complete", "done"].includes(normalized)) return "done";
  if (["running", "in_progress", "active"].includes(normalized)) return "running";
  if (["failed", "error", "crashed"].includes(normalized)) return "failed";
  if (normalized === "blocked") return "blocked";
  if (normalized === "skipped") return "skipped";
  return "pending";
}

function todoStatusIcon(status: ReturnType<typeof normalizeTodoStatus>) {
  if (status === "done") return CheckCircle2;
  if (status === "running") return CircleDashed;
  if (status === "failed" || status === "blocked") return XCircle;
  return Circle;
}

function todoStatusIconClass(status: ReturnType<typeof normalizeTodoStatus>): string {
  if (status === "running") return "text-status-running";
  if (status === "done") return "text-status-success";
  if (status === "failed" || status === "blocked") return "text-severity-critical";
  if (status === "skipped") return "text-ink-muted";
  return "text-[#d97706]";
}

function todoTitleClass(status: ReturnType<typeof normalizeTodoStatus>): string {
  if (status === "done" || status === "skipped") return "text-ink-muted";
  return "text-ink";
}

function normalizeSeconds(seconds: unknown): number {
  const value = Number(seconds || 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
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
