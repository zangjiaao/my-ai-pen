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
};

/** Map tool names → short Chinese labels (product UI language). */
export function humanizeToolName(tool: string): string {
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
  private mainTask: string;
  private mainName: string;
  private mainStatus = "running";
  private activeTool = "";
  private lastTool = "";
  private phase = "starting";
  private detail = "";

  constructor(mainTask: string, mainName?: string) {
    this.mainTask = (mainTask || "Authorized security task").slice(0, 240);
    this.mainName = (mainName || "Expert").trim().slice(0, 64) || "Expert";
    this.detail = describeMainActivity({ phase: this.phase });
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

  noteSubagentStart(input: { id: string; assignment: string; goalId?: string }): void {
    this.children.set(input.id, {
      id: input.id,
      name: `Subagent ${input.id.slice(0, 12)}`,
      status: "running",
      parent_id: "node4-main",
      task: input.assignment.slice(0, 240),
      skills: [],
      pending_count: 0,
      role: "subagent",
      current_action: "running",
      current_detail: clipSubTask(input.assignment),
      goal_id: input.goalId,
    });
  }

  noteSubagentEnd(input: { id: string; ok: boolean; summary?: string }): void {
    const prev = this.children.get(input.id);
    const status = input.ok ? "completed" : "failed";
    this.children.set(input.id, {
      id: input.id,
      name: prev?.name || `Subagent ${input.id.slice(0, 12)}`,
      status,
      parent_id: "node4-main",
      task: prev?.task || "",
      skills: [],
      pending_count: 0,
      role: "subagent",
      current_action: status,
      current_detail: input.ok ? "子任务已完成" : (input.summary || "子任务失败").slice(0, 160),
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
    const detail =
      options?.terminal && mainStatus === "completed"
        ? "本轮工作已结束"
        : this.detail || describeMainActivity({ phase, tool: this.activeTool, lastTool: this.lastTool });
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
    };
    return [main, ...this.children.values()];
  }
}

function clipSubTask(s: string): string {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return "子代理执行中";
  return t.length > 80 ? `子代理：${t.slice(0, 77)}…` : `子代理：${t}`;
}
