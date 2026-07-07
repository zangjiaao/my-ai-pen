import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Bot, CheckCircle2, Circle, CircleDashed, GitBranch, Tag, XCircle } from "lucide-react";
import type { SecurityAsset, SecurityVulnerability } from "../lib/securityTypes";

type Tab = "status" | "discoveries" | "activity";
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
  const hasStatusData = running || Boolean(activeTool) || planTree.length > 0 || orderedStrixAgents.length > 0 || findings.length > 0 || assets.length > 0 || timeline.length > 0;
  const kanbanSummary = normalizeKanban(kanban, planTree, progress, workflowKind);
  const isStrixWorkflow = workflowKind === "strix" || kanbanSummary.workflow_kind === "strix" || planTree.some((node) => String(node.source || "") === "strix_todo");
  const phasePlan = hasStatusData ? buildPhasePlan(planTree, kanbanSummary.current_stage, activeTool, running, findings.length, isStrixWorkflow) : [];
  const overallProgress = overallPlanProgress(phasePlan, kanbanSummary, progress);
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
  const tabs: { key: Tab; label: string }[] = [
    { key: "status", label: "Status" },
    { key: "discoveries", label: `Discoveries${findings.length + assets.length + surfaceItems.length + strixNotes.length ? ` (${findings.length + assets.length + surfaceItems.length + strixNotes.length})` : ""}` },
    { key: "activity", label: `Activity${timeline.length ? ` (${timeline.length})` : ""}` },
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
      <nav className="grid grid-cols-3 border-b border-hairline-soft">
        {tabs.map((item) => (
          <button
            key={item.key}
            data-testid={`right-tab-${item.key}`}
            onClick={() => setTab(item.key)}
            className={`py-2.5 text-sm font-medium transition-colors ${tab === item.key ? "border-b-2 border-ink text-ink" : "border-b-2 border-transparent text-ink-secondary hover:text-ink"}`}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="flex-1 overflow-y-auto p-4">
        {tab === "status" && (
          <div className="space-y-4">
            {isStrixWorkflow && strixRun ? (
              <StrixRunSummary run={strixRun} elapsedText={elapsedText} />
            ) : (
              <section>
                <p className="mb-1 text-xs text-ink-muted">Elapsed</p>
                <p className="font-mono text-xl font-semibold leading-none tracking-normal">{elapsedText}</p>
              </section>
            )}
            {!isStrixWorkflow && hasStatusData && overallProgress.label !== "waiting" && <OverallProgress progress={overallProgress} />}
            {orderedStrixAgents.length > 0 && (
              <section>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-xs text-ink-muted">Agent collaboration</p>
                  <p className="font-mono text-[11px] text-ink-muted">{agentStatusCount(orderedStrixAgents)}</p>
                </div>
                <StrixAgentList agents={orderedStrixAgents} />
              </section>
            )}
            <section>
              <p className="mb-2 text-xs text-ink-muted">{isStrixWorkflow ? "Strix tasks" : "Workflow plan"}</p>
              {isStrixWorkflow ? (
                <StrixTodoList items={phasePlan.flatMap((phase) => phase.items)} running={running} />
              ) : (
                <WorkflowPlan phases={phasePlan} running={running} />
              )}
            </section>
            {intake && <IntakeSummary intake={intake} />}
          </div>
        )}
        {tab === "discoveries" && (
          findings.length + assets.length + surfaceItems.length + strixNotes.length === 0 ? (
            <p className="text-sm text-ink-muted">No discoveries yet</p>
          ) : (
            <div className="space-y-4">
              {findings.length > 0 && (
                <DiscoverySection title="Findings">
                  {findings.map((finding, index) => (
                    <button
                      key={(finding.id as string) || (finding.vulnerability_id as string) || index}
                      type="button"
                      onClick={() => onOpenVulnerability?.(finding as Partial<SecurityVulnerability>)}
                      className="block w-full rounded-md border border-hairline-soft p-2 text-left transition-colors hover:bg-surface-default"
                    >
                      <div className="mb-1 flex min-w-0 items-center gap-1">
                        <span className={`inline-block rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase bg-severity-${finding.severity || "info"}-subtle text-severity-${finding.severity || "info"}`}>
                          {String(finding.severity || "info")}
                        </span>
                        <span className="truncate text-sm font-medium">{String(finding.title || "Untitled vulnerability")}</span>
                      </div>
                      <p className="break-words text-xs text-ink-muted">{findingMetaLine(finding)}</p>
                    </button>
                  ))}
                </DiscoverySection>
              )}
              {strixNotes.length > 0 && (
                <DiscoverySection title="Notes">
                  {strixNotes.map((note, index) => (
                    <div key={note.id || index} className="rounded-md border border-hairline-soft p-2">
                      <div className="mb-1 flex min-w-0 items-center gap-1">
                        {note.category && <span className="rounded-md bg-canvas-inset px-1.5 py-0.5 text-[10px] uppercase text-ink-secondary">{note.category}</span>}
                        <span className="truncate text-sm font-medium">{note.title || "Untitled note"}</span>
                      </div>
                      {note.content && <p className="break-words text-xs text-ink-muted [overflow-wrap:anywhere]">{clip(markdownPreview(note.content), 220)}</p>}
                      {note.tags?.length ? (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {note.tags.slice(0, 4).map((tag) => (
                            <span key={tag} className="rounded-sm bg-canvas-inset px-1.5 py-0.5 text-[10px] text-ink-secondary">{tag}</span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </DiscoverySection>
              )}
              {assets.length > 0 && (
                <DiscoverySection title="Assets">
                  {assets.map((asset, index) => {
                    const props = asset.properties as Record<string, unknown> | undefined;
                    const ports = Array.isArray(asset.open_ports) ? asset.open_ports : Array.isArray(props?.open_ports) ? props.open_ports as unknown[] : [];
                    return (
                      <button
                        key={(asset.id as string) || (asset.asset_id as string) || (asset.address as string) || index}
                        type="button"
                        onClick={() => onOpenAsset?.(asset as Partial<SecurityAsset>)}
                        className="block w-full rounded-md border border-hairline-soft p-2 text-left transition-colors hover:bg-surface-default"
                      >
                        <div className="mb-1 flex min-w-0 items-center gap-1">
                          <span className="rounded-md bg-canvas-inset px-1.5 py-0.5 text-[10px] uppercase text-ink-secondary">{String(asset.asset_type || asset.type || "asset")}</span>
                          <span className="truncate text-sm font-medium">{String(asset.address || asset.name || "Unknown asset")}</span>
                        </div>
                        <p className="break-words text-xs text-ink-muted">ports: {ports.length ? ports.join(", ") : "-"}</p>
                      </button>
                    );
                  })}
                </DiscoverySection>
              )}
              {surfaceItems.length > 0 && (
                <DiscoverySection title="Attack Surface">
                  {surfaceItems.map((node, index) => (
                    <div key={planNodeKey(node, index)} className="rounded-md border border-hairline-soft p-2">
                      <div className="mb-1 flex min-w-0 items-center gap-1">
                        <span className="rounded-md bg-canvas-inset px-1.5 py-0.5 text-[10px] uppercase text-ink-secondary">{String(node.method || node.kind || "surface")}</span>
                        <span className="truncate text-sm font-medium">{String(node.endpoint || node.title || "Untitled surface")}</span>
                      </div>
                      {(node.parameters?.length || node.notes) && <p className="break-words text-xs text-ink-muted">{node.parameters?.length ? `params: ${node.parameters.join(", ")}` : node.notes}</p>}
                    </div>
                  ))}
                </DiscoverySection>
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
    return <p className="text-sm text-ink-muted">{running ? "Waiting for Strix to publish tasks" : "No active task plan yet"}</p>;
  }
  const orderedItems = [...items].sort((left, right) => strixTaskStatusWeight(left.status) - strixTaskStatusWeight(right.status) || Number(left.priority || 999) - Number(right.priority || 999) || String(left.title || "").localeCompare(String(right.title || "")));
  return (
    <div className="space-y-1" data-testid="strix-todo-list">
      {orderedItems.map((item, index) => <StrixTodoItem key={planNodeKey(item, index)} item={item} />)}
    </div>
  );
}

function StrixTodoItem({ item }: { item: PlanNode }) {
  const status = normalizeTodoStatus(item.status);
  const Icon = todoStatusIcon(status);
  return (
    <div className="flex min-w-0 items-start gap-2 rounded-md px-2 py-2 hover:bg-canvas-inset">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${todoStatusIconClass(status)}`} />
      <div className="min-w-0 flex-1">
        <p className={`break-words text-sm font-medium [overflow-wrap:anywhere] ${todoTitleClass(status)}`}>{String(item.title || "Untitled task")}</p>
        {item.notes && <p className="mt-0.5 break-words text-xs text-ink-muted [overflow-wrap:anywhere]">{clip(item.notes, 150)}</p>}
      </div>
    </div>
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

function DiscoverySection({ title, children }: { title: string; children: ReactNode }) {
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

function agentPlanItems(nodes: PlanNode[]): PlanNode[] {
  return nodes.filter((node) => {
    if ((node.level || "work_item") !== "work_item") return false;
    if (!["agent", "strix_todo"].includes(String(node.source || ""))) return false;
    const kind = String(node.kind || "task");
    return !["tool", "browser", "http", "poc", "scan", "traffic", "finding"].includes(kind);
  });
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

function attackSurfaceItems(nodes: PlanNode[]): PlanNode[] {
  const seen = new Set<string>();
  const surfaces: PlanNode[] = [];
  for (const node of nodes) {
    if ((node.level || "work_item") !== "work_item") continue;
    const kind = String(node.kind || "");
    if (kind !== "surface" && kind !== "request") continue;
    const key = `${node.method || ""} ${node.endpoint || node.title || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    surfaces.push(node);
  }
  return surfaces;
}

function findingMetaLine(finding: Record<string, unknown>): string {
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
  return normalized;
}

function isInterruptedAgentStatus(status: string): boolean {
  return ["failed", "stopped", "interrupted", "canceled", "cancelled"].includes(status);
}

function agentStatusDotClass(status: string | undefined): string {
  const normalized = agentStatusLabel(status);
  if (normalized === "running") return "bg-status-running";
  if (normalized === "pending") return "bg-[#d97706]";
  if (isInterruptedAgentStatus(normalized)) return "bg-severity-critical";
  if (normalized === "done") return "bg-status-success";
  return "bg-canvas-inset";
}

function agentStatusBadgeClass(status: string | undefined): string {
  const normalized = agentStatusLabel(status);
  if (normalized === "running") return "bg-status-running/10 text-status-running";
  if (normalized === "done") return "bg-status-success/10 text-status-success";
  if (isInterruptedAgentStatus(normalized)) return "bg-severity-critical-subtle text-severity-critical";
  if (normalized === "pending") return "bg-[#fff7ed] text-[#d97706]";
  return "bg-canvas-inset text-ink-secondary";
}

function summarizeAgentAction(agent: StrixAgentStatus): string {
  const tool = String(agent.current_tool || "").trim();
  const action = String(agent.current_action || "").trim();
  if (tool) {
    const toolLabel = friendlyActionName(tool);
    if (action) return clip(`${toolLabel}: ${compactAgentAction(action)}`, 110);
    return `${toolLabel} running`;
  }
  if (action) return compactAgentAction(action);
  if (agent.task) return clip(agent.task, 90);
  return agentStatusLabel(agent.status) === "done" ? "Finished assigned work" : "Waiting for work";
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

function strixTaskStatusWeight(status: PlanStatus | undefined): number {
  const normalized = normalizeTodoStatus(status);
  if (normalized === "running") return 0;
  if (normalized === "pending") return 1;
  if (normalized === "blocked") return 2;
  if (normalized === "failed") return 3;
  if (normalized === "done") return 4;
  return 5;
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
