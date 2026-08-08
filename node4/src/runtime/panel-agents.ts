/**
 * Lightweight main + subagent roster for platform right-panel collaboration tree
 * (checkpoint.panel_agents / Node2-compatible shape).
 *
 * current_detail is user-facing (what the agent is doing now).
 * current_action / agent_phase stay machine-readable for filters.
 */

export type PanelAgentRecord = {
  id: string;
  name: string;
  status: string;
  parent_id: string | null;
  task: string;
  skills: string[];
  pending_count: number;
  role: string;
  current_tool?: string;
  /** Machine phase: tool_running | llm_waiting | chat | starting | … */
  current_action?: string;
  /** Human-readable activity for the right panel (preferred by UI). */
  current_detail?: string;
  last_tool?: string;
  outcome?: string;
  error?: string;
  goal_id?: string;
  /** Spec #278: Session actual harness (Free vs Graph) on main row. */
  work_mode?: "free" | "graph";
  graph_id?: string;
  graph_label?: string;
  /**
   * pi-agent-core Agent.sessionId on Main only — collab copy chrome.
   * Not expert catalog id.
   */
  session_id?: string;
};

/** Map tool names → short Chinese labels (product UI language). */
export function humanizeToolName(tool: string): string {
  const t = String(tool || "").trim();
  if (!t) return "工具";
  const map: Record<string, string> = {
    platform_list_assets: "查询资产台账",
    platform_get_asset: "读取资产详情",
    platform_list_vulnerabilities: "查询漏洞台账",
    platform_list_experts: "查询可用专家",
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

export function describeMainActivity(input: {
  phase: string;
  tool?: string;
  lastTool?: string;
}): string {
  const phase = String(input.phase || "").trim() || "running";
  const tool = String(input.tool || "").trim();
  const last = String(input.lastTool || "").trim();

  if (phase === "tool_running" && tool) {
    return `正在${humanizeToolName(tool)}`;
  }
  if (phase === "tool_running") return "正在执行工具";

  if (phase === "llm_waiting" || phase === "model_turn") {
    if (last) return `分析「${humanizeToolName(last)}」结果，规划下一步`;
    return "等待模型思考与回复";
  }

  // Spec #353: Runtime-authored stall phase (not #276 pending reseed; not free-text NLP).
  if (phase === "llm_stalled") {
    return "模型流无进度，仍在等待";
  }

  if (phase === "chat") return "对话中，准备回复";
  if (phase === "starting") return "任务启动中";
  if (phase === "running") return "工作进行中";
  if (phase === "continue") return "继续推进任务";
  if (phase === "goal_budget_limit") return "目标预算受限，收尾中";
  if (phase === "finished" || phase === "completed") return "本轮工作已结束";
  if (phase === "aborted" || phase === "stopped") return "任务已中止";

  if (tool) return `正在${humanizeToolName(tool)}`;
  return phase.replace(/_/g, " ");
}

export class PanelAgentTracker {
  private readonly children = new Map<string, PanelAgentRecord>();
  /** Stable Worker 1..N index per subagent id (resume keeps the same number). */
  private readonly workerIndexById = new Map<string, number>();
  private workerSeq = 0;
  private mainTask: string;
  private mainName: string;
  private mainStatus = "running";
  private activeTool = "";
  private lastTool = "";
  private phase = "starting";
  private detail = "";
  /** Spec #278 S4: actual Session harness for AgentRow badge. */
  private workMode: "free" | "graph" = "free";
  private graphId = "";
  private graphLabel = "";
  /** pi-agent-core Agent.sessionId for collab copy chrome. */
  private agentSessionId = "";

  constructor(mainTask: string, mainName?: string) {
    this.mainTask = (mainTask || "Authorized security task").slice(0, 240);
    this.mainName = (mainName || "Expert").trim().slice(0, 64) || "Expert";
    this.detail = describeMainActivity({ phase: this.phase });
  }

  /** Bind pi-agent-core Agent.sessionId onto Main panel rows (collab copy). */
  setAgentSessionId(sessionId: string | null | undefined): void {
    this.agentSessionId = String(sessionId || "").trim().slice(0, 128);
  }

  /** Set actual Free/Graph harness for collaboration tree main row. */
  setWorkMode(input: {
    work_mode?: "free" | "graph" | string | null;
    graph_id?: string | null;
    graph_label?: string | null;
  }): void {
    const mode = String(input.work_mode || "").trim().toLowerCase();
    if (mode === "graph") {
      this.workMode = "graph";
      this.graphId = String(input.graph_id || "").trim().slice(0, 64);
      this.graphLabel = String(input.graph_label || "").trim().slice(0, 48);
    } else if (mode === "free" || mode === "") {
      this.workMode = "free";
      this.graphId = "";
      this.graphLabel = "";
    }
  }

  /** 1-based Worker index for a subagent id (assigns on first see). */
  workerIndexFor(id: string): number {
    const key = String(id || "").trim();
    if (!key) return ++this.workerSeq;
    const existing = this.workerIndexById.get(key);
    if (existing) return existing;
    const n = ++this.workerSeq;
    this.workerIndexById.set(key, n);
    return n;
  }

  /** @deprecated prefer setMainActivity */
  setMainPhase(phase: string, activeTool?: string): void {
    this.setMainActivity({
      phase,
      tool: activeTool !== undefined ? activeTool : undefined,
    });
  }

  setMainActivity(input: {
    phase: string;
    /** Active tool name; pass "" to clear, omit to keep. */
    tool?: string | null;
    /** Override auto-generated human detail. */
    detail?: string;
  }): void {
    this.phase = String(input.phase || this.phase || "running");
    if (input.tool !== undefined && input.tool !== null) {
      const t = String(input.tool).trim();
      this.activeTool = t;
      if (t) this.lastTool = t;
    }
    this.detail =
      input.detail !== undefined
        ? String(input.detail).trim().slice(0, 160)
        : describeMainActivity({
            phase: this.phase,
            tool: this.activeTool,
            lastTool: this.lastTool,
          });
  }

  setMainTerminal(status: "completed" | "failed" | "aborted"): void {
    this.mainStatus = status === "aborted" ? "stopped" : status;
    this.activeTool = "";
    this.phase = status === "completed" ? "finished" : status;
    this.detail = describeMainActivity({
      phase: this.phase,
      lastTool: this.lastTool,
    });
  }

  /**
   * Parked continue reuses the same PanelAgentTracker. Prior setMainTerminal left
   * mainStatus=stopped while current_action still updates — AgentRow shows STOP
   * during live work. Clear terminal state when attaching a continue burst.
   */
  resetMainForContinue(input?: { phase?: string; task?: string }): void {
    this.mainStatus = "running";
    this.phase = String(input?.phase || "starting").trim() || "starting";
    const task = String(input?.task || "").trim();
    if (task) this.mainTask = task.slice(0, 240);
    this.activeTool = "";
    this.detail = describeMainActivity({
      phase: this.phase,
      lastTool: this.lastTool,
    });
  }

  noteSubagentStart(input: {
    id: string;
    assignment: string;
    goalId?: string;
    nodeType?: string;
    /** Short purpose label (this_turn_goal); preferred over raw package markdown. */
    label?: string;
    skillId?: string;
  }): void {
    const node = String(input.nodeType || input.skillId || "").trim();
    const goal = resolveSubagentGoal(input.label, input.assignment);
    const workerN = this.workerIndexFor(input.id);
    const name = formatWorkerName(workerN);
    this.children.set(input.id, {
      id: input.id,
      name,
      status: "running",
      parent_id: "node4-main",
      task: goal.slice(0, 240),
      skills: node ? [node] : [],
      pending_count: 0,
      role: "subagent",
      current_action: "running",
      current_detail: goal.slice(0, 160),
      goal_id: input.goalId,
    });
  }

  noteSubagentEnd(input: { id: string; ok: boolean; summary?: string }): void {
    const prev = this.children.get(input.id);
    const status = input.ok ? "completed" : "failed";
    const task = prev?.task || "";
    const workerN = this.workerIndexFor(input.id);
    const doneDetail = input.ok
      ? task
        ? `已完成：${task}`.slice(0, 160)
        : "子任务已完成"
      : (input.summary || "子任务失败").slice(0, 160);
    this.children.set(input.id, {
      id: input.id,
      name: prev?.name || formatWorkerName(workerN),
      status,
      parent_id: "node4-main",
      task,
      skills: prev?.skills || [],
      pending_count: 0,
      role: "subagent",
      current_action: status,
      current_detail: doneDetail,
      outcome: status,
      error: input.ok ? undefined : (input.summary || "failed").slice(0, 240),
      goal_id: prev?.goal_id,
    });
  }

  list(options?: { terminal?: boolean }): PanelAgentRecord[] {
    const mainStatus = options?.terminal
      ? this.mainStatus === "running"
        ? "completed"
        : this.mainStatus
      : this.mainStatus;
    const phase = options?.terminal && mainStatus === "completed" ? "finished" : this.phase;
    let detail =
      options?.terminal && mainStatus === "completed"
        ? "本轮工作已结束"
        : this.detail || describeMainActivity({ phase, tool: this.activeTool, lastTool: this.lastTool });
    // Any running Worker under Main → fan-out subtitle (structured child count, not detail regex).
    const runningWorkers = [...this.children.values()].filter((c) => c.status === "running").length;
    if (!options?.terminal && mainStatus === "running" && runningWorkers > 0) {
      detail = runningWorkers === 1 ? "并行 1 个 Worker" : `并行 ${runningWorkers} 个 Worker`;
    }
    const main: PanelAgentRecord = {
      id: "node4-main",
      name: this.mainName,
      status: mainStatus,
      parent_id: null,
      task: this.mainTask,
      skills: [],
      pending_count: 0,
      role: "main",
      current_tool: this.activeTool,
      current_action: phase,
      current_detail: detail,
      last_tool: this.lastTool || undefined,
      work_mode: this.workMode,
      graph_id: this.graphId || undefined,
      graph_label: this.graphLabel || undefined,
      ...(this.agentSessionId ? { session_id: this.agentSessionId } : {}),
    };
    return [main, ...this.children.values()];
  }
}

/** Short AgentRow badge label from Session actual mode (Spec #278 S4 pure helper). */
export function formatWorkModeBadge(input: {
  work_mode?: string | null;
  graph_id?: string | null;
  graph_label?: string | null;
  /** Prefer pack Graph `short_label` when stamped on the agent row. */
  short_label?: string | null;
}): string {
  const mode = String(input.work_mode || "").trim().toLowerCase();
  if (mode === "graph") {
    const short = String(input.short_label || "").trim();
    if (short) return short.length > 12 ? `${short.slice(0, 11)}…` : short;
    const label = String(input.graph_label || "").trim();
    if (label) return shortGraphLabel(label);
    const gid = String(input.graph_id || "").trim().toLowerCase();
    // Fallbacks must match experts/pentest/graphs/hard/*.json short_label.
    if (gid === "app_assessment") return "应用评估";
    if (gid === "redteam_deep") return "红队深度";
    if (gid) return shortGraphLabel(gid);
    return "Graph";
  }
  return "Free";
}

function shortGraphLabel(raw: string): string {
  const t = raw.replace(/\s+/g, " ").trim();
  // Prefer short Chinese product labels when long Hard Graph titles are used.
  if (/应用/.test(t) && /评估|安全/.test(t)) return "应用评估";
  if (/红队/.test(t)) return "红队深度";
  return t.length > 12 ? `${t.slice(0, 11)}…` : t;
}

/** Prefer explicit label, else parse handoff package "## This-turn goal", else first prose line. */
export function resolveSubagentGoal(label?: string, assignment?: string): string {
  const fromLabel = String(label || "").replace(/\s+/g, " ").trim();
  if (fromLabel && !looksLikeHandoffPackage(fromLabel) && !looksLikeSubagentId(fromLabel)) {
    return clipGoal(fromLabel);
  }
  const raw = String(assignment || "");
  const section = raw.match(/##\s*This-turn goal[^\n]*\n+([\s\S]*?)(?=\n##\s|\n*$)/i);
  if (section?.[1]) {
    const goal = section[1].replace(/\s+/g, " ").trim();
    if (goal) return clipGoal(goal);
  }
  // Drop markdown headers / id noise; take first substantial line.
  for (const line of raw.split(/\r?\n/)) {
    const t = line.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim();
    if (!t || looksLikeHandoffPackage(t) || /^target\b|^scope\b/i.test(t) || looksLikeSubagentId(t)) {
      continue;
    }
    if (t.length >= 8) return clipGoal(t);
  }
  return "子代理执行中";
}

/** Stable display name for collaboration tree / Tasks chip. */
export function formatWorkerName(index: number): string {
  const n = Number(index);
  if (!Number.isFinite(n) || n < 1) return "Worker";
  return `Worker ${Math.floor(n)}`;
}

function clipGoal(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 120 ? `${t.slice(0, 117)}…` : t;
}

function looksLikeHandoffPackage(s: string): boolean {
  return /subagent handoff package/i.test(s) || /^#\s*subagent/i.test(s);
}

function looksLikeSubagentId(s: string): boolean {
  return /^sub[_-]?\d/i.test(s.trim()) || /^subagent\s+sub_/i.test(s.trim());
}
