import { useEffect, useState, type ReactNode } from "react";
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
  timeline?: TimelineEvent[];
  timelineCursorAt?: string;
  findings?: Array<Record<string, unknown>>;
  assets?: Array<Record<string, unknown>>;
  onOpenVulnerability?: (finding: Partial<SecurityVulnerability>) => void;
  onOpenAsset?: (asset: Partial<SecurityAsset>) => void;
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
  timeline = [],
  timelineCursorAt,
  findings = [],
  assets = [],
  onOpenVulnerability,
  onOpenAsset,
}: Props) {
  const [tab, setTab] = useState<Tab>("status");
  const surfaceItems = attackSurfaceItems(planTree);
  const kanbanSummary = normalizeKanban(kanban, planTree, progress, workflowKind);
  const phasePlan = buildPhasePlan(planTree, kanbanSummary.current_stage, activeTool, running, findings.length);
  const currentAction = currentActionText({ activeTool, running, currentStage: kanbanSummary.current_stage, timeline, phasePlan });
  const overallProgress = overallPlanProgress(phasePlan, kanbanSummary, progress);
  const elapsedBaseSeconds = normalizeSeconds(kanbanSummary.elapsed_seconds);
  const intake = normalizeIntake(intakeResult, intakeStatus);
  const [elapsedClock, setElapsedClock] = useState(() => ({
    baseSeconds: elapsedBaseSeconds,
    anchorMs: Date.now(),
    nowMs: Date.now(),
  }));

  useEffect(() => {
    setElapsedClock({ baseSeconds: elapsedBaseSeconds, anchorMs: Date.now(), nowMs: Date.now() });
  }, [elapsedBaseSeconds]);

  useEffect(() => {
    if (!running) return;
    const update = () => setElapsedClock((current) => ({ ...current, nowMs: Date.now() }));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const elapsedText = formatDuration(elapsedClock.baseSeconds + (running ? Math.max(0, Math.floor((elapsedClock.nowMs - elapsedClock.anchorMs) / 1000)) : 0));
  const tabs: { key: Tab; label: string }[] = [
    { key: "status", label: "Status" },
    { key: "discoveries", label: `Discoveries${findings.length + assets.length + surfaceItems.length ? ` (${findings.length + assets.length + surfaceItems.length})` : ""}` },
    { key: "activity", label: `Activity${timeline.length ? ` (${timeline.length})` : ""}` },
  ];

  return (
    <aside className="flex w-[360px] flex-shrink-0 flex-col border-l border-hairline bg-canvas">
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
            <section>
              <p className="mb-1 text-xs text-ink-muted">Elapsed</p>
              <p className="font-mono text-xl font-semibold leading-none tracking-normal">{elapsedText}</p>
            </section>
            <OverallProgress progress={overallProgress} />
            <section>
              <p className="mb-1 text-xs text-ink-muted">Current action</p>
              <p className="break-words text-sm font-medium [overflow-wrap:anywhere]">{currentAction}</p>
            </section>
            <section>
              <p className="mb-2 text-xs text-ink-muted">Workflow plan</p>
              <WorkflowPlan phases={phasePlan} />
            </section>
            {intake && <IntakeSummary intake={intake} />}
          </div>
        )}
        {tab === "discoveries" && (
          findings.length + assets.length + surfaceItems.length === 0 ? (
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
                      <p className="break-words text-xs text-ink-muted">{String(finding.location || finding.affected_asset || finding.status || "")}</p>
                    </button>
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

function WorkflowPlan({ phases }: { phases: PhasePlan[] }) {
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
                <p className="text-xs text-ink-muted">Waiting for agent plan</p>
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

function buildPhasePlan(nodes: PlanNode[], currentStage: string | undefined, activeTool: string | undefined, running: boolean, findingsCount: number): PhasePlan[] {
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
  for (const item of agentPlanItems(nodes)) {
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
    if (String(node.source || "") !== "agent") return false;
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

function currentActionText({ activeTool, running, currentStage, timeline, phasePlan }: { activeTool?: string; running?: boolean; currentStage?: string; timeline: TimelineEvent[]; phasePlan: PhasePlan[] }): string {
  const tool = String(activeTool || "").trim();
  if (running && tool && tool !== "pi") return actionForTool(tool);
  const activePlanItem = phasePlan.flatMap((phase) => phase.items).find((item) => item.status === "running");
  if (running && activePlanItem?.title) return String(activePlanItem.title);
  const recent = [...timeline].reverse().find((event) => event.title && !["status", "workflow"].includes(event.category.toLowerCase()));
  if (running && recent) return recent.title;
  if (currentStage === "completed") return "Task complete";
  if (currentStage === "incomplete") return "Task stopped before completion";
  if (currentStage === "summarizing") return "Preparing summary";
  if (running) return "Agent is working";
  return "Idle";
}

function actionForTool(tool: string): string {
  const normalized = tool.toLowerCase();
  if (["browser", "scan", "traffic"].includes(normalized)) return "Discovering target surface";
  if (["http", "poc", "coverage", "skill"].includes(normalized)) return "Testing selected behavior";
  if (["verifier", "finding"].includes(normalized)) return "Verifying and recording findings";
  return `${tool} running`;
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

function formatDuration(seconds: unknown): string {
  const total = normalizeSeconds(seconds);
  if (total <= 0) return "00:00";
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (item: number) => String(item).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
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
