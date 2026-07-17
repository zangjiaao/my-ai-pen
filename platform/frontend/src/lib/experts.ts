/**
 * Expert / role-pack catalog for multi-expert product UI.
 * Structured engagement ids only — never derived from free-text NLP.
 * Mirrors platform expert_offers + experts/ pack.json.
 */

export type ExpertId =
  | "default"
  | "pentest"
  | "ctf"
  | "consult"
  | "llm-security"
  | "code-audit"
  | "alert-triage";

/** Built into every Node — not shown as installable 扩展包. */
export const BUILTIN_PACK_IDS: ReadonlySet<string> = new Set(["default", "consult", "workspace"]);

/** Structured engagement templates (RoE depth) — not free-text NLP. */
export type EngagementTemplateId = "app_assessment" | "redteam_deep";

export const ENGAGEMENT_TEMPLATES: readonly {
  id: EngagementTemplateId;
  label: string;
  description: string;
  allowPostex: boolean;
}[] = [
  {
    id: "app_assessment",
    label: "应用评估",
    description: "给定资产/账号；常规漏洞与越权；禁止后渗透",
    allowPostex: false,
  },
  {
    id: "redteam_deep",
    label: "红队深度",
    description: "授权外网发现与利用；允许范围内后渗透/横向",
    allowPostex: true,
  },
] as const;

export type CapabilityItem = {
  id: string;
  label: string;
  description: string;
};

export type ExpertPackMeta = {
  id: ExpertId;
  /** Short label for chips / selects */
  label: string;
  /** One-line purpose */
  description: string;
  /** Whether this is the commercial default when offers is empty */
  isDefault?: boolean;
  /** Pack skills (from experts/<id>/pack.json skillIds) */
  skillIds: readonly string[];
  /** Pack tools (from experts/<id>/pack.json toolNames) */
  toolNames: readonly string[];
};

