/**
 * Status tab collaboration tree (Main + Workers).
 * Extracted from RightPanel so presentation logic stays scannable.
 */
import {
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Bot, Check, Copy, GitBranch, RotateCcw, Tag, Trash2 } from "lucide-react";
import {
  agentDisplayName,
  compareAgentNames,
} from "../lib/workerPresentation";
import type { StrixAgentStatus } from "../lib/panelTypes";
import { formatAgentWorkModeBadge } from "../lib/panelAgentsState";
import { formatAgentUsageLine } from "../lib/caseMetering";
import {
  packageStatusDotClass,
  packageStatusTitle,
  resolvePackageLightStatus,
} from "../lib/packageStatusLight";
import { friendlyToolLabel } from "../lib/toolLabels";

export type { StrixAgentStatus } from "../lib/panelTypes";
/** Re-export for callers that imported labels from this module. */
export { friendlyToolLabel };

/** Spec #354: Session lifecycle on Main cards only. */

/** True when this Main is the current Task package expert (package light applies). */
function isPackageExpert(
  agent: StrixAgentStatus,
  packageExpertId?: string | null,
): boolean {
  const want = String(packageExpertId || "").trim();
  if (!want) {
    // No task expert: only highlighted Main (single-speaker) follows package light.
    return Boolean(agent.highlighted);
  }
  return String(agent.expert_id || "").trim() === want;
}

export type SessionLifecycleHandlers = {
  onRequestReset?: (agent: StrixAgentStatus) => void;
  onRequestDelete?: (agent: StrixAgentStatus) => void;
  /** Spec #354 L12 / #491: End Worker (dispose idle/live child; not Session Delete). */
  onRequestEndWorker?: (agent: StrixAgentStatus) => void;
  busy?: boolean;
};

const AGENT_LIST_CLASS = "space-y-1";
const AGENT_CHILDREN_CLASS = "mt-1 space-y-1 pl-[18px]";
const AGENT_ROW_CLASS = "min-w-0 rounded-md py-[5px] pr-2 pl-[9px]";

