/**
 * Expert / role-pack catalog for multi-expert product UI.
 * Structured engagement ids only — never derived from free-text NLP.
 * Mirrors platform expert_offers + experts/ pack.json.
 */

export type ExpertId = "pentest" | "ctf" | "consult";

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
  "pentest-file-upload": {
    label: "文件上传",
    description: "上传入口的类型限制、落盘路径与可执行性验证。",
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

/** Catalog of installable expert packs (known to platform). */
export const EXPERT_PACKS: readonly ExpertPackMeta[] = [
  {
    id: "pentest",
    label: "Pentest",
    description: "授权渗透测试 — 侦察、利用、证据驱动的 finding。",
    isDefault: true,
    skillIds: [
      "pentest-web-recon",
      "pentest-auth-session",
      "pentest-sql-injection",
      "pentest-xss",
      "pentest-access-control",
      "pentest-file-upload",
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
    label: "Consult",
    description: "安全咨询（stub）— 解释/分析；不登记产品 finding。",
    skillIds: [],
    toolNames: ["todo", "shell", "read", "goal"],
  },
] as const;

export const DEFAULT_EXPERT_ID: ExpertId = "pentest";

const PACK_BY_ID: Record<string, ExpertPackMeta> = Object.fromEntries(
  EXPERT_PACKS.map((p) => [p.id, p]),
);

/** Engagement/role aliases → canonical pack id (same folding as backend). */
const ENGAGEMENT_ALIASES: Record<string, ExpertId> = {
  pentest: "pentest",
  assess: "pentest",
  verify: "pentest",
  retest: "pentest",
  ctf: "ctf",
  "ctf-web": "ctf",
  challenge: "ctf",
  consult: "consult",
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
 * Effective installed offers for a node (default pentest-only when missing/empty).
 * Matches backend `effective_offers`.
 */
export function effectiveOffers(offers: unknown): ExpertId[] {
  if (!Array.isArray(offers) || offers.length === 0) {
    return [DEFAULT_EXPERT_ID];
  }
  const out: ExpertId[] = [];
  const seen = new Set<ExpertId>();
  for (const item of offers) {
    const pack = normalizeExpertId(item);
    if (!pack || seen.has(pack)) continue;
    seen.add(pack);
    out.push(pack);
  }
  return out.length > 0 ? out : [DEFAULT_EXPERT_ID];
}

export function nodeOffersExpert(offers: unknown, expertId: unknown): boolean {
  const pack = normalizeExpertId(expertId) ?? DEFAULT_EXPERT_ID;
  return effectiveOffers(offers).includes(pack);
}

/** Prefer an installed expert; fall back to first offer / default. */
export function coerceEngagementToOffers(
  engagement: unknown,
  offers: unknown,
): ExpertId {
  const installed = effectiveOffers(offers);
  const pack = normalizeExpertId(engagement);
  if (pack && installed.includes(pack)) return pack;
  return installed[0] ?? DEFAULT_EXPERT_ID;
}
