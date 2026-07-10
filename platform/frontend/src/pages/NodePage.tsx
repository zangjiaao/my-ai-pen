import { authFetch } from "../lib/api";
import { useState, useEffect, useMemo, type ReactNode } from "react";
import { Check, Copy, Eye, EyeOff, RefreshCw } from "lucide-react";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";

const STATUS_FILTERS = ["全部", "online", "offline"] as const;
const TYPE_FILTERS = ["全部", "pentest", "platform"] as const;

type ConnectivityBar = {
  status: "up" | "down" | "unknown" | string;
  from_at: string;
  to_at: string;
};

/** Optional capability manifest reported by the node (or stored on node.config). */
type NodeCapabilities = {
  runtime?: string;
  version?: string;
  skills?: string[];
  workflows?: string[];
  tools?: string[];
};

type CapabilityMeta = { label: string; description: string };

/**
 * Display metadata for Node2 built-ins (Chinese label + short purpose).
 * Derived from node2 skill packages, workflow specs, and tool modules.
 * Unknown reported ids fall back to the raw id only.
 */
const CAPABILITY_META: {
  skills: Record<string, CapabilityMeta>;
  workflows: Record<string, CapabilityMeta>;
  tools: Record<string, CapabilityMeta>;
} = {
  skills: {
    "access-control": {
      label: "访问控制 / IDOR",
      description: "水平/垂直越权、对象级授权；需双身份对照验证。",
    },
    "auth-session": {
      label: "认证与会话",
      description: "登录、Cookie/会话捕获、多身份切换与已认证请求回放。",
    },
    "business-logic": {
      label: "业务逻辑",
      description: "多步骤流程、金额/数量篡改、跳步与跨用户工作流滥用。",
    },
    "command-injection": {
      label: "命令注入",
      description: "主机/IP/文件名等参数是否导致服务端执行系统命令。",
    },
    csrf: {
      label: "CSRF",
      description: "状态变更是否仅依赖环境 Cookie，或 Token 缺失/可绕过。",
    },
    "file-inclusion": {
      label: "文件包含 / 路径穿越",
      description: "page/file/path 等参数是否可读服务端任意路径。",
    },
    "file-upload": {
      label: "文件上传",
      description: "上传入口的类型限制、落盘路径与可执行性验证。",
    },
    "sql-injection": {
      label: "SQL 注入",
      description: "查询/筛选/登录等参数是否影响数据库语义或报错。",
    },
    "ssrf-open-redirect": {
      label: "SSRF / 开放重定向",
      description: "url/redirect/callback 等是否可控跳转或服务端外连。",
    },
    "weak-session-id": {
      label: "弱会话标识",
      description: "会话/重置 Token 是否可预测、短熵或规律可枚举。",
    },
    "web-recon": {
      label: "Web 侦察",
      description: "端点、参数、技术栈与登录态摸底，再进入漏洞探测。",
    },
    xss: {
      label: "跨站脚本 (XSS)",
      description: "反射/存储/DOM 场景下输入是否进入可执行上下文。",
    },
  },
  workflows: {
    "pentest-web": {
      label: "全面评估",
      description: "授权范围内的完整 Web 渗透：侦察、分包测试、证据与收尾门禁。",
    },
    "pentest-verify": {
      label: "假设验证",
      description: "针对用户给出的漏洞假设或 PoC 路径做最小侦察、严格取证。",
    },
    "pentest-retest": {
      label: "复测回归",
      description: "按原报告路径复现，判断仍存在 / 已修复 / 无法判定。",
    },
    "pentest-consult": {
      label: "安全咨询",
      description: "方法与产品问答；仅在明确授权目标且需要事实核对时才探测。",
    },
  },
  tools: {
    read: {
      label: "读取",
      description: "读取工作区文件、技能与上下文材料。",
    },
    http: {
      label: "HTTP 请求",
      description: "发送/变种 HTTP 请求，支持按身份（actor）回放。",
    },
    browser: {
      label: "浏览器",
      description: "打开页面、登录、快照 Cookie/存储，覆盖前端重交互。",
    },
    actor: {
      label: "身份角色",
      description: "捕获、切换、列出多测试身份的会话材料。",
    },
    traffic: {
      label: "流量",
      description: "检视、同步、回放与分析已捕获流量与候选端点。",
    },
    scan: {
      label: "扫描器",
      description: "调用 nmap/httpx/nuclei/sqlmap 等专业扫描工具。",
    },
    coverage: {
      label: "覆盖率",
      description: "攻击面登记、未测项与下一优先探测建议。",
    },
    poc: {
      label: "PoC",
      description: "漏洞 PoC 目录查询，或在沙箱中编写/运行有限脚本。",
    },
    verifier: {
      label: "验证器",
      description: "对常见漏洞类做结构化对照验证（含双身份等）。",
    },
    finding: {
      label: "漏洞记录",
      description: "登记候选/确认发现、证据与复现说明。",
    },
    worker: {
      label: "子任务 Worker",
      description: "向侦察/注入等角色派发进程内子 Agent 任务。",
    },
    finish_scan: {
      label: "结束扫描",
      description: "完成门禁检查并以 completed/incomplete 等状态收尾。",
    },
    workflow_list: {
      label: "列出 Workflow",
      description: "查看当前节点可用的 pi-workflow 列表。",
    },
    workflow_run: {
      label: "运行 Workflow",
      description: "按名称启动指定 pi-workflow 执行路径。",
    },
    workflow_dynamic: {
      label: "动态 Workflow",
      description: "按运行时参数动态组装或调整 workflow 步骤。",
    },
  },
};