/** Display metadata for pack skills (product-facing, on Expert 名片). */
const SKILL_META: Record<string, { label: string; description: string }> = {
  "pentest-web-recon": {
    label: "Web 侦察",
    description: "端点、参数、技术栈与登录态摸底，再进入漏洞探测。",
  },
  "pentest-surface-enum": {
    label: "攻击面枚举",
    description: "端口、证书、域名与可触达服务梳理（授权范围内）。",
  },
  "pentest-external-intel": {
    label: "外部情报",
    description: "授权范围内的外部信息辅助面发现（非目标答案库）。",
  },
  "pentest-auth-session": {
    label: "认证与会话",
    description: "登录、Cookie/会话捕获、多身份切换与已认证请求回放。",
  },
  "pentest-sql-injection": {
    label: "SQL 注入",
    description: "查询/筛选/登录等参数是否影响数据库语义或报错。",
  },
  "pentest-xss": {
    label: "跨站脚本 (XSS)",
    description: "反射/存储/DOM 场景下输入是否进入可执行上下文。",
  },
  "pentest-access-control": {
    label: "访问控制 / IDOR",
    description: "水平/垂直越权、对象级授权；需双身份对照验证。",
  },
  "pentest-authz-logic": {
    label: "授权与业务逻辑",
    description: "角色边界、流程绕过与业务逻辑滥用（评估模式重点）。",
  },
  "pentest-file-upload": {
    label: "文件上传",
    description: "上传入口的类型限制、落盘路径与可执行性验证。",
  },
  "pentest-component-rce": {
    label: "组件与 RCE 模式",
    description: "已知组件利用模式的假设驱动验证（证据优先，无 CVE 答案表）。",
  },
  "pentest-service-exposure": {
    label: "服务暴露",
    description: "管理面、调试口与未授权服务暴露验证。",
  },
  "pentest-postex-host": {
    label: "后渗透（主机）",
    description: "仅 redteam_deep / allow_postex 时：主机立足点与证据。",
  },
  "pentest-lateral": {
    label: "横向移动",
    description: "仅授权深度路径：范围内横向与 hop 证据。",
  },
  "pentest-purple-handoff": {
    label: "紫队交接",
    description: "将已证明 finding 打包给检测/告警研判（红蓝协作）。",
  },
  "pentest-stuck-rotation": {
    label: "卡点轮换",
    description: "长时间无进展时换角度、工具与假设，避免空转。",
  },
  "ctf-web-recon": {
    label: "CTF Web 侦察",
    description: "枚举关卡入口、提示与交互面，建立解题地图。",
  },
  "ctf-flag-verify": {
    label: "Flag 验证",
    description: "提交/校验 flag 形态与证据，避免误报。",
  },
  "ctf-stuck-rotation": {
    label: "CTF 卡点轮换",
    description: "无 flag 进展时切换路径与技巧，继续覆盖未解题。",
  },
  "llm-threat-model-roe": {
    label: "威胁建模与 RoE",
    description: "AI 系统范围、资产与滥用路径规划（结构化授权）。",
  },
  "llm-prompt-injection": {
    label: "提示注入",
    description: "直接注入 / 系统指令覆盖类探测。",
  },
  "llm-indirect-rag-injection": {
    label: "间接/RAG 注入",
    description: "检索文档、网页、邮件等不可信内容驱动的间接注入。",
  },
  "llm-multi-turn-jailbreak": {
    label: "多轮越狱",
    description: "多轮升级与角色扮演类安全策略绕过。",
  },
  "llm-encoding-obfuscation": {
    label: "编码与混淆",
    description: "编码、语言切换与混淆绕过探测。",
  },
  "llm-data-leakage": {
    label: "数据泄漏",
    description: "PII/密钥/跨会话或租户泄漏验证。",
  },
  "llm-mcp-tool-poisoning": {
    label: "MCP/工具投毒",
    description: "工具 schema、MCP 服务与插件投毒面。",
  },
  "llm-agent-tool-abuse": {
    label: "Agent 工具滥用",
    description: "工具权限越权、过量自主与危险动作。",
  },
  "llm-goal-hijack-memory": {
    label: "目标劫持/记忆",
    description: "目标漂移、记忆投毒与跨任务污染。",
  },
  "llm-purple-handoff": {
    label: "紫队交接 (LLM)",
    description: "将模型/Agent 证明打包给检测研判或应用安全。",
  },
  "code-repo-recon": {
    label: "仓库侦察",
    description: "原型分类、入口与信任边界摸底。",
  },
  "code-partition-focus": {
    label: "焦点切分",
    description: "互补审计切片，便于串行或多切片深读。",
  },
  "code-focus-review": {
    label: "焦点深审",
    description: "单焦点 source→sink 证据链审查。",
  },
  "code-candidate-validate": {
    label: "候选对抗验证",
    description: "入账前尝试证伪候选（可达性/净化/sink 真实性）。",
  },
  "code-runtime-handoff": {
    label: "运行时交接",
    description: "静态不足时结构化交给应用安全做动态验证。",
  },
  "alert-enrichment": {
    label: "告警 enrichment",
    description: "资产、身份、时间线与 Case 证据关联。",
  },
  "alert-true-false-positive": {
    label: "真假阳性",
    description: "基于证据的 TP/FP/不确定结论。",
  },
  "alert-detection-gap": {
    label: "检测缺口",
    description: "对照红队 PoC 检查是否产生告警。",
  },
  "alert-harm-severity": {
    label: "危害分级",
    description: "可利用性、爆炸半径、自主性与可恢复性分级。",
  },
  "alert-purple-replay": {
    label: "紫队回放",
    description: "检测/缓解后复现 PoC，验证检出与遏制。",
  },
};

const TOOL_META: Record<string, { label: string; description: string }> = {
  todo: { label: "Todo 地图", description: "粗粒度任务清单，驱动 Map → Act 循环。" },
  shell: { label: "Shell", description: "在授权环境中执行命令与工具链。" },
  write: { label: "写文件", description: "写入工作区文件。" },
  edit: { label: "编辑文件", description: "修改工作区已有文件。" },
  read: { label: "读取", description: "读取工作区文件、技能与上下文材料。" },
  http: { label: "HTTP", description: "发送/变种 HTTP 请求，支持会话回放。" },
  session: { label: "会话", description: "捕获与切换 HTTP/Cookie 会话材料。" },
  browser: { label: "浏览器", description: "打开页面、登录、快照 Cookie/存储。" },
  captcha: { label: "验证码", description: "CTF 场景下的验证码辅助处理。" },
  script: { label: "脚本", description: "在沙箱中编写/运行有限辅助脚本。" },
  finding: { label: "Finding 入账", description: "登记候选/确认发现、证据与复现说明。" },
  subagent: { label: "子 Agent", description: "派发进程内子任务。" },
  goal: { label: "Goal", description: "长任务目标锚点与进度。" },
  skill: { label: "Skill", description: "按需加载 pack 技能说明。" },
};