export function StrixAgentList({
  agents,
  onWorkerClick,
  sessionLifecycle,
  packageStatus,
  packageWorking,
  packageExpertId,
}: {
  agents: StrixAgentStatus[];
  /** Spec #308: open Worker audit dialog (Workers only; not Main). */
  onWorkerClick?: (agent: StrixAgentStatus, workerOrdinal?: number) => void;
  /** Spec #354 S3: Reset / Delete Session on Main cards (confirm lives in parent). */
  sessionLifecycle?: SessionLifecycleHandlers;
  /**
   * Spec #354 S2: Task package status light — only for the Main of this expert_id
   * (current Task speaker). Peer experts keep their own status.
   */
  packageStatus?: string | null;
  packageWorking?: boolean;
  packageExpertId?: string | null;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const roots = agents.filter((agent) => !agent.parent_id);
  const rootAgents = roots.length ? roots : agents.slice(0, 1);
  const childrenByParent = new Map<string, StrixAgentStatus[]>();
  const rootIds = new Set(rootAgents.map((agent) => agent.id));
  for (const agent of agents) {
    if (rootIds.has(agent.id)) continue;
    const parentId =
      agent.parent_id && agents.some((candidate) => candidate.id === agent.parent_id)
        ? agent.parent_id
        : rootAgents[0]?.id || "";
    if (!parentId) continue;
    childrenByParent.set(parentId, [...(childrenByParent.get(parentId) || []), agent]);
  }
  // Only parse ordinal from clean "Worker N" names — never invent from sibling index.
  const workerOrdinalById = new Map<string, number>();
  for (const kids of childrenByParent.values()) {
    for (const child of kids) {
      const fromName = String(child.name || "").match(/^Worker\s+(\d+)\s*$/i);
      if (fromName) workerOrdinalById.set(child.id, Number(fromName[1]));
    }
  }

  const renderAgentNode = (
    agent: StrixAgentStatus,
    primary = false,
    trail: string[] = [],
    lastSibling = true,
  ): ReactNode => {
    const children = childrenByParent.get(agent.id) || [];
    const open = expanded[agent.id] ?? true;
    const canToggle = children.length > 0;
    const nextTrail = [...trail, agent.id];
    const hasVisibleChildren = children.length > 0 && open;
    if (trail.includes(agent.id)) return null;
    const isWorker =
      !primary &&
      (String(agent.role || "").toLowerCase() === "subagent" || Boolean(agent.parent_id));
    const workerOrdinal = workerOrdinalById.get(agent.id);
    return (
      <div key={agent.id} className="relative min-w-0">
        {!primary && (
          <>
            <svg
              aria-hidden="true"
              viewBox="0 0 26 22"
              className="pointer-events-none absolute -left-1.5 top-0 h-[22px] w-[26px] text-hairline"
              fill="none"
            >
              <path d="M0 0 V10 Q0 16 6 16 H16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            {!lastSibling && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute bottom-0 -left-1.5 top-[17px] w-px bg-hairline"
              />
            )}
          </>
        )}
        <div className="relative">
          {/* Spine under status-dot center (pl-[9px] + 8px dot → ≈13px; left-3/12px keeps column). */}
          {hasVisibleChildren && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute bottom-0 left-3 top-[19px] w-px bg-hairline"
            />
          )}
          <AgentRow
            agent={agent}
            primary={primary}
            secondary={!primary}
            childCount={children.length}
            expanded={open}
            workerOrdinal={workerOrdinal}
            onToggle={canToggle ? () => setExpanded((current) => ({ ...current, [agent.id]: !open })) : undefined}
            onWorkerOpen={
              isWorker && onWorkerClick
                ? () => onWorkerClick(agent, workerOrdinal)
                : undefined
            }
            sessionLifecycle={
              primary && String(agent.expert_id || "").trim()
                ? {
                    busy: sessionLifecycle?.busy,
                    onRequestReset: sessionLifecycle?.onRequestReset,
                    onRequestDelete: sessionLifecycle?.onRequestDelete,
                  }
                : !primary && sessionLifecycle?.onRequestEndWorker
                  ? {
                      busy: sessionLifecycle?.busy,
                      onRequestEndWorker: sessionLifecycle.onRequestEndWorker,
                    }
                  : undefined
            }
            packageStatus={
              primary && isPackageExpert(agent, packageExpertId) ? packageStatus : undefined
            }
            packageWorking={
              primary && isPackageExpert(agent, packageExpertId) ? packageWorking : undefined
            }
          />
        </div>
        {children.length > 0 && (
          /* pl-[18px]: child elbow vertical (-left-1.5) near parent spine at left-3.
           * mt-1 + space-y-1: breathing room so Sub hover does not cover Main bottom edge. */
          <div className={`${open ? "block" : "hidden"} ${AGENT_CHILDREN_CLASS}`}>
            {children.map((child, index) =>
              renderAgentNode(child, false, nextTrail, index === children.length - 1),
            )}
          </div>
        )}
      </div>
    );
  };
  return (
    <div className={AGENT_LIST_CLASS} data-testid="strix-agent-status">
      {rootAgents.map((agent) => renderAgentNode(agent, true))}
    </div>
  );
}

