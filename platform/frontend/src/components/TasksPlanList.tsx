import { useState, type ReactNode } from "react";
import { CheckCircle2, Circle, CircleDashed, XCircle } from "lucide-react";
import { displayTodoTitle, resolveTasksAgentChip } from "../lib/workerPresentation";
import type { PlanNode, PlanStatus, StrixAgentStatus } from "../lib/panelTypes";

export type { PlanNode, PlanStatus } from "../lib/panelTypes";

export type GraphAwareTodoListProps = {
  planTree: PlanNode[];
  workItems: PlanNode[];
  running?: boolean;
  /** Collaboration roster for chip fallback when owner_agent_name is missing. */
  agents?: StrixAgentStatus[];
};

/**
 * Expert Graph: L1 phase nodes as section headers, L2 work items nested.
 * Free / flat plans: fall back to flat StrixTodoList.
 *
 * If L1 phases were stripped by a bad snapshot but L2 still parents to
 * graph-stage-*, synthesize stage headers from those parent_ids.
 *
 * L1 stages are collapsible: completed stages auto-collapse; user can expand/collapse.
 */
export function GraphAwareTodoList({
  planTree,
  workItems,
  running,
  agents,
}: GraphAwareTodoListProps) {
  // Manual overrides: true=open, false=closed. Missing key → auto policy.
  const [manual, setManual] = useState<Record<string, boolean>>({});

  const explicitPhases = planTree.filter(
    (n) =>
      String(n.level || "") === "phase" ||
      String(n.kind || "") === "phase" ||
      String(n.node_id || n.id || "").startsWith("graph-stage-"),
  );
  const phases =
    explicitPhases.length > 0
      ? explicitPhases
      : synthesizeGraphStagesFromWorkItems(workItems.length ? workItems : planTree);

  if (!phases.length) {
    return <StrixTodoList items={workItems} running={running} agents={agents} />;
  }

  const byParent = new Map<string, PlanNode[]>();
  for (const item of workItems) {
    const pid = String(item.parent_id || "");
    if (!byParent.has(pid)) byParent.set(pid, []);
    byParent.get(pid)!.push(item);
  }
  const orphan = workItems.filter((item) => {
    const pid = String(item.parent_id || "");
    return !pid || !phases.some((p) => String(p.node_id || p.id) === pid);
  });

  const phaseMeta = phases.map((phase, index) => {
    const id = String(phase.node_id || phase.id || index);
    const children = byParent.get(id) || [];
    const allDone =
      children.length > 0
        ? children.every((c) => isTerminalPlanStatus(c.status))
        : isTerminalPlanStatus(phase.status);
    const anyRunning =
      String(phase.status || "").toLowerCase() === "running" ||
      children.some((c) => normalizeTodoStatus(c.status) === "running");
    return { phase, id, children, allDone, anyRunning };
  });

  const isExpanded = (m: (typeof phaseMeta)[0]): boolean => {
    if (Object.prototype.hasOwnProperty.call(manual, m.id)) return manual[m.id]!;
    // Auto: expand running / incomplete; collapse fully terminal stages.
    if (m.anyRunning) return true;
    if (m.allDone) return false;
    return true;
  };

  return (
    <div className="space-y-1" data-testid="graph-todo-list">
      {phaseMeta.map((m) => {
        const { phase, id, children } = m;
        const status = normalizeTodoStatus(phase.status);
        const open = isExpanded(m);
        const doneN = children.filter((c) => isTerminalPlanStatus(c.status)).length;
        const title = String(phase.title || id.replace(/^graph-stage-/, "") || id);
        return (
          <div key={id} className="space-y-0" data-stage-id={id} data-expanded={open ? "true" : "false"}>
            {/* L1 uses the same row chrome as L2 (icon + title); click toggles expand without chevron chrome. */}
            <PlanRow
              status={status}
              title={title}
              meta={children.length ? `${doneN}/${children.length}` : undefined}
              interactive
              ariaExpanded={open}
              onClick={() =>
                setManual((prev) => ({
                  ...prev,
                  [id]: !open,
                }))
              }
            />
            {open && children.length > 0 ? (
              <div className="ml-3 border-l border-hairline-soft pl-2">
                <div className="space-y-0">
                  {children.map((item, index) => (
                    <StrixTodoItem key={planNodeKey(item, index)} item={item} agents={agents} />
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
      {orphan.length > 0 && (
        <div className="space-y-0">
          <p className="px-2 py-1 text-[10px] font-semibold uppercase text-ink-muted">Other</p>
          <StrixTodoList items={orphan} running={running} agents={agents} />
        </div>
      )}
    </div>
  );
}

export function GraphAwareTodoListSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-1" data-testid="graph-todo-list-skeleton">
      <div className="space-y-0">
        <PlanRowSkeleton titleWidth="w-24" metaWidth="w-8" />
        <div className="ml-3 border-l border-hairline-soft pl-2">
          <div className="space-y-0">
            <PlanRowSkeleton titleWidth="w-[72%]" badgeWidth="w-12" />
            <PlanRowSkeleton titleWidth="w-[58%]" />
          </div>
        </div>
      </div>
      <div className="space-y-0">
        <PlanRowSkeleton titleWidth="w-32" metaWidth="w-8" />
      </div>
      <div className="space-y-0">
        <PlanRowSkeleton titleWidth="w-20" metaWidth="w-8" />
      </div>
    </div>
  );
}

/** Recover L1 headers when only L2 work_items with graph-stage-* parents remain. */
function synthesizeGraphStagesFromWorkItems(nodes: PlanNode[]): PlanNode[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const statusByStage = new Map<string, string>();
  for (const n of nodes) {
    const pid = String(n.parent_id || "").trim();
    if (!pid.startsWith("graph-stage-")) continue;
    if (!seen.has(pid)) {
      seen.add(pid);
      order.push(pid);
    }
    const st = String(n.status || "pending").toLowerCase();
    const prev = statusByStage.get(pid) || "pending";
    // Prefer running > pending > done for header
    if (st === "running" || (st === "pending" && prev === "done")) {
      statusByStage.set(pid, st === "running" ? "running" : "pending");
    } else if (!statusByStage.has(pid)) {
      statusByStage.set(pid, st === "done" || st === "completed" ? "done" : st || "pending");
    }
  }
  return order.map((id, i) => ({
    node_id: id,
    id,
    title: id.replace(/^graph-stage-/, ""),
    level: "phase",
    kind: "phase",
    source: "plan",
    parent_id: null,
    status: statusByStage.get(id) || "pending",
    priority: (i + 1) * 100,
  }));
}

function StrixTodoList({
  items,
  running = false,
  agents,
}: {
  items: PlanNode[];
  running?: boolean;
  agents?: StrixAgentStatus[];
}) {
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
      {items.map((item, index) => (
        <StrixTodoItem key={planNodeKey(item, index)} item={item} agents={agents} />
      ))}
    </div>
  );
}

const PLAN_ROW_CLASS = "flex min-w-0 items-start gap-2 rounded-md px-2 py-2";

function PlanRowSkeleton({
  titleWidth,
  metaWidth,
  badgeWidth,
}: {
  titleWidth: string;
  metaWidth?: string;
  badgeWidth?: string;
}) {
  return (
    <div className={PLAN_ROW_CLASS}>
      <div className="mt-0.5 h-4 w-4 shrink-0 rounded-full bg-canvas-inset" />
      <div className="flex h-5 min-w-0 flex-1 items-center gap-1.5">
        <div className={`h-3 rounded-full bg-canvas-inset ${titleWidth}`} />
        {badgeWidth ? <div className={`h-4 shrink-0 rounded-sm bg-canvas-inset ${badgeWidth}`} /> : null}
        {metaWidth ? <div className={`h-2.5 shrink-0 rounded-full bg-canvas-inset ${metaWidth}`} /> : null}
      </div>
    </div>
  );
}

/** Shared L1/L2 row shell — same icon size and padding so stages and todos read as one list. */
function PlanRow({
  status,
  title,
  meta,
  badges,
  notes,
  noteLimit = 150,
  interactive,
  ariaExpanded,
  onClick,
}: {
  status: ReturnType<typeof normalizeTodoStatus>;
  title: string;
  meta?: string;
  badges?: ReactNode;
  notes?: string | null;
  noteLimit?: number;
  interactive?: boolean;
  ariaExpanded?: boolean;
  onClick?: () => void;
}) {
  const Icon = todoStatusIcon(status);
  const body = (
    <>
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${todoStatusIconClass(status)}`} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <p className={`min-w-0 break-words text-sm font-medium [overflow-wrap:anywhere] ${todoTitleClass(status)}`}>
            {title}
          </p>
          {badges}
          {meta ? <span className="shrink-0 font-mono text-[10px] text-ink-muted">{meta}</span> : null}
        </div>
        {notes ? (
          <p
            className="mt-0.5 break-words text-xs text-ink-muted [overflow-wrap:anywhere] whitespace-pre-wrap"
            title={String(notes)}
          >
            {clip(notes, noteLimit)}
          </p>
        ) : null}
      </div>
    </>
  );
  if (interactive) {
    return (
      <button
        type="button"
        className={`${PLAN_ROW_CLASS} w-full text-left hover:bg-canvas-inset`}
        onClick={onClick}
        aria-expanded={ariaExpanded}
      >
        {body}
      </button>
    );
  }
  return <div className={`${PLAN_ROW_CLASS} hover:bg-canvas-inset`}>{body}</div>;
}

function StrixTodoItem({ item, agents }: { item: PlanNode; agents?: StrixAgentStatus[] }) {
  const status = normalizeTodoStatus(item.status);
  const isWorker = String(item.kind || "") === "worker" || String(item.source || "") === "worker";
  const workerBadge = isWorker ? workerOutcomeBadge(item) : null;
  const ownerLabel = String(item.owner_expert_name || "").trim();
  // Spec #301: owner_agent_name first; fall back agent_id → panel Worker name.
  const agentLabel = resolveTasksAgentChip(item, agents);
  const isFollowUp =
    String(item.source || "") === "worker" &&
    (/^follow-up\b/i.test(String(item.title || "")) || String(item.node_id || item.id || "").startsWith("plan-followup-"));
  // Show more of adjustment advice on failed follow-ups.
  const noteLimit = isFollowUp && (status === "failed" || workerBadge?.label === "failed") ? 320 : 150;
  // Agent sometimes bakes status into content ("…（已完成）"); strip for display — icon is SOT.
  const displayTitle = displayTodoTitle(String(item.title || "Untitled task"));
  const badges = (
    <>
      {ownerLabel && (
        <span
          className="shrink-0 rounded-sm bg-canvas-inset px-1.5 py-0.5 text-[10px] font-medium text-ink-secondary"
          title={`Owner: ${ownerLabel}`}
        >
          {ownerLabel}
        </span>
      )}
      {agentLabel && (
        <span
          className="shrink-0 rounded-sm bg-status-running/10 px-1.5 py-0.5 text-[10px] font-medium text-status-running"
          title={`Agent: ${agentLabel}`}
        >
          {agentLabel}
        </span>
      )}
      {workerBadge && (
        <span className={`shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase ${workerBadge.className}`}>
          {workerBadge.label}
        </span>
      )}
    </>
  );
  return (
    <PlanRow
      status={status}
      title={displayTitle}
      badges={badges}
      notes={item.notes}
      noteLimit={noteLimit}
    />
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

function isTerminalPlanStatus(status: PlanStatus | undefined): boolean {
  return status === "done" || status === "blocked" || status === "failed" || status === "skipped" || status === "completed";
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

function planNodeKey(node: PlanNode, index: number) {
  return String(node.node_id || node.id || `plan-node-${index}`);
}

function clip(value: string, limit: number): string {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}...` : normalized;
}