/**
 * All packs usable when creating product Experts (专家管理).
 * Built-in `default` is always on Node; others must be installed as 扩展包.
 */
export const EXPERT_PACKS: readonly ExpertPackMeta[] = [
  {
    id: "default",
    label: "通用助理",
    description: "Node 内置：会话协助、台账读写；不执行渗透、不登记 finding。",
    isDefault: true,
    skillIds: [],
    toolNames: [
      "todo",
      "read",
      "platform_list_assets",
      "platform_get_asset",
      "platform_list_vulnerabilities",
      "platform_get_vulnerability",
      "platform_update_finding_status",
      "platform_enrich_asset",
      "platform_conversation_snapshot",
    ],
  },
  {
    id: "pentest",
    label: "应用安全",
    description: "授权 Web/API 评估 — 面发现、利用、证据驱动 finding。",
    skillIds: [
      "pentest-web-recon",
      "pentest-surface-enum",
      "pentest-external-intel",
      "pentest-auth-session",
      "pentest-sql-injection",
      "pentest-xss",
      "pentest-access-control",
      "pentest-authz-logic",
      "pentest-file-upload",
      "pentest-component-rce",
      "pentest-service-exposure",
      "pentest-postex-host",
      "pentest-lateral",
      "pentest-purple-handoff",
      "pentest-stuck-rotation",
    ],
    toolNames: [
      "todo",
      "shell",
      "write",
      "edit",
      "read",
      "http",
      "session",
      "browser",
      "script",
      "finding",
      "subagent",
      "goal",
      "skill",
    ],
  },
  {
    id: "ctf",
    label: "CTF",
    description: "CTF Web 解题 — session/browser/captcha，最大化已验证 flag。",
    skillIds: ["ctf-web-recon", "ctf-flag-verify", "ctf-stuck-rotation"],
    toolNames: [
      "todo",
      "shell",
      "write",
      "edit",
      "read",
      "http",
      "session",
      "browser",
      "captcha",
      "script",
      "finding",
      "subagent",
      "goal",
      "skill",
    ],
  },
  {
    id: "consult",
    label: "通用助理（consult 别名）",
    description: "兼容别名 → default 内置座；创建专家时请选「通用助理」。",
    skillIds: [],
    toolNames: ["todo", "read"],
  },
  {
    id: "llm-security",
    label: "模型安全",
    description: "LLM / Agent 对抗测试 — 注入、越狱、工具/MCP、紫队交接。",
    skillIds: [
      "llm-threat-model-roe",
      "llm-prompt-injection",
      "llm-indirect-rag-injection",
      "llm-multi-turn-jailbreak",
      "llm-encoding-obfuscation",
      "llm-data-leakage",
      "llm-mcp-tool-poisoning",
      "llm-agent-tool-abuse",
      "llm-goal-hijack-memory",
      "llm-purple-handoff",
    ],
    toolNames: ["todo", "shell", "write", "edit", "read", "http", "session", "script", "finding", "subagent", "goal", "skill"],
  },
  {
    id: "code-audit",
    label: "代码审计",
    description: "源码安全评估 — 原型侦察、焦点切分、对抗验证与运行时交接。",
    skillIds: [
      "code-repo-recon",
      "code-partition-focus",
      "code-focus-review",
      "code-candidate-validate",
      "code-runtime-handoff",
    ],
    toolNames: ["todo", "shell", "write", "edit", "read", "script", "finding", "subagent", "goal", "skill"],
  },
  {
    id: "alert-triage",
    label: "告警研判",
    description: "告警真假阳性、检测缺口与紫队回放（红蓝协作）。",
    skillIds: [
      "alert-enrichment",
      "alert-true-false-positive",
      "alert-detection-gap",
      "alert-harm-severity",
      "alert-purple-replay",
    ],
    toolNames: ["todo", "shell", "write", "edit", "read", "http", "script", "finding", "goal", "skill"],
  },
] as const;

/** Packs shown on Node 「扩展」tab (install/uninstall). Excludes built-in default. */
export const EXTENSION_PACKS: readonly ExpertPackMeta[] = EXPERT_PACKS.filter(
  (p) => !BUILTIN_PACK_IDS.has(p.id),
);

