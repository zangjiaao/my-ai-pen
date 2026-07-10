import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Bot, CheckCircle2, Circle, CircleDashed, GitBranch, Tag, XCircle } from "lucide-react";
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
  onOpenVulnerability,
  onOpenAsset,
}: Props) {
  const [tab, setTab] = useState<Tab>("status");
  const surfaceItems = attackSurfaceItems(planTree);
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
            <div className="space-y-2">
              {surfaceItems.map((node, index) => (
                <div key={planNodeKey(node, index)} className="rounded-md border border-hairline-soft p-2">
                  <div className="mb-1 flex min-w-0 items-center gap-1">
                    <span className="rounded-md bg-canvas-inset px-1.5 py-0.5 text-[10px] uppercase text-ink-secondary">{String(node.method || node.kind || "endpoint")}</span>
                    <span className="truncate text-sm font-medium">{String(node.endpoint || node.title || "Untitled surface")}</span>
                  </div>
                  {(node.parameters?.length || node.vuln_type || node.notes) && (
                    <p className="break-words text-xs text-ink-muted">
                      {[
                        node.parameters?.length ? `params: ${node.parameters.join(", ")}` : "",
                        node.vuln_type ? `class: ${node.vuln_type}` : "",
                        node.notes || "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  )}
                </div>
              ))}
            </div>
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
                        onClick={() => onOpenVulnerability?.(finding as Partial<SecurityVulnerability>)}
                        className="block w-full rounded-md border border-hairline-soft p-2 text-left transition-colors hover:bg-surface-default"
                      >
                        <div className="mb-1 flex min-w-0 items-center gap-1">
                          <span className={`inline-block shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase ${group.badgeClass}`}>
                            {group.shortLabel}
                          </span>
                          {group.id === "vuln" && (
                            <span className={`inline-block shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase bg-severity-${finding.severity || "info"}-subtle text-severity-${finding.severity || "info"}`}>
                              {String(finding.severity || "info")}
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
        {item.notes && <p className="mt-0.5 break-words text-xs text-ink-muted [overflow-wrap:anywhere]">{clip(item.notes, 150)}</p>}
      </div>
    </div>
  );
}

function workerOutcomeBadge(item: PlanNode): { label: string; className: string } | null {
  const notes = String(item.notes || "").toLowerCase();
  const title = String(item.title || "").toLowerCase();
  const status = String(item.status || "").toLowerCase();
  if (status === "running") return { label: "running", className: "bg-status-running/15 text-status-running" };
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

/**
 * Attack-surface inventory for the Surface tab.
 * Prefer explicit surface/request nodes; also fold unique endpoints observed
 * via coverage/http work so the tab is not empty when only mark/test ran.
 */
function attackSurfaceItems(nodes: PlanNode[]): PlanNode[] {
  const seen = new Set<string>();
  const surfaces: PlanNode[] = [];

  const push = (node: PlanNode, endpoint: string, method?: string | null) => {
    const path = String(endpoint || "").trim();
    if (!path || path === "-" || path.startsWith("http") && !path.includes("/")) return;
    // Normalize full URLs to pathname when possible.
    let display = path;
    try {
      if (/^https?:\/\//i.test(path)) display = new URL(path).pathname || path;
    } catch {
      // keep raw
    }
    const key = `${String(method || node.method || "").toUpperCase()} ${display}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    surfaces.push({
      ...node,
      endpoint: display,
      method: method || node.method || null,
      title: node.title || `${String(method || node.method || "ENDPOINT").toUpperCase()} ${display}`,
      kind: node.kind === "surface" || node.kind === "request" ? node.kind : "surface",
    });
  };

  for (const node of nodes) {
    if ((node.level || "work_item") !== "work_item") continue;
    const kind = String(node.kind || "");
    if (kind === "surface" || kind === "request") {
      push(node, String(node.endpoint || node.title || ""), node.method);
      continue;
    }
    // Coverage/http/worker probes that recorded an endpoint.
    if (node.endpoint && ["test", "http", "browser", "scan", "traffic", "worker"].includes(kind)) {
      push(node, String(node.endpoint), node.method);
    }
  }

  return surfaces.sort((a, b) =>
    String(a.endpoint || "").localeCompare(String(b.endpoint || ""))
    || String(a.method || "").localeCompare(String(b.method || "")),
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

function groupFindingsByKind(findings: Array<Record<string, unknown>>): FindingKindGroup[] {
  const buckets: Record<FindingKindId, Array<Record<string, unknown>>> = { vuln: [], auth: [], flag: [] };
  for (const finding of findings) {
    buckets[classifyFindingKind(finding)].push(finding);
  }
  return [
    {
      id: "vuln",
      label: "Vuln",
      shortLabel: "Vuln",
      hint: "vulnerabilities",
      badgeClass: "bg-severity-high-subtle text-severity-high",
      items: buckets.vuln,
    },
    {
      id: "auth",
      label: "Auth",
      shortLabel: "Auth",
      hint: "credentials / secrets",
      badgeClass: "bg-severity-critical-subtle text-severity-critical",
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

function classifyFindingKind(finding: Record<string, unknown>): FindingKindId {
  const explicit = String(finding.finding_kind || finding.kind || finding.category || "")
    .trim()
    .toLowerCase();
  if (["vuln", "vulnerability", "vulns"].includes(explicit)) return "vuln";
  if (["auth", "credential", "credentials", "secret", "secrets", "password", "apikey", "api_key", "aksk"].includes(explicit)) {
    return "auth";
  }
  if (["flag", "flags", "ctf"].includes(explicit)) return "flag";

  const blob = [
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

  if (/flag\s*\{[^{}\n]{2,120}\}/i.test(blob) || /\bFLAG\s*\{[^{}\n]{2,120}\}/.test(blob)) return "flag";
  if (
    /\b(api[_-]?key|access[_-]?key|secret[_-]?key|aws[_-]?secret|private[_-]?key|akia[0-9a-z]{12,})\b/i.test(blob) ||
    /\b(password|passwd|pwd|credential|credentials)\b/i.test(blob) ||
    /\b(ak\/sk|accesskeyid|secretaccesskey)\b/i.test(blob)
  ) {
    return "auth";
  }
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

function findingMetaLine(finding: Record<string, unknown>, kind?: FindingKindId): string {
  if (kind === "flag") {
    const loc = String(finding.location || finding.url || finding.endpoint || "").trim();
    const title = String(finding.title || "").replace(/flag\{[^{}\n]+\}/gi, "").replace(/\s+/g, " ").trim();
    return [loc, title && title !== extractFlagFromFinding(finding) ? title : ""].filter(Boolean).join(" · ") || "CTF flag";
  }
  if (kind === "auth") {
    return (
      [finding.location || finding.url, finding.description || finding.impact]
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .join(" · ")
        .slice(0, 160) || "credential"
    );
  }
  const pieces = [
    [finding.method, finding.endpoint || finding.location].filter(Boolean).join(" "),
    finding.cwe,
    finding.agent_name ? `agent: ${finding.agent_name}` : "",
    finding.affected_asset,
    finding.status,
  ].map((item) => String(item || "").trim()).filter(Boolean);
  return pieces[0] || "";
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
