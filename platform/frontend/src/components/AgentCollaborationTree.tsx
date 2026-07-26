/**
 * Status tab collaboration tree (Main + Workers).
 * Extracted from RightPanel so presentation logic stays scannable.
 */
import { useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Bot, GitBranch, Tag } from "lucide-react";
import {
  agentDisplayName,
  agentPurposeLine,
  looksLikeHandoffPackage,
} from "../lib/workerPresentation";
import type { StrixAgentStatus } from "../lib/panelTypes";

export type { StrixAgentStatus } from "../lib/panelTypes";

export function StrixAgentList({ agents }: { agents: StrixAgentStatus[] }) {
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
            workerOrdinal={workerOrdinalById.get(agent.id)}
            onToggle={canToggle ? () => setExpanded((current) => ({ ...current, [agent.id]: !open })) : undefined}
          />
        </div>
        {children.length > 0 && (
          /* pl-[18px]: child elbow vertical (-left-1.5) near parent spine at left-3. */
          <div className={`${open ? "block" : "hidden"} space-y-0 pl-[18px]`}>
            {children.map((child, index) =>
              renderAgentNode(child, false, nextTrail, index === children.length - 1),
            )}
          </div>
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
  workerOrdinal,
  onToggle,
}: {
  agent: StrixAgentStatus;
  primary?: boolean;
  secondary?: boolean;
  childCount?: number;
  expanded?: boolean;
  workerOrdinal?: number;
  onToggle?: () => void;
}) {
  const summary = summarizeAgentAction(agent);
  const displayName = agentDisplayName(agent, workerOrdinal);
  const status = agentStatusLabel(agent.status);
  const rowInteractive = Boolean(onToggle);
  const handleRowKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!rowInteractive) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onToggle?.();
  };
  const highlighted = Boolean(agent.highlighted) && primary;
  // Same vertical pad for Main/Sub so status-dot centers share one light column with spine/elbows.
  const padY = "py-[5px]";
  // Sub: skill chips sit beside the title; Main keeps them in AgentMeta below.
  const titleSkills =
    secondary && Array.isArray(agent.skills) ? agent.skills.slice(0, 5) : [];
  return (
    <div
      className={`min-w-0 rounded-md ${padY} pr-2 pl-[9px] ${highlighted ? "bg-status-running/8 ring-1 ring-status-running/25" : "bg-transparent"} ${rowInteractive ? "cursor-pointer hover:bg-canvas-inset focus-visible:outline focus-visible:outline-2 focus-visible:outline-status-running/40" : "hover:bg-canvas-inset"}`}
      onClick={rowInteractive ? onToggle : undefined}
      onKeyDown={handleRowKeyDown}
      role={rowInteractive ? "button" : undefined}
      tabIndex={rowInteractive ? 0 : undefined}
      aria-expanded={rowInteractive ? expanded : undefined}
      data-highlighted={highlighted ? "true" : undefined}
      data-expert-id={agent.expert_id || undefined}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span
          aria-hidden="true"
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${agentStatusDotClass(agent.status)}`}
          title={agentStatusLabel(agent.status)}
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <AgentRoleBadge primary={primary} />
                <p className="min-w-0 truncate text-sm font-medium" title={displayName}>
                  {displayName}
                </p>
                {titleSkills.map((skill) => (
                  <AgentSkillBadge key={skill} skill={skill} />
                ))}
                {highlighted && (
                  <span className="shrink-0 rounded-sm bg-status-running/15 px-1.5 py-0.5 text-[10px] font-medium text-status-running">
                    active
                  </span>
                )}
              </div>
              <p
                className={`${secondary ? "mt-0" : "mt-0.5"} min-w-0 truncate text-xs text-ink-secondary`}
                title={summary}
              >
                {summary}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {childCount > 0 && (
                <span className="font-mono text-[10px] text-ink-muted" title={`${childCount} sub-agents`}>
                  {childCount}
                </span>
              )}
              <span className={`rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase ${agentStatusBadgeClass(agent.status)}`}>
                {status}
              </span>
            </div>
          </div>
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
  return [...agents].sort(
    (left, right) =>
      depth(left) - depth(right) ||
      String(left.parent_id || "").localeCompare(String(right.parent_id || "")) ||
      left.name.localeCompare(right.name),
  );
}

export function agentStatusCount(agents: StrixAgentStatus[]): string {
  const active = agents.filter((agent) => isActiveAgentStatus(agent.status)).length;
  return `${active}/${agents.length} active`;
}

function isActiveAgentStatus(status: string | undefined): boolean {
  return ["running", "waiting", "pending"].includes(String(status || "").toLowerCase());
}

function agentStatusLabel(status: string | undefined): string {
  // Case Main roots often arrive as "idle"; treat idle/empty as done (green), same as Sub completed.
  const normalized = String(status ?? "")
    .trim()
    .toLowerCase() || "done";
  if (normalized === "completed" || normalized === "idle" || normalized === "finished" || normalized === "success") {
    return "done";
  }
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
  if (
    normalized === "running" ||
    normalized === "tool_running" ||
    normalized === "llm_waiting" ||
    normalized === "working" ||
    normalized === "chat" ||
    normalized === "starting"
  ) {
    return "animate-pulse bg-status-running";
  }
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

export function summarizeAgentAction(agent: StrixAgentStatus): string {
  const status = agentStatusLabel(agent.status);
  const isSub = String(agent.role || "").toLowerCase() === "subagent";
  const purpose = agentPurposeLine(agent);

  if (status === "timeout") return "超时结束";
  if (status === "failed") {
    if (purpose && !/^子任务失败$/i.test(purpose)) return clip(purpose, 120);
    return "执行失败";
  }
  if (status === "aborted" || status === "stopped") return "已中止";

  const detail = String(agent.current_detail || "").trim();
  if (
    detail &&
    !isOpaquePhaseToken(detail) &&
    !looksLikeHandoffPackage(detail) &&
    !/^子任务已完成$/.test(detail)
  ) {
    return clip(detail, 120);
  }

  const tool = String(agent.current_tool || "").trim();
  const lastTool = String(agent.last_tool || "").trim();
  const action = String(agent.current_action || "").trim();

  if (action === "tool_running" || tool) {
    if (!isSub && /并行\s+\d+\s+个\s*Worker/i.test(detail)) return clip(detail, 120);
    return `正在${friendlyToolLabel(tool || "tool")}`;
  }
  if (action === "llm_waiting" || action === "model_turn") {
    if (lastTool) return `分析「${friendlyToolLabel(lastTool)}」结果，规划下一步`;
    return "等待模型思考与回复";
  }
  if (action === "chat") return "对话中，准备回复";
  if (action === "starting") return "任务启动中";
  if (action === "running") {
    if (isSub && purpose) return clip(purpose, 120);
    if (!isSub && /并行\s+\d+\s+个\s*Worker/i.test(detail)) return clip(detail, 120);
    return "工作进行中";
  }
  if (action === "continue") return "继续推进任务";
  if (action === "finished" || action === "completed" || status === "done") {
    if (isSub && purpose) {
      return purpose.startsWith("已完成") ? clip(purpose, 120) : clip(`已完成：${purpose}`, 120);
    }
    return "本轮工作已结束";
  }
  if (action && !isOpaquePhaseToken(action) && !["done", "timeout", "failed"].includes(action)) {
    return compactAgentAction(action);
  }
  if (purpose) return clip(purpose, 90);
  return "等待工作";
}

function isOpaquePhaseToken(value: string): boolean {
  return /^(tool_running|llm_waiting|model_turn|starting|running|continue|finished|completed|chat|working|done)$/i.test(
    value.trim().toLowerCase(),
  );
}

function compactAgentAction(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (/^running command:/i.test(text)) return "正在执行命令";
  if (/^creating sub-agent:/i.test(text)) return text.replace(/^creating sub-agent:/i, "委派子代理").trim();
  if (/^reporting finding:/i.test(text)) return text.replace(/^reporting finding:/i, "登记发现").trim();
  return clip(text, 90);
}

export function friendlyToolLabel(tool: string): string {
  const t = String(tool || "").trim();
  if (!t) return "工具";
  const map: Record<string, string> = {
    platform_list_assets: "查询资产台账",
    platform_get_asset: "读取资产详情",
    platform_list_vulnerabilities: "查询漏洞台账",
    platform_get_vulnerability: "读取漏洞详情",
    platform_update_finding_status: "更新漏洞状态",
    platform_enrich_asset: "补充资产信息",
    platform_conversation_snapshot: "读取会话快照",
    platform_list_reports: "查询报告列表",
    platform_create_report: "生成交付报告",
    request_user_decision: "请求用户授权",
    shell: "执行命令",
    http: "HTTP 探测",
    session: "会话化 HTTP",
    browser: "浏览器探测",
    script: "运行脚本",
    write: "写入文件",
    edit: "编辑文件",
    read: "读取文件",
    finding: "登记发现/漏洞",
    fact: "记录过程事实",
    todo: "更新任务清单",
    skill: "加载技能",
    subagent: "启动子代理",
    goal: "更新目标",
    captcha: "处理验证码",
  };
  if (map[t]) return map[t];
  if (t.startsWith("platform_")) return `平台：${t.replace(/^platform_/, "").replace(/_/g, " ")}`;
  return t.replace(/_/g, " ");
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

function clip(value: string, limit: number): string {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}