export function StrixAgentListSkeleton() {
  return (
    <div aria-hidden="true" className={AGENT_LIST_CLASS} data-testid="strix-agent-status-skeleton">
      <div className="relative min-w-0">
        <div className="relative">
          <span className="pointer-events-none absolute bottom-0 left-3 top-[19px] w-px bg-hairline" />
          <AgentRowSkeleton primary />
        </div>
        <div className={AGENT_CHILDREN_CLASS}>
          <div className="relative min-w-0">
            <svg
              viewBox="0 0 26 22"
              className="pointer-events-none absolute -left-1.5 top-0 h-[22px] w-[26px] text-hairline"
              fill="none"
            >
              <path d="M0 0 V10 Q0 16 6 16 H16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <AgentRowSkeleton />
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentRowSkeleton({ primary = false }: { primary?: boolean }) {
  return (
    <div className={`${AGENT_ROW_CLASS} bg-surface-default`}>
      <div className="flex min-w-0 items-start gap-2">
        <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-canvas-inset" />
        <div className="min-w-0 flex-1">
          <div className="flex h-5 min-w-0 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <div className="h-5 w-5 shrink-0 rounded bg-canvas-inset" />
              <div className={`${primary ? "w-24" : "w-20"} h-3 rounded-full bg-canvas-inset`} />
              <div className="h-4 w-10 shrink-0 rounded-sm bg-canvas-inset" />
            </div>
            {primary ? (
              <div className="flex shrink-0 items-center">
                <div className="h-6 w-6 rounded-md bg-canvas-inset" />
                <div className="h-6 w-6 rounded-md bg-canvas-inset" />
              </div>
            ) : null}
          </div>
          <div className="mt-0.5 flex h-4 min-w-0 items-center justify-between gap-2">
            <div className={`${primary ? "w-32" : "w-24"} h-3 rounded-full bg-canvas-inset`} />
            {primary ? <div className="h-3 w-16 rounded-full bg-canvas-inset" /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentRow({
  agent,
  primary = false,
  secondary = false,
  childCount = 0,
  expanded = false,
  workerOrdinal,
  onToggle,
  onWorkerOpen,
  sessionLifecycle,
  packageStatus,
  packageWorking,
}: {
  agent: StrixAgentStatus;
  primary?: boolean;
  secondary?: boolean;
  childCount?: number;
  expanded?: boolean;
  workerOrdinal?: number;
  onToggle?: () => void;
  /** Spec #308: open audit dialog for Worker rows. */
  onWorkerOpen?: () => void;
  /** Spec #354: Main Session Reset / Delete (parent owns ConfirmDialog). */
  sessionLifecycle?: SessionLifecycleHandlers;
  /** Spec #354 S2: Task package status for Main light (sync Sidebar). */
  packageStatus?: string | null;
  packageWorking?: boolean;
}) {
  // Spec #324 D1: secondary line is model · requests · tokens — not tool/work narration.
  const usageLine = formatAgentUsageLine(agent, { short: secondary });
  const displayName = agentDisplayName(agent, workerOrdinal);
  // Worker open takes precedence for click; expand still via child-count control if needed.
  const rowInteractive = Boolean(onWorkerOpen || onToggle);
  const handleRowActivate = () => {
    if (onWorkerOpen) {
      onWorkerOpen();
      return;
    }
    onToggle?.();
  };
  const handleRowKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!rowInteractive) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handleRowActivate();
  };
  const highlighted = Boolean(agent.highlighted) && primary;
  // Sub: skill chips sit beside the title; Main keeps them in AgentMeta below.
  const titleSkills =
    secondary && Array.isArray(agent.skills) ? agent.skills.slice(0, 5) : [];
  const showSessionActions =
    primary &&
    Boolean(sessionLifecycle?.onRequestReset || sessionLifecycle?.onRequestDelete);
  const showWorkerEnd = Boolean(!primary && sessionLifecycle?.onRequestEndWorker);
  const sessionBusy = Boolean(sessionLifecycle?.busy);
  const [sessionIdCopied, setSessionIdCopied] = useState(false);
  const fullSessionId = sessionIdFull(agent);
  const shortSessionId = sessionIdDisplay(agent);

  const copySessionId = async (e: ReactMouseEvent | ReactKeyboardEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!fullSessionId) return;
    try {
      await navigator.clipboard.writeText(fullSessionId);
      setSessionIdCopied(true);
      window.setTimeout(() => setSessionIdCopied(false), 1400);
    } catch {
      setSessionIdCopied(false);
    }
  };

  return (
    <div
      className={`${AGENT_ROW_CLASS} ${highlighted ? "bg-status-running/8 ring-1 ring-status-running/25" : "bg-surface-default"} ${rowInteractive ? "cursor-pointer hover:bg-canvas-inset focus-visible:outline focus-visible:outline-2 focus-visible:outline-status-running/40" : "hover:bg-canvas-inset"}`}
      onClick={rowInteractive ? handleRowActivate : undefined}
      onKeyDown={handleRowKeyDown}
      role={rowInteractive ? "button" : undefined}
      tabIndex={rowInteractive ? 0 : undefined}
      aria-expanded={onToggle && !onWorkerOpen ? expanded : undefined}
      data-highlighted={highlighted ? "true" : undefined}
      data-expert-id={agent.expert_id || undefined}
      data-worker-audit={onWorkerOpen ? "true" : undefined}
    >
      {/*
        Two rows only:
        [dot] [name · mode]                         [count] [status] [reset] [delete]
              [usage mono]          [copy session id — TopBar-like, no border/bg]
              [meta chips if any]
      */}
      <div className="flex min-w-0 items-start gap-2">
        {(() => {
          // Spec #354 S2: Main uses Case Task package status (same palette as Sidebar).
          // Workers keep agent/panel phase mapping through the same light helper.
          const lightStatus = primary
            ? resolvePackageLightStatus({
                packageStatus,
                agentStatus: agent.status,
                working: packageWorking,
              })
            : resolvePackageLightStatus({ agentStatus: agent.status });
          return (
            <span
              aria-hidden="true"
              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${packageStatusDotClass(lightStatus, primary ? packageWorking : undefined)}`}
              title={packageStatusTitle(lightStatus, primary ? packageWorking : undefined)}
            />
          );
        })()}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <AgentRoleBadge primary={primary} />
              <p className="min-w-0 truncate text-sm font-medium" title={displayName}>
                {displayName}
              </p>
              {primary && (() => {
                const modeBadge = formatAgentWorkModeBadge(agent);
                return modeBadge ? (
                  <span
                    className="shrink-0 rounded-sm bg-canvas-inset px-1.5 py-0.5 text-[10px] font-medium text-ink-secondary"
                    title={
                      agent.work_mode === "graph" || String(agent.work_mode || "").startsWith("hard_graph")
                        ? `Session harness: Graph${agent.graph_id ? ` (${agent.graph_id})` : ""}`
                        : "Session harness: Free"
                    }
                    data-testid="agent-work-mode-badge"
                  >
                    {modeBadge}
                  </span>
                ) : null;
              })()}
              {titleSkills.map((skill) => (
                <AgentSkillBadge key={skill} skill={skill} />
              ))}
            </div>
            <div
              className="flex shrink-0 items-center gap-1"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              {childCount > 0 && (
                <span className="font-mono text-[10px] text-ink-muted" title={`${childCount} sub-agents`}>
                  {childCount}
                </span>
              )}
              {/* Status text badge removed — left status dot already carries runtime (Spec #354 collab chrome). */}
              {showWorkerEnd && (
                <button
                  type="button"
                  data-testid="worker-end-btn"
                  disabled={sessionBusy}
                  title="结束 Worker — 释放其模型会话并从协作树移除（不影响 Main Session）"
                  aria-label="结束 Worker"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-canvas-inset hover:text-severity-critical disabled:opacity-40"
                  onClick={(e) => {
                    e.stopPropagation();
                    sessionLifecycle?.onRequestEndWorker?.(agent);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                </button>
              )}
              {showSessionActions && (
                <div className="flex items-center" data-testid="session-lifecycle-actions">
                  {sessionLifecycle?.onRequestReset && (
                    <button
                      type="button"
                      data-testid="session-reset-btn"
                      disabled={sessionBusy}
                      title="Reset Session — clear model memory, keep incomplete Tasks"
                      aria-label="Reset Session"
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-canvas-inset hover:text-ink disabled:opacity-40"
                      onClick={(e) => {
                        e.stopPropagation();
                        sessionLifecycle.onRequestReset?.(agent);
                      }}
                    >
                      <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </button>
                  )}
                  {sessionLifecycle?.onRequestDelete && (
                    <button
                      type="button"
                      data-testid="session-delete-btn"
                      disabled={sessionBusy}
                      title="Delete Session — hold incomplete Tasks for same-expert handoff"
                      aria-label="Delete Session"
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-canvas-inset hover:text-severity-critical disabled:opacity-40"
                      onClick={(e) => {
                        e.stopPropagation();
                        sessionLifecycle.onRequestDelete?.(agent);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
          {/* Second row: usage left, session id copy right (or full-width usage for Sub). */}
          {(usageLine || (primary && shortSessionId)) && (
            <div className="mt-0.5 flex min-w-0 items-center justify-between gap-2">
              {usageLine ? (
                <p
                  className="min-w-0 flex-1 truncate font-mono text-xs text-ink-secondary"
                  title={usageLine}
                  data-testid={primary ? "agent-usage-line" : "sub-usage-line"}
                >
                  {usageLine}
                </p>
              ) : (
                <span className="min-w-0 flex-1" />
              )}
              {primary && shortSessionId && (
                <button
                  type="button"
                  data-testid="agent-session-id"
                  title={sessionIdCopied ? "Copied" : fullSessionId}
                  className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] text-ink-muted transition-colors hover:text-ink"
                  onClick={(e) => {
                    void copySessionId(e);
                  }}
                >
                  {sessionIdCopied ? (
                    <Check size={12} strokeWidth={1.75} className="shrink-0" />
                  ) : (
                    <Copy size={12} strokeWidth={1.75} className="shrink-0 opacity-70" />
                  )}
                  <span className="min-w-0 truncate">{shortSessionId}</span>
                </button>
              )}
            </div>
          )}
          <AgentMeta agent={agent} primary={primary && !secondary} skillsInTitle={secondary} />
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

/**
 * pi-agent-core Agent.sessionId only (clipboard + tooltip).
 * Never expert catalog id — that is product identity, not the Agent instance.
 */
function sessionIdFull(agent: StrixAgentStatus): string {
  const sid = String(agent.session_id || "").trim();
  if (!sid) return "";
  // Reject expert-catalog / roster keys (historical mis-projection).
  if (sid.startsWith("expert:") || sid.startsWith("pack:")) return "";
  return sid;
}

/** Compact display: first 8 of pi Agent.sessionId. */
function sessionIdDisplay(agent: StrixAgentStatus): string {
  const full = sessionIdFull(agent);
  if (!full) return "";
  return full.slice(0, 8);
}

function AgentMeta({
  agent,
  primary,
  skillsInTitle = false,
}: {
  agent: StrixAgentStatus;
  primary: boolean;
  /** Sub rows render skill chips next to the title; skip them here. */
  skillsInTitle?: boolean;
}) {
  const skills =
    skillsInTitle || !Array.isArray(agent.skills)
      ? []
      : agent.skills.slice(0, primary ? 4 : 5);
  const pendingCount = Number(agent.pending_count || 0);
  if (!skills.length && pendingCount <= 0) return null;
  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {pendingCount > 0 && (
        <span
          className="rounded-sm bg-canvas-inset px-1.5 py-0.5 text-[10px] text-ink-muted"
          title="Queued messages or actions waiting for this agent"
        >
          {pendingCount} queued
        </span>
      )}
      {skills.map((skill) => (
        <AgentSkillBadge key={skill} skill={skill} />
      ))}
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

export function orderStrixAgents(agents: StrixAgentStatus[]): StrixAgentStatus[] {
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
  // Spec #301: numeric Worker N order (1,2,10,11) — not localeCompare lex (1,10,11,2).
  return [...agents].sort(
    (left, right) =>
      depth(left) - depth(right) ||
      String(left.parent_id || "").localeCompare(String(right.parent_id || "")) ||
      compareAgentNames(left.name, right.name),
  );
}

export function agentStatusCount(agents: StrixAgentStatus[]): string {
  const active = agents.filter((agent) => isActiveAgentStatus(agent.status)).length;
  return `${active}/${agents.length} active`;
}

function isActiveAgentStatus(status: string | undefined): boolean {
  return ["running", "waiting", "pending"].includes(String(status || "").toLowerCase());
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
  return explicit[normalized.toLowerCase()] || friendlyToolLabel(normalized);
}
