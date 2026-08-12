/**
 * Human-readable Chinese labels for tool ids (chat ToolCallCard + collab tree chips).
 * Prefer explicit titles from content.display_title when present.
 */

const TOOL_LABEL_ZH: Record<string, string> = {
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
  exec_command: "执行命令",
  write_stdin: "命令输入",
  http: "HTTP 探测",
  http_request: "HTTP 请求",
  session: "会话化 HTTP",
  browser: "浏览器探测",
  script: "运行脚本",
  write: "写入文件",
  edit: "编辑文件",
  read: "读取文件",
  finding: "登记发现",
  fact: "记录过程事实",
  surface: "记录攻击面",
  todo: "更新任务清单",
  skill: "加载技能",
  subagent: "启动子代理",
  goal: "更新目标",
  captcha: "处理验证码",
};

/**
 * Tool id / English name → short Chinese label for timeline chrome.
 * Unknown ids: platform_* → 「平台：…」; snake_case → spaced words (last resort).
 */
export function friendlyToolLabel(tool: string): string {
  const t = String(tool || "").trim();
  if (!t) return "工具";
  const lower = t.toLowerCase();
  if (TOOL_LABEL_ZH[lower]) return TOOL_LABEL_ZH[lower];
  if (TOOL_LABEL_ZH[t]) return TOOL_LABEL_ZH[t];
  if (t.startsWith("platform_")) {
    return `平台：${t.replace(/^platform_/, "").replace(/_/g, " ")}`;
  }
  // Already looks Chinese-ish (has CJK) — keep
  if (/[\u4e00-\u9fff]/.test(t)) return t;
  return t.replace(/_/g, " ");
}