/** Id lists for defaults — keys of CAPABILITY_META for each kind. */
const NODE2_DEFAULT_CAPABILITIES: Required<Pick<NodeCapabilities, "skills" | "workflows" | "tools">> = {
  skills: Object.keys(CAPABILITY_META.skills),
  workflows: Object.keys(CAPABILITY_META.workflows),
  tools: Object.keys(CAPABILITY_META.tools),
};

function resolveCapabilityMeta(
  kind: keyof typeof CAPABILITY_META,
  id: string,
): CapabilityMeta {
  return (
    CAPABILITY_META[kind][id] || {
      label: id,
      description: "节点上报的能力项（暂无本地说明）。",
    }
  );
}

type NodeRecord = {
  id: string;
  name: string;
  type: string;
  status: string;
  ip?: string | null;
  current_sessions?: number;
  registered_at?: string | null;
  last_heartbeat?: string | null;
  current_task?: {
    conversation_id: string;
    title?: string | null;
    status?: string | null;
    target?: string | null;
  } | null;
  last_failure_reason?: string | null;
  token?: string | null;
  worker_max_ms?: number | null;
  worker_max_turns?: number | null;
  worker_max_timeout_retries?: number | null;
  main_max_ms?: number | null;
  main_max_turns?: number | null;
  max_concurrent_workers?: number | null;
  default_scan_mode?: string | null;
  connectivity?: ConnectivityBar[];
  connectivity_uptime_pct?: number | null;
  capabilities?: NodeCapabilities | null;
};

