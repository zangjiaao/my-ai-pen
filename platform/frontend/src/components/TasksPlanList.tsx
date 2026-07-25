import { CheckCircle2, Circle, CircleDashed, XCircle } from "lucide-react";

type PlanStatus = "todo" | "pending" | "running" | "done" | "skipped" | "blocked" | "failed" | string;

/** Plan / work-item node shown in the Tasks todo list (Expert Graph or flat Strix plan). */
export type PlanNode = {
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
  /** Case multi-role: which product expert owns this todo. */
  owner_expert_id?: string;
  owner_expert_name?: string;
  /** Agent Graph worker display label (Tasks chip). */
  owner_agent_name?: string;
};

export type GraphAwareTodoListProps = {
  planTree: PlanNode[];
  workItems: PlanNode[];
  running?: boolean;
};

/**
 * Expert Graph: L1 phase nodes as section headers, L2 work items nested.
 * Free / flat plans: fall back to flat StrixTodoList.
 *
 * If L1 phases were stripped by a bad snapshot but L2 still parents to
 * graph-stage-*, synthesize stage headers from those parent_ids.
 */
export function GraphAwareTodoList({
  planTree,
  workItems,
  running,
}: GraphAwareTodoListProps) {
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
    return <StrixTodoList items={workItems} running={running} />;
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
  return (
    <div className="space-y-3" data-testid="graph-todo-list">
      {phases.map((phase, index) => {
        const id = String(phase.node_id || phase.id || index);
        const children = byParent.get(id) || [];
        const status = normalizeTodoStatus(phase.status);
        const Icon = todoStatusIcon(status);
        return (
          <div key={id} className="space-y-1">
            <div className="flex min-w-0 items-center gap-2 px-1">
              <Icon className={`h-3.5 w-3.5 shrink-0 ${todoStatusIconClass(status)}`} />
              <p className={`min-w-0 break-words text-xs font-semibold uppercase tracking-wide text-ink-secondary ${todoTitleClass(status)}`}>
                {String(phase.title || id.replace(/^graph-stage-/, "") || id)}
              </p>
              <span className="font-mono text-[10px] text-ink-muted">
                {children.filter((c) => isTerminalPlanStatus(c.status)).length}/{children.length || 0}
              </span>
            </div>
            {children.length > 0 ? (
              <div className="ml-1 border-l border-hairline-soft pl-1">
                <StrixTodoList items={children} running={running} />
              </div>
            ) : (
              <p className="ml-5 text-[11px] text-ink-muted">No stage todos yet</p>
            )}
          </div>
        );
      })}
      {orphan.length > 0 && (
        <div className="space-y-1">
          <p className="px-1 text-[10px] font-semibold uppercase text-ink-muted">Other</p>
          <StrixTodoList items={orphan} running={running} />
        </div>
      )}
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
  const ownerLabel = String(item.owner_expert_name || "").trim();
  const agentLabel =
    String(item.owner_agent_name || "").trim() ||
    (String(item.agent_id || item.linked_agent_id || "").trim()
      ? String(item.agent_id || item.linked_agent_id).slice(0, 16)
      : "");
  const isFollowUp =
    String(item.source || "") === "worker" &&
    (/^follow-up\b/i.test(String(item.title || "")) || String(item.node_id || item.id || "").startsWith("plan-followup-"));
  // Show more of adjustment advice on failed follow-ups.
  const noteLimit = isFollowUp && (status === "failed" || workerBadge?.label === "failed") ? 320 : 150;
  // Agent sometimes bakes status into content ("…（已完成）"); strip for display — icon is SOT.
  const displayTitle = displayTodoTitle(String(item.title || "Untitled task"));
  return (
    <div className="flex min-w-0 items-start gap-2 rounded-md px-2 py-2 hover:bg-canvas-inset">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${todoStatusIconClass(status)}`} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <p className={`min-w-0 break-words text-sm font-medium [overflow-wrap:anywhere] ${todoTitleClass(status)}`}>{displayTitle}</p>
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

function isTerminalPlanStatus(status: PlanStatus | undefined): boolean {
  return status === "done" || status === "blocked" || status === "failed" || status === "skipped";
}

/**
 * Strip agent-baked status suffixes from todo content for display.
 * Status lives on the plan node / icon — not inside the title string.
 */
function displayTodoTitle(title: string): string {
  let t = String(title || "").trim();
  if (!t) return "Untitled task";
  // Full-width / half-width parentheses: （已完成） (已完成) [done] etc.
  t = t.replace(
    /\s*[（(]\s*(已完成|已发现|完成|已跳过|已放弃|完成了|done|completed|found|skipped|abandoned)\s*[）)]\s*$/i,
    "",
  );
  t = t.replace(/\s*[-–—]\s*(已完成|已发现|done|completed)\s*$/i, "");
  return t.trim() || String(title || "").trim() || "Untitled task";
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