/** Default pack id when creating a general assistant Expert. */
export const DEFAULT_EXPERT_ID: ExpertId = "default";

/** Prefer pentest when coercing execution engagement without explicit pack. */
export const DEFAULT_EXECUTION_PACK_ID: ExpertId = "pentest";

const PACK_BY_ID: Record<string, ExpertPackMeta> = Object.fromEntries(
  EXPERT_PACKS.map((p) => [p.id, p]),
);

/** Engagement/role aliases → canonical pack id (same folding as backend). */
const ENGAGEMENT_ALIASES: Record<string, ExpertId> = {
  default: "default",
  workspace: "default",
  consult: "default",
  pentest: "pentest",
  assess: "pentest",
  verify: "pentest",
  retest: "pentest",
  app_assessment: "pentest",
  redteam_deep: "pentest",
  ctf: "ctf",
  "ctf-web": "ctf",
  challenge: "ctf",
  "llm-security": "llm-security",
  llm: "llm-security",
  "llm-redteam": "llm-security",
  "code-audit": "code-audit",
  code: "code-audit",
  "alert-triage": "alert-triage",
  soc: "alert-triage",
};

export function isExpertId(value: unknown): value is ExpertId {
  return typeof value === "string" && value in PACK_BY_ID;
}

export function normalizeExpertId(value: unknown): ExpertId | null {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  if (normalized in ENGAGEMENT_ALIASES) return ENGAGEMENT_ALIASES[normalized]!;
  if (isExpertId(normalized)) return normalized;
  return null;
}

export function expertMeta(id: string | null | undefined): ExpertPackMeta | null {
  const pack = normalizeExpertId(id);
  return pack ? PACK_BY_ID[pack] ?? null : null;
}

export function expertLabel(id: string | null | undefined): string {
  return expertMeta(id)?.label ?? (id ? String(id) : DEFAULT_EXPERT_ID);
}

export function packCapabilities(packId: string | null | undefined): {
  skills: CapabilityItem[];
  tools: CapabilityItem[];
} {
  const meta = expertMeta(packId);
  if (!meta) return { skills: [], tools: [] };
  return {
    skills: meta.skillIds.map((id) => ({
      id,
      label: SKILL_META[id]?.label ?? id,
      description: SKILL_META[id]?.description ?? "专家包技能。",
    })),
    tools: meta.toolNames.map((id) => ({
      id,
      label: TOOL_META[id]?.label ?? id,
      description: TOOL_META[id]?.description ?? "专家包工具。",
    })),
  };
}

/**
 * Effective **extension** offers on a node (empty = none installed).
 * Built-in `default` is never listed here — it is always on the Node.
 */
export function effectiveOffers(offers: unknown): ExpertId[] {
  if (!Array.isArray(offers) || offers.length === 0) {
    return [];
  }
  const out: ExpertId[] = [];
  const seen = new Set<ExpertId>();
  for (const item of offers) {
    const pack = normalizeExpertId(item);
    if (!pack || seen.has(pack) || BUILTIN_PACK_IDS.has(pack)) continue;
    seen.add(pack);
    out.push(pack);
  }
  return out;
}

/** True if this pack can be used when creating an Expert on the node. */
export function nodeOffersExpert(offers: unknown, expertId: unknown): boolean {
  const pack = normalizeExpertId(expertId) ?? DEFAULT_EXPERT_ID;
  if (BUILTIN_PACK_IDS.has(pack) || pack === "default") return true;
  return effectiveOffers(offers).includes(pack);
}

/** Prefer an installed extension; built-in default always available. */
export function coerceEngagementToOffers(
  engagement: unknown,
  offers: unknown,
): ExpertId {
  const pack = normalizeExpertId(engagement);
  if (pack && (BUILTIN_PACK_IDS.has(pack) || pack === "default")) return "default";
  const installed = effectiveOffers(offers);
  if (pack && installed.includes(pack)) return pack;
  return installed[0] ?? DEFAULT_EXPERT_ID;
}

/** Packs selectable when creating/editing an Expert on a given node. */
export function expertCreatePackOptions(offers: unknown): ExpertPackMeta[] {
  const installed = new Set(effectiveOffers(offers));
  return EXPERT_PACKS.filter((p) => {
    if (p.id === "consult") return false; // use default
    if (BUILTIN_PACK_IDS.has(p.id) || p.id === "default") return true;
    return installed.has(p.id);
  });
}