export default function NodePage() {
  const [nodes, setNodes] = useState<NodeRecord[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>("全部");
  const [typeFilter, setTypeFilter] = useState<(typeof TYPE_FILTERS)[number]>("全部");
  const [showRegister, setShowRegister] = useState(false);
  const [regName, setRegName] = useState("");
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState("");
  const [issuedToken, setIssuedToken] = useState("");
  const [selectedNode, setSelectedNode] = useState<NodeRecord | null>(null);
  const [detailToken, setDetailToken] = useState("");
  const [detailTokenVisible, setDetailTokenVisible] = useState(false);

  const load = async () => {
    const data = await authFetch<NodeRecord[]>("/api/nodes");
    setNodes(data);
    setSelectedNode((current) => (current ? data.find((n) => n.id === current.id) || null : null));
  };
  useEffect(() => {
    void load();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return nodes.filter((n) => {
      if (statusFilter !== "全部" && n.status !== statusFilter) return false;
      if (typeFilter !== "全部" && n.type !== typeFilter) return false;
      if (!q) return true;
      const hay = `${n.name} ${n.ip || ""} ${n.type} ${taskSummary(n.current_task)}`.toLowerCase();
      return hay.includes(q);
    });
  }, [nodes, search, statusFilter, typeFilter]);

  const register = async () => {
    setRegistering(true);
    setRegisterError("");
    try {
      const res = await authFetch("/api/nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: regName.trim() || undefined }),
      });
      const data = res as Record<string, unknown>;
      setIssuedToken(String(data.token || ""));
      setShowRegister(false);
      setRegName("");
      void load();
    } catch (err) {
      setRegisterError(err instanceof Error ? err.message : "注册失败");
    } finally {
      setRegistering(false);
    }
  };

  const deleteNode = async (id: string, name: string) => {
    if (!window.confirm(`确定删除节点 "${name}"？`)) return;
    await authFetch(`/api/nodes/${id}`, { method: "DELETE" });
    if (selectedNode?.id === id) setSelectedNode(null);
    void load();
  };

  const regenerateToken = async (id: string) => {
    const data = (await authFetch(`/api/nodes/${id}/regenerate-token`, { method: "POST" })) as Record<
      string,
      unknown
    >;
    setDetailToken(String(data.token || ""));
    setDetailTokenVisible(false);
    window.dispatchEvent(new CustomEvent("nodes:changed"));
    void load();
  };

  const openDetail = async (node: NodeRecord) => {
    setSelectedNode(node);
    setDetailToken("");
    setDetailTokenVisible(false);
    try {
      setSelectedNode(await authFetch<NodeRecord>(`/api/nodes/${node.id}`));
    } catch {
      /* keep snapshot */
    }
  };

  return (
    <div className="flex h-screen bg-canvas">
      <Sidebar activeId={null} onSelect={() => {}} />
      <div className="flex flex-1 flex-col">
        <TopBar title="节点管理" />
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索节点名称、IP、任务…"
              className="rounded-md border border-hairline px-3 py-2 text-sm focus:border-ink focus:outline-none"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as (typeof STATUS_FILTERS)[number])}
              className="rounded-md border border-hairline px-3 py-2 text-sm"
            >
              {STATUS_FILTERS.map((s) => (
                <option key={s} value={s}>
                  {s === "全部" ? "全部状态" : s}
                </option>
              ))}
            </select>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as (typeof TYPE_FILTERS)[number])}
              className="rounded-md border border-hairline px-3 py-2 text-sm"
            >
              {TYPE_FILTERS.map((t) => (
                <option key={t} value={t}>
                  {t === "全部" ? "全部类型" : t}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                setRegisterError("");
                setShowRegister(true);
              }}
              className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-white"
            >
              注册节点
            </button>
          </div>

          {filtered.length === 0 ? (
            <p className="text-sm text-ink-muted">
              {nodes.length === 0
                ? "暂无注册节点。点击「注册节点」添加。"
                : "没有匹配的节点，请调整搜索或筛选。"}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {filtered.map((n) => {
                const isPlatform = n.type === "platform";
                const online = n.status === "online";
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => {
                      void openDetail(n);
                    }}
                    className="group flex flex-col rounded-lg border border-hairline bg-canvas p-4 text-left transition-colors hover:bg-surface-default"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="min-w-0 truncate text-base font-semibold text-ink">{n.name}</span>
                          <OnlineBadge online={online} />
                        </div>
                        <p className="mt-0.5 font-mono text-[11px] text-ink-muted">
                          {isPlatform ? "平台 Agent" : n.type}
                          {n.ip ? ` · ${n.ip}` : ""}
                        </p>
                      </div>
                      {!isPlatform && (
                        <span
                          onClick={(e) => {
                            e.stopPropagation();
                            void deleteNode(n.id, n.name);
                          }}
                          className="shrink-0 cursor-pointer text-xs text-ink-muted opacity-0 transition-opacity hover:text-severity-critical group-hover:opacity-100"
                        >
                          删除
                        </span>
                      )}
                    </div>
                    <div className="mt-4 flex items-end justify-between gap-4">
                      <div className="min-w-0 flex-1 space-y-0.5 text-xs text-ink-secondary">
                        <p>
                          <span className="text-ink-muted">会话 </span>
                          <span className="font-mono text-ink">{n.current_sessions || 0}</span>
                        </p>
                        <p className="truncate" title={taskSummary(n.current_task)}>
                          <span className="text-ink-muted">任务 </span>
                          {taskSummary(n.current_task)}
                        </p>
                        {n.type === "pentest" && (
                          <p className="truncate text-ink-muted">
                            预算 {formatWorkerTimeout(n.worker_max_ms)} · 轮次 {n.worker_max_turns ?? 12}
                          </p>
                        )}
                      </div>
                      <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
                        <ConnectivityStrip bars={n.connectivity} uptimePct={n.connectivity_uptime_pct} />
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {showRegister && (
        <SimpleDialog
          title="注册节点"
          description="创建后将生成 NODE_TOKEN，用于执行节点连接平台。"
          confirmLabel={registering ? "注册中…" : "注册"}
          confirming={registering}
          error={registerError}
          onClose={() => !registering && setShowRegister(false)}
          onConfirm={() => {
            void register();
          }}
        >
          <input
            autoFocus
            value={regName}
            onChange={(e) => setRegName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void register()}
            placeholder="节点名称（留空自动生成）"
            className="w-full rounded-md border border-hairline px-3 py-2 text-sm"
          />
        </SimpleDialog>
      )}

      {issuedToken && <TokenIssuedDialog token={issuedToken} onClose={() => setIssuedToken("")} />}

      {selectedNode && (
        <NodeDetailDialog
          node={selectedNode}
          token={detailToken || selectedNode.token || ""}
          tokenVisible={detailTokenVisible}
          onToggleToken={() => setDetailTokenVisible((v) => !v)}
          onClose={() => setSelectedNode(null)}
          onRegenerateToken={() => {
            void regenerateToken(selectedNode.id);
          }}
          onSaved={() => {
            void load();
          }}
        />
      )}
    </div>
  );
}

function NodeDetailDialog({
  node,
  token,
  tokenVisible,
  onToggleToken,
  onClose,
  onRegenerateToken,
  onSaved,
}: {
  node: NodeRecord;
  token: string;
  tokenVisible: boolean;
  onToggleToken: () => void;
  onClose: () => void;
  onRegenerateToken: () => void;
  onSaved: () => void;
}) {
  const isPlatform = node.type === "platform";
  const isPentest = node.type === "pentest";
  const online = node.status === "online";
  const [copied, setCopied] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(node.name);
  const [renaming, setRenaming] = useState(false);
  const [timeoutSec, setTimeoutSec] = useState(String(Math.round((node.worker_max_ms ?? 300_000) / 1000)));
  const [maxTurns, setMaxTurns] = useState(String(node.worker_max_turns ?? 12));
  const [maxRetries, setMaxRetries] = useState(String(node.worker_max_timeout_retries ?? 2));
  const [mainTimeoutSec, setMainTimeoutSec] = useState(String(Math.round((node.main_max_ms ?? 1_800_000) / 1000)));
  const [mainMaxTurns, setMainMaxTurns] = useState(String(node.main_max_turns ?? 80));
  const [maxConcurrent, setMaxConcurrent] = useState(String(node.max_concurrent_workers ?? 1));
  const [scanMode, setScanMode] = useState(node.default_scan_mode || "standard");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveOk, setSaveOk] = useState(false);
  type DetailTab = "overview" | "runtime" | "skills" | "workflows" | "tools";
  const [detailTab, setDetailTab] = useState<DetailTab>("overview");

  const reportedCaps = normalizeCapabilities(node.capabilities);
  // Always show capability catalog for pentest nodes (read-only). Prefer
  // node-reported data; fall back to type defaults so the section is never blank.
  const caps: NodeCapabilities | null = isPentest
    ? {
        runtime: reportedCaps?.runtime,
        version: reportedCaps?.version,
        skills: reportedCaps?.skills?.length ? reportedCaps.skills : NODE2_DEFAULT_CAPABILITIES.skills,
        workflows: reportedCaps?.workflows?.length ? reportedCaps.workflows : NODE2_DEFAULT_CAPABILITIES.workflows,
        tools: reportedCaps?.tools?.length ? reportedCaps.tools : NODE2_DEFAULT_CAPABILITIES.tools,
      }
    : reportedCaps;

  const detailTabs: { key: DetailTab; label: string; count?: number }[] = [
    { key: "overview", label: "概览" },
    ...(isPentest ? [{ key: "runtime" as const, label: "运行参数" }] : []),
    ...((caps?.skills?.length ?? 0) > 0
      ? [{ key: "skills" as const, label: "技能", count: caps!.skills!.length }]
      : []),
    ...((caps?.workflows?.length ?? 0) > 0
      ? [{ key: "workflows" as const, label: "Workflow", count: caps!.workflows!.length }]
      : []),
    ...((caps?.tools?.length ?? 0) > 0
      ? [{ key: "tools" as const, label: "工具", count: caps!.tools!.length }]
      : []),
  ];
  const activeDetailTab = detailTabs.some((t) => t.key === detailTab)
    ? detailTab
    : (detailTabs[0]?.key ?? "overview");
  const showSave = isPentest && activeDetailTab === "runtime";

  useEffect(() => {
    setNameDraft(node.name);
    setEditingName(false);
    setTimeoutSec(String(Math.round((node.worker_max_ms ?? 300_000) / 1000)));
    setMaxTurns(String(node.worker_max_turns ?? 12));
    setMaxRetries(String(node.worker_max_timeout_retries ?? 2));
    setMainTimeoutSec(String(Math.round((node.main_max_ms ?? 1_800_000) / 1000)));
    setMainMaxTurns(String(node.main_max_turns ?? 80));
    setMaxConcurrent(String(node.max_concurrent_workers ?? 1));
    setScanMode(node.default_scan_mode || "standard");
    setSaveError("");
    setSaveOk(false);
    setDetailTab("overview");
  }, [
    node.id,
    node.name,
    node.worker_max_ms,
    node.worker_max_turns,
    node.worker_max_timeout_retries,
    node.main_max_ms,
    node.main_max_turns,
    node.max_concurrent_workers,
    node.default_scan_mode,
  ]);

  const saveRename = async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      setSaveError("节点名称不能为空");
      return;
    }
    if (trimmed === node.name) {
      setEditingName(false);
      return;
    }
    setRenaming(true);
    setSaveError("");
    try {
      await authFetch(`/api/nodes/${node.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      setEditingName(false);
      window.dispatchEvent(new CustomEvent("nodes:changed"));
      onSaved();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "改名失败");
    } finally {
      setRenaming(false);
    }
  };

  const saveWorkerLimits = async () => {
    if (!isPentest) return;
    const sec = Number(timeoutSec);
    const turns = Number(maxTurns);
    const retries = Number(maxRetries);
    const mainSec = Number(mainTimeoutSec);
    const mainTurns = Number(mainMaxTurns);
    const concurrent = Number(maxConcurrent);
    if (!Number.isFinite(sec) || sec < 10 || sec > 900) {
      setSaveError("Worker 超时需在 10–900 秒之间");
      return;
    }
    if (!Number.isFinite(turns) || turns < 1 || turns > 40) {
      setSaveError("Worker 最大轮次需在 1–40 之间");
      return;
    }
    if (!Number.isFinite(retries) || retries < 0 || retries > 5) {
      setSaveError("超时重试次数需在 0–5 之间");
      return;
    }
    if (!Number.isFinite(mainSec) || mainSec < 60 || mainSec > 7200) {
      setSaveError("主 Agent 超时需在 60–7200 秒之间");
      return;
    }
    if (!Number.isFinite(mainTurns) || mainTurns < 5 || mainTurns > 200) {
      setSaveError("主 Agent 最大轮次需在 5–200 之间");
      return;
    }
    if (!Number.isFinite(concurrent) || concurrent < 1 || concurrent > 4) {
      setSaveError("最大并发 Worker 需在 1–4 之间");
      return;
    }
    if (!["quick", "standard", "deep"].includes(scanMode)) {
      setSaveError("默认扫描深度无效");
      return;
    }
    setSaving(true);
    setSaveError("");
    setSaveOk(false);
    try {
      await authFetch(`/api/nodes/${node.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          worker_max_ms: Math.round(sec * 1000),
          worker_max_turns: Math.round(turns),
          worker_max_timeout_retries: Math.round(retries),
          main_max_ms: Math.round(mainSec * 1000),
          main_max_turns: Math.round(mainTurns),
          max_concurrent_workers: Math.round(concurrent),
          default_scan_mode: scanMode,
        }),
      });
      setSaveOk(true);
      window.dispatchEvent(new CustomEvent("nodes:changed"));
      onSaved();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const taskDetail = node.current_task?.conversation_id
    ? `${taskSummary(node.current_task)}\n${node.current_task.conversation_id}`
    : taskSummary(node.current_task);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-6" onClick={onClose}>
      <div
        className="flex max-h-[min(88vh,840px)] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-hairline-soft bg-canvas shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header: status, name, id */}
        <div className="group/title shrink-0 px-6 pt-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <OnlineBadge online={online} />
                {editingName ? (
                  <input
                    autoFocus
                    value={nameDraft}
                    disabled={renaming}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveRename();
                      if (e.key === "Escape") {
                        setNameDraft(node.name);
                        setEditingName(false);
                      }
                    }}
                    className="min-w-0 flex-1 rounded border border-hairline px-2 py-1 text-xl font-semibold focus:outline-none"
                  />
                ) : (
                  <h2 className="min-w-0 break-words text-xl font-semibold">{node.name}</h2>
                )}
                {editingName ? (
                  <>
                    <button type="button" disabled={renaming} onClick={() => void saveRename()} className="text-xs text-ink-muted hover:text-ink">
                      {renaming ? "保存中…" : "保存"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setNameDraft(node.name);
                        setEditingName(false);
                      }}
                      className="text-xs text-ink-muted hover:text-ink"
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setEditingName(true)}
                    className="text-xs text-ink-muted opacity-0 transition-opacity hover:text-ink group-hover/title:opacity-100"
                  >
                    改名
                  </button>
                )}
              </div>
              <p className="mt-1 break-all font-mono text-[11px] text-ink-muted">{node.id}</p>
            </div>
            <button type="button" onClick={onClose} className="rounded-md border border-hairline px-3 py-1.5 text-xs">
              关闭
            </button>
          </div>
        </div>

        {/* Single-level tabs: 概览 | 运行参数 | 技能 | Workflow | 工具 */}
        <div className="shrink-0 border-b border-hairline-soft px-6">
          <div className="flex flex-wrap items-center gap-4">
            {detailTabs.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => {
                  setDetailTab(t.key);
                  setSaveError("");
                }}
                className={`px-0.5 py-2.5 text-[13px] font-medium transition-colors ${
                  activeDetailTab === t.key
                    ? "border-b-2 border-ink text-ink"
                    : "border-b-2 border-transparent text-ink-secondary hover:text-ink"
                }`}
              >
                {t.label}
                {t.count != null && (
                  <span className="ml-1 text-[11px] font-normal text-ink-muted">{t.count}</span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Body grows with content; scrolls only when over max-height */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {activeDetailTab === "overview" && (
            <div className="space-y-4">
              <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <InfoCard label="类型" value={isPlatform ? "平台 Agent" : node.type} />
                <InfoCard label="IP" value={node.ip || "—"} mono />
                <InfoCard label="状态" value={online ? "在线" : "离线"} />
                <InfoCard label="关联会话数" value={String(node.current_sessions ?? 0)} mono />
              </section>
              <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <InfoCard label="当前任务" value={taskDetail} title={taskDetail} />
                <InfoCard label="最近心跳" value={formatDate(node.last_heartbeat)} />
                <InfoCard
                  label="最近失败"
                  value={node.last_failure_reason || "—"}
                  tone={node.last_failure_reason ? "danger" : "default"}
                />
                <InfoCard label="注册时间" value={formatDate(node.registered_at)} />
              </section>
              <div className="rounded-md border border-hairline-soft p-4">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm font-medium">Token</p>
                  {!isPlatform && (
                    <button
                      type="button"
                      onClick={onRegenerateToken}
                      className="inline-flex items-center gap-1.5 rounded-md border border-hairline px-2.5 py-1 text-xs text-ink-secondary hover:bg-surface-default"
                    >
                      <RefreshCw size={13} /> 刷新
                    </button>
                  )}
                </div>
                {isPlatform ? (
                  <p className="text-xs text-ink-muted">内置平台节点，无需 Token。</p>
                ) : (
                  <>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="group flex min-w-0 flex-1 items-start gap-2 rounded-md bg-canvas-inset px-3 py-2.5 text-left font-mono text-xs"
                        onClick={async () => {
                          if (!token) return;
                          await navigator.clipboard?.writeText(token);
                          setCopied(true);
                          window.setTimeout(() => setCopied(false), 1600);
                        }}
                      >
                        <span className="min-w-0 flex-1 break-all">
                          {token ? (tokenVisible ? token : maskToken(token)) : maskTokenPlaceholder()}
                        </span>
                        {token && (copied ? <Check size={14} className="text-status-success" /> : <Copy size={14} />)}
                      </button>
                      {token && (
                        <button type="button" onClick={onToggleToken} className="rounded-md border p-2 text-ink-muted">
                          {tokenVisible ? <EyeOff size={15} /> : <Eye size={15} />}
                        </button>
                      )}
                    </div>
                    <p className="mt-2 text-xs text-ink-muted">刷新后旧连接会断开，需用新 Token 重启节点。</p>
                  </>
                )}
              </div>
              {(caps?.runtime || caps?.version) && (
                <p className="font-mono text-[11px] text-ink-muted">
                  {[caps.runtime, caps.version].filter(Boolean).join(" · ")}
                </p>
              )}
            </div>
          )}

          {activeDetailTab === "runtime" && isPentest && (
            <div className="space-y-4">
              <p className="text-xs text-ink-muted">
                保存后对<strong>新任务</strong>生效。任务若显式指定扫描深度，将覆盖节点默认值。
              </p>

              <div className="rounded-md border border-hairline-soft p-4">
                <p className="text-sm font-medium">Worker 运行预算</p>
                <p className="mt-1 text-xs text-ink-muted">子 Agent 墙钟超时、工具轮次与超时重试。</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <label className="block space-y-1">
                    <span className="text-[11px] text-ink-muted">超时（秒）</span>
                    <input
                      type="number"
                      min={10}
                      max={900}
                      value={timeoutSec}
                      onChange={(e) => {
                        setTimeoutSec(e.target.value);
                        setSaveOk(false);
                      }}
                      className="w-full rounded-md border px-2.5 py-2 font-mono text-sm"
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-[11px] text-ink-muted">最大轮次</span>
                    <input
                      type="number"
                      min={1}
                      max={40}
                      value={maxTurns}
                      onChange={(e) => {
                        setMaxTurns(e.target.value);
                        setSaveOk(false);
                      }}
                      className="w-full rounded-md border px-2.5 py-2 font-mono text-sm"
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-[11px] text-ink-muted">超时重试</span>
                    <input
                      type="number"
                      min={0}
                      max={5}
                      value={maxRetries}
                      onChange={(e) => {
                        setMaxRetries(e.target.value);
                        setSaveOk(false);
                      }}
                      className="w-full rounded-md border px-2.5 py-2 font-mono text-sm"
                    />
                  </label>
                </div>
              </div>

              <div className="rounded-md border border-hairline-soft p-4">
                <p className="text-sm font-medium">主 Agent 运行预算</p>
                <p className="mt-1 text-xs text-ink-muted">整任务主会话墙钟与工具轮次上限（含调度 Worker 的回合）。</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="block space-y-1">
                    <span className="text-[11px] text-ink-muted">超时（秒）</span>
                    <input
                      type="number"
                      min={60}
                      max={7200}
                      value={mainTimeoutSec}
                      onChange={(e) => {
                        setMainTimeoutSec(e.target.value);
                        setSaveOk(false);
                      }}
                      className="w-full rounded-md border px-2.5 py-2 font-mono text-sm"
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-[11px] text-ink-muted">最大轮次</span>
                    <input
                      type="number"
                      min={5}
                      max={200}
                      value={mainMaxTurns}
                      onChange={(e) => {
                        setMainMaxTurns(e.target.value);
                        setSaveOk(false);
                      }}
                      className="w-full rounded-md border px-2.5 py-2 font-mono text-sm"
                    />
                  </label>
                </div>
              </div>

              <div className="rounded-md border border-hairline-soft p-4">
                <p className="text-sm font-medium">调度与深度</p>
                <p className="mt-1 text-xs text-ink-muted">并发子 Agent 数量，以及任务未指定时的默认扫描深度。</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="block space-y-1">
                    <span className="text-[11px] text-ink-muted">最大并发 Worker</span>
                    <input
                      type="number"
                      min={1}
                      max={4}
                      value={maxConcurrent}
                      onChange={(e) => {
                        setMaxConcurrent(e.target.value);
                        setSaveOk(false);
                      }}
                      className="w-full rounded-md border px-2.5 py-2 font-mono text-sm"
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-[11px] text-ink-muted">默认扫描深度</span>
                    <select
                      value={scanMode}
                      onChange={(e) => {
                        setScanMode(e.target.value);
                        setSaveOk(false);
                      }}
                      className="w-full rounded-md border bg-canvas px-2.5 py-2 text-sm"
                    >
                      <option value="quick">快速 (quick)</option>
                      <option value="standard">标准 (standard)</option>
                      <option value="deep">深度 (deep)</option>
                    </select>
                  </label>
                </div>
              </div>
            </div>
          )}

          {activeDetailTab === "skills" && caps?.skills?.length ? (
            <CapabilityCardList kind="skills" items={caps.skills} />
          ) : null}
          {activeDetailTab === "workflows" && caps?.workflows?.length ? (
            <CapabilityCardList kind="workflows" items={caps.workflows} />
          ) : null}
          {activeDetailTab === "tools" && caps?.tools?.length ? (
            <CapabilityCardList kind="tools" items={caps.tools} />
          ) : null}
        </div>

        {/* Footer only when there is something to save / report */}
        {(showSave || saveError) && (
          <div className="shrink-0 border-t border-hairline-soft px-6 py-4">
            <div className="flex flex-wrap items-center justify-end gap-3">
              {showSave && saveOk && <span className="self-center text-xs text-status-success">已保存</span>}
              {saveError && <span className="self-center text-xs text-severity-critical">{saveError}</span>}
              {showSave && (
                <>
                  <button type="button" onClick={onClose} className="rounded-md border px-3 py-1.5 text-xs">
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void saveWorkerLimits()}
                    className="rounded-md bg-ink px-4 py-1.5 text-xs font-medium text-white disabled:opacity-60"
                  >
                    {saving ? "保存中…" : "保存"}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CapabilityCardList({
  kind,
  items,
}: {
  kind: keyof typeof CAPABILITY_META;
  items: string[];
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {items.map((id) => {
        const meta = resolveCapabilityMeta(kind, id);
        return (
          <div
            key={id}
            className="rounded-md border border-hairline-soft bg-canvas-inset/40 px-3 py-2.5"
            title={id}
          >
            <div className="flex min-w-0 items-baseline justify-between gap-2">
              <p className="truncate text-sm font-medium text-ink">{meta.label}</p>
              <span className="shrink-0 font-mono text-[10px] text-ink-muted">{id}</span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-ink-secondary">{meta.description}</p>
          </div>
        );
      })}
    </div>
  );
}

function normalizeCapabilities(raw: unknown): NodeCapabilities | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const strList = (v: unknown) =>
    Array.isArray(v) ? v.map((x) => String(x || "").trim()).filter(Boolean) : undefined;
  return {
    runtime: typeof o.runtime === "string" ? o.runtime : undefined,
    version: typeof o.version === "string" ? o.version : undefined,
    skills: strList(o.skills),
    workflows: strList(o.workflows),
    tools: strList(o.tools),
  };
}

function SimpleDialog({
  title,
  description,
  children,
  confirmLabel,
  confirming,
  error,
  onClose,
  onConfirm,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  confirmLabel: string;
  confirming?: boolean;
  error?: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg border border-hairline-soft bg-canvas p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">{title}</h2>
        {description && <p className="mt-1 text-xs text-ink-muted">{description}</p>}
        <div className="mt-4">{children}</div>
        {error && <p className="mt-2 text-xs text-severity-critical">{error}</p>}
        <div className="mt-6 flex justify-end gap-2 border-t border-hairline-soft pt-4">
          <button type="button" disabled={confirming} onClick={onClose} className="rounded-md border px-3 py-1.5 text-xs">
            取消
          </button>
          <button
            type="button"
            disabled={confirming}
            onClick={onConfirm}
            className="rounded-md bg-ink px-4 py-1.5 text-xs font-medium text-white disabled:opacity-60"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function TokenIssuedDialog({ token, onClose }: { token: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg border border-hairline-soft bg-canvas p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">节点注册成功</h2>
        <p className="mt-1 text-xs text-ink-muted">请保存 Token。启动 Node 时设置 NODE_TOKEN。</p>
        <button
          type="button"
          className="mt-4 flex w-full gap-2 rounded-md bg-canvas-inset px-3 py-2.5 text-left font-mono text-xs"
          onClick={async () => {
            await navigator.clipboard?.writeText(token);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          }}
        >
          <span className="min-w-0 flex-1 break-all">{token}</span>
          {copied ? <Check size={14} className="text-status-success" /> : <Copy size={14} />}
        </button>
        <div className="mt-6 flex justify-end border-t border-hairline-soft pt-4">
          <button type="button" onClick={onClose} className="rounded-md bg-ink px-4 py-1.5 text-xs font-medium text-white">
            完成
          </button>
        </div>
      </div>
    </div>
  );
}

function OnlineBadge({ online }: { online: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase ${
        online ? "bg-status-success/15 text-status-success" : "bg-canvas-inset text-ink-muted"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${online ? "bg-status-success" : "bg-ink-muted"}`} />
      {online ? "Online" : "Offline"}
    </span>
  );
}

function ConnectivityStrip({
  bars,
  uptimePct,
}: {
  bars?: ConnectivityBar[];
  uptimePct?: number | null;
}) {
  const items = bars?.length
    ? bars
    : Array.from({ length: 30 }, () => ({ status: "unknown", from_at: "", to_at: "" }));
  const pct = uptimePct != null && Number.isFinite(uptimePct) ? `${uptimePct}%` : "—";
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex h-7 items-end gap-px">
        {items.map((bar, i) => {
          const s = String(bar.status || "unknown");
          const color =
            s === "up" ? "bg-status-success" : s === "down" ? "bg-severity-critical/80" : "bg-ink-muted/25";
          return (
            <span
              key={i}
              className={`w-[3px] rounded-[1px] ${color}`}
              style={{ height: s === "unknown" ? "40%" : "100%" }}
            />
          );
        })}
      </div>
      <div className="font-mono text-[10px] text-ink-muted">
        24h <span className="text-ink-secondary">{pct}</span>
      </div>
    </div>
  );
}

function InfoCard({
  label,
  value,
  mono,
  tone = "default",
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: "default" | "danger";
  title?: string;
}) {
  return (
    <div className="rounded-md bg-canvas-inset p-2.5" title={title}>
      <div className="text-xs text-ink-muted">{label}</div>
      <div
        className={`mt-1 line-clamp-3 break-words text-xs ${mono ? "font-mono" : ""} ${
          tone === "danger" ? "text-severity-critical" : "text-ink"
        }`}
      >
        {value || "—"}
      </div>
    </div>
  );
}

function taskSummary(task?: NodeRecord["current_task"]): string {
  if (!task) return "—";
  const target = task.target ? ` · ${task.target}` : "";
  return `${task.title || task.conversation_id}${target}`;
}

function formatWorkerTimeout(ms?: number | null): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "300s";
  return `${Math.round(n / 1000)}s`;
}

function formatDate(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

function maskTokenPlaceholder() {
  return "*".repeat(32);
}

function maskToken(value: string) {
  if (value.length <= 12) return "*".repeat(value.length);
  return `${value.slice(0, 6)}${"*".repeat(Math.min(24, Math.max(8, value.length - 12)))}${value.slice(-6)}`;
}
