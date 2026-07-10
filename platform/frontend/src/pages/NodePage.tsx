import { authFetch } from "../lib/api";
import { useState, useEffect } from "react";
import { Check, Copy, Eye, EyeOff, RefreshCw } from "lucide-react";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";

type ConnectivityBar = {
  status: "up" | "down" | "unknown" | string;
  from_at: string;
  to_at: string;
};

type NodeRecord = {
  id: string;
  name: string;
  type: string;
  status: string;
  ip?: string | null;
  cpu_usage?: number | null;
  memory_usage?: number | null;
  current_sessions?: number;
  registered_at?: string | null;
  last_heartbeat?: string | null;
  current_task?: {
    conversation_id: string;
    title?: string | null;
    status?: string | null;
    target?: string | null;
    updated_at?: string | null;
  } | null;
  last_failure_reason?: string | null;
  token_required?: boolean;
  token?: string | null;
  /** Worker wall-clock budget (ms). Default 300000. */
  worker_max_ms?: number | null;
  /** Soft/hard tool-turn budget per worker package. Default 12. */
  worker_max_turns?: number | null;
  /** Timeouts before package is marked failed. Default 2. */
  worker_max_timeout_retries?: number | null;
  /** Last-24h connectivity buckets for card sparkline. */
  connectivity?: ConnectivityBar[];
  connectivity_uptime_pct?: number | null;
};

export default function NodePage() {
  const [nodes, setNodes] = useState<NodeRecord[]>([]);
  const [showRegister, setShowRegister] = useState(false);
  const [regName, setRegName] = useState("");
  const [newToken, setNewToken] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [selectedNode, setSelectedNode] = useState<NodeRecord | null>(null);
  const [detailToken, setDetailToken] = useState("");
  const [detailTokenVisible, setDetailTokenVisible] = useState(false);

  const load = async () => {
    const data = await authFetch<NodeRecord[]>("/api/nodes");
    setNodes(data);
    setSelectedNode(current => current ? data.find(node => node.id === current.id) || null : null);
  };
  useEffect(() => { void load(); }, []);

  const register = async () => {
    const res = await authFetch("/api/nodes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: regName || undefined }) });
    const data = res as Record<string,unknown>;
    setNewToken(data.token as string);
    setShowRegister(false);
    setRegName("");
    void load();
  };

  const deleteNode = async (id: string, name: string) => {
    if (!window.confirm(`确定删除节点 "${name}"？`)) return;
    await authFetch(`/api/nodes/${id}`, { method: "DELETE" });
    if (selectedNode?.id === id) setSelectedNode(null);
    void load();
  };

  const regenerateToken = async (id: string) => {
    const data = await authFetch(`/api/nodes/${id}/regenerate-token`, { method: "POST" }) as Record<string,unknown>;
    setDetailToken(data.token as string);
    setDetailTokenVisible(false);
    window.dispatchEvent(new CustomEvent("nodes:changed"));
    void load();
  };

  const startEdit = (node: NodeRecord) => {
    setEditingId(node.id);
    setEditingName(node.name);
  };

  const saveEdit = async () => {
    if (!editingId || !editingName.trim()) return;
    await authFetch(`/api/nodes/${editingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: editingName.trim() }) });
    setEditingId(null);
    setEditingName("");
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
      // Keep the list snapshot if detail refresh fails.
    }
  };

  return (
    <div className="flex h-screen bg-canvas">
      <Sidebar activeId={null} onSelect={() => {}} />
      <div className="flex flex-1 flex-col">
        <TopBar title="节点管理" />
        <div className="flex-1 overflow-y-auto p-6">
          <h1 className="mb-4 text-2xl font-semibold">节点管理</h1>
          <button onClick={() => setShowRegister(true)} className="mb-4 rounded-pill bg-ink px-4 py-2 text-sm font-medium text-white">+ 注册节点</button>

          {showRegister && (
            <div className="mb-4 rounded-md border border-hairline p-4">
              <input value={regName} onChange={e => setRegName(e.target.value)} placeholder="节点名称 (留空自动生成)" className="mb-2 w-full rounded border px-3 py-2 text-sm" />
              <div className="flex gap-2">
                <button onClick={() => { void register(); }} className="rounded-pill bg-ink px-4 py-2 text-sm text-white">注册</button>
                <button onClick={() => setShowRegister(false)} className="rounded-pill border px-4 py-2 text-sm">取消</button>
              </div>
            </div>
          )}

          {newToken && (
            <div className="mb-4 rounded-md border border-hairline bg-surface-default p-4">
              <p className="mb-1 text-sm font-medium">节点注册成功</p>
              <p className="mb-2 font-mono text-xs break-all text-ink-secondary">Token: {newToken}</p>
              <p className="text-xs text-ink-muted">启动 Node 时设置环境变量 NODE_TOKEN={newToken}</p>
              <button onClick={() => setNewToken("")} className="mt-2 text-xs text-ink-secondary hover:text-ink">关闭</button>
            </div>
          )}

          {nodes.length === 0 ? (
            <p className="text-sm text-ink-muted">暂无注册节点。点击上方按钮注册第一个渗透 Node。</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {nodes.map((n) => {
                const isPlatform = n.type === "platform";
                const online = n.status === "online";
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => { void openDetail(n); }}
                    className="group flex flex-col rounded-lg border border-hairline bg-canvas p-4 text-left transition-colors hover:border-hairline hover:bg-surface-default"
                  >
                    {/* Header */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          {editingId === n.id ? (
                            <input
                              onClick={(event) => event.stopPropagation()}
                              value={editingName}
                              onChange={(e) => setEditingName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void saveEdit();
                                if (e.key === "Escape") setEditingId(null);
                              }}
                              className="min-w-0 flex-1 rounded border border-hairline px-2 py-1 text-sm"
                            />
                          ) : (
                            <span className="min-w-0 truncate text-base font-semibold text-ink">{n.name}</span>
                          )}
                          <span
                            className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase ${
                              online
                                ? "bg-status-success/15 text-status-success"
                                : "bg-canvas-inset text-ink-muted"
                            }`}
                          >
                            <span className={`h-1.5 w-1.5 rounded-full ${online ? "bg-status-success" : "bg-ink-muted"}`} />
                            {online ? "Online" : "Offline"}
                          </span>
                        </div>
                        <p className="mt-0.5 font-mono text-[11px] text-ink-muted">
                          {isPlatform ? "平台 Agent" : n.type}
                          {n.ip ? ` · ${n.ip}` : ""}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {editingId === n.id ? (
                          <span
                            onClick={(event) => { event.stopPropagation(); void saveEdit(); }}
                            className="cursor-pointer text-xs text-ink-muted hover:text-ink"
                          >
                            保存
                          </span>
                        ) : (
                          <span
                            onClick={(event) => { event.stopPropagation(); startEdit(n); }}
                            className="cursor-pointer text-xs text-ink-muted opacity-0 transition-opacity hover:text-ink group-hover:opacity-100"
                          >
                            改名
                          </span>
                        )}
                        {!isPlatform && (
                          <span
                            onClick={(event) => { event.stopPropagation(); void deleteNode(n.id, n.name); }}
                            className="cursor-pointer text-xs text-ink-muted opacity-0 transition-opacity hover:text-severity-critical group-hover:opacity-100"
                          >
                            删除
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Bottom row: meta left · connectivity right — no middle empty gap */}
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
                        {!isPlatform && (
                          <p className="truncate text-ink-muted">
                            预算 {formatWorkerTimeout(n.worker_max_ms)} · 轮次 {n.worker_max_turns ?? 12} · 重试 {n.worker_max_timeout_retries ?? 2}
                          </p>
                        )}
                        {n.last_failure_reason && (
                          <p className="truncate text-severity-critical" title={n.last_failure_reason}>
                            失败 {n.last_failure_reason}
                          </p>
                        )}
                      </div>
                      <div
                        className="shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <ConnectivityStrip
                          bars={n.connectivity}
                          uptimePct={n.connectivity_uptime_pct}
                        />
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {selectedNode && (
        <NodeDetailDialog
          node={selectedNode}
          token={detailToken || selectedNode.token || ""}
          tokenVisible={detailTokenVisible}
          onToggleToken={() => setDetailTokenVisible(value => !value)}
          onClose={() => setSelectedNode(null)}
          onRegenerateToken={() => { void regenerateToken(selectedNode.id); }}
          onSaved={() => { void load(); }}
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
  const online = node.status === "online";
  const [copied, setCopied] = useState(false);
  const [timeoutSec, setTimeoutSec] = useState(String(Math.round((node.worker_max_ms ?? 300_000) / 1000)));
  const [maxTurns, setMaxTurns] = useState(String(node.worker_max_turns ?? 12));
  const [maxRetries, setMaxRetries] = useState(String(node.worker_max_timeout_retries ?? 2));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveOk, setSaveOk] = useState(false);

  useEffect(() => {
    setTimeoutSec(String(Math.round((node.worker_max_ms ?? 300_000) / 1000)));
    setMaxTurns(String(node.worker_max_turns ?? 12));
    setMaxRetries(String(node.worker_max_timeout_retries ?? 2));
    setSaveError("");
    setSaveOk(false);
  }, [node.id, node.worker_max_ms, node.worker_max_turns, node.worker_max_timeout_retries]);

  const copyToken = async () => {
    if (!token) return;
    await navigator.clipboard?.writeText(token);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const saveWorkerLimits = async () => {
    if (isPlatform) return;
    const sec = Number(timeoutSec);
    const turns = Number(maxTurns);
    const retries = Number(maxRetries);
    if (!Number.isFinite(sec) || sec < 10 || sec > 900) {
      setSaveError("Worker 超时需在 10–900 秒之间");
      return;
    }
    if (!Number.isFinite(turns) || turns < 1 || turns > 40) {
      setSaveError("最大轮次需在 1–40 之间");
      return;
    }
    if (!Number.isFinite(retries) || retries < 0 || retries > 5) {
      setSaveError("超时重试次数需在 0–5 之间");
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

  const taskLabel = taskSummary(node.current_task);
  const taskDetail = node.current_task?.conversation_id
    ? `${taskLabel}\n${node.current_task.conversation_id}`
    : taskLabel;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div
        className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-hairline-soft bg-canvas shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {/* Header: name + status badge + close */}
          <div className="mb-4 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span
                  className={`inline-block shrink-0 rounded-md px-2.5 py-0.5 font-mono text-[11px] font-medium uppercase ${
                    online ? "bg-status-success/15 text-status-success" : "bg-canvas-inset text-ink-muted"
                  }`}
                >
                  {online ? "Online" : "Offline"}
                </span>
                <h2 className="min-w-0 break-words text-xl font-semibold">{node.name}</h2>
              </div>
              <p className="mt-1 break-all font-mono text-[11px] text-ink-muted">{node.id}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-md border border-hairline px-3 py-1.5 text-xs hover:bg-surface-default"
            >
              关闭
            </button>
          </div>

          {/* Row 1: type · IP · status · sessions */}
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <InfoCard label="类型" value={isPlatform ? "平台 Agent" : node.type} />
            <InfoCard label="IP" value={node.ip || "—"} mono />
            <InfoCard label="状态" value={online ? "在线" : "离线"} />
            <InfoCard label="关联会话数" value={String(node.current_sessions ?? 0)} mono />
          </section>

          {/* Row 2: current task · heartbeat · failure · registered */}
          <section className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <InfoCard
              label="当前任务"
              value={taskDetail}
              className="sm:col-span-2 lg:col-span-1"
              title={taskDetail}
            />
            <InfoCard label="最近心跳" value={formatDate(node.last_heartbeat)} />
            <InfoCard
              label="最近失败"
              value={node.last_failure_reason || "—"}
              tone={node.last_failure_reason ? "danger" : "default"}
              title={node.last_failure_reason || undefined}
            />
            <InfoCard label="注册时间" value={formatDate(node.registered_at)} />
          </section>

          {/* Config cards */}
          <section className="mt-5 space-y-3">
            <h3 className="text-xs font-semibold uppercase text-ink-secondary">节点配置</h3>

            {/* Token */}
            <div className="rounded-md border border-hairline-soft p-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-ink">Token</p>
                {!isPlatform && (
                  <button
                    type="button"
                    title="刷新 Token"
                    onClick={onRegenerateToken}
                    className="inline-flex items-center gap-1.5 rounded-md border border-hairline px-2.5 py-1 text-xs text-ink-secondary hover:bg-surface-default hover:text-ink"
                  >
                    <RefreshCw size={13} />
                    刷新
                  </button>
                )}
              </div>
              {isPlatform ? (
                <p className="text-xs text-ink-muted">内置平台节点，无需 Token。</p>
              ) : (
                <>
                  <div className="flex min-w-0 items-start gap-2">
                    <button
                      type="button"
                      title={token ? "复制 Token" : "当前 Token 明文不可用"}
                      onClick={() => { void copyToken(); }}
                      className="group flex min-w-0 flex-1 items-start gap-2 rounded-md bg-canvas-inset px-3 py-2.5 text-left font-mono text-xs text-ink-secondary hover:text-ink"
                    >
                      <span className="min-w-0 flex-1 break-all">
                        {token ? (tokenVisible ? token : maskToken(token)) : maskTokenPlaceholder()}
                      </span>
                      {token && (
                        copied
                          ? <Check size={14} className="mt-0.5 shrink-0 text-status-success" />
                          : <Copy size={14} className="mt-0.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                      )}
                    </button>
                    {token && (
                      <button
                        type="button"
                        title={tokenVisible ? "隐藏 Token" : "显示 Token"}
                        onClick={onToggleToken}
                        className="shrink-0 rounded-md border border-hairline p-2 text-ink-muted hover:bg-surface-default hover:text-ink"
                      >
                        {tokenVisible ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                    {copied && <span className="text-status-success">已复制</span>}
                    <span>刷新后旧连接会断开，需用新 Token 重启节点。</span>
                  </div>
                </>
              )}
            </div>

            {/* Worker budget */}
            {!isPlatform && (
              <div className="rounded-md border border-hairline-soft p-4">
                <p className="text-sm font-medium text-ink">Worker 运行预算</p>
                <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                  子 Agent 包的墙钟超时、工具轮次上限，以及超时后主 Agent 可重试次数。保存后对<strong>新任务</strong>生效。
                </p>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <label className="block space-y-1.5">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">超时（秒）</span>
                    <input
                      type="number"
                      min={10}
                      max={900}
                      value={timeoutSec}
                      onChange={(e) => { setTimeoutSec(e.target.value); setSaveOk(false); }}
                      className="w-full rounded-md border border-hairline bg-canvas px-2.5 py-2 font-mono text-sm focus:border-hairline focus:outline-none"
                    />
                    <span className="block text-[10px] text-ink-muted">10–900</span>
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">最大轮次</span>
                    <input
                      type="number"
                      min={1}
                      max={40}
                      value={maxTurns}
                      onChange={(e) => { setMaxTurns(e.target.value); setSaveOk(false); }}
                      className="w-full rounded-md border border-hairline bg-canvas px-2.5 py-2 font-mono text-sm focus:border-hairline focus:outline-none"
                    />
                    <span className="block text-[10px] text-ink-muted">1–40</span>
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">超时重试</span>
                    <input
                      type="number"
                      min={0}
                      max={5}
                      value={maxRetries}
                      onChange={(e) => { setMaxRetries(e.target.value); setSaveOk(false); }}
                      className="w-full rounded-md border border-hairline bg-canvas px-2.5 py-2 font-mono text-sm focus:border-hairline focus:outline-none"
                    />
                    <span className="block text-[10px] text-ink-muted">0–5</span>
                  </label>
                </div>
              </div>
            )}
          </section>
        </div>

        {/* Footer: full-bleed divider edge-to-edge */}
        {!isPlatform && (
          <div className="shrink-0 border-t border-hairline-soft px-6 py-4">
            <div className="flex flex-wrap items-center justify-end gap-3">
              {saveOk && <span className="text-xs text-status-success">已保存</span>}
              {saveError && <span className="text-xs text-severity-critical">{saveError}</span>}
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-hairline px-3 py-1.5 text-xs hover:bg-surface-default"
              >
                取消
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => { void saveWorkerLimits(); }}
                className="rounded-md bg-ink px-4 py-1.5 text-xs font-medium text-white disabled:opacity-60"
              >
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function formatWorkerTimeout(ms?: number | null): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "300s";
  return `${Math.round(n / 1000)}s`;
}

/**
 * Packy/uptime-style connectivity bars (last 24h).
 * Green = up, red = down, muted = no data.
 */
function ConnectivityStrip({
  bars,
  uptimePct,
}: {
  bars?: ConnectivityBar[];
  uptimePct?: number | null;
}) {
  const items = bars?.length ? bars : Array.from({ length: 30 }, () => ({
    status: "unknown" as const,
    from_at: "",
    to_at: "",
  }));

  const pctLabel =
    uptimePct != null && Number.isFinite(uptimePct) ? `${uptimePct}%` : "—";

  return (
    <div className="flex flex-col items-end gap-1" title="近 24 小时连通性">
      <div
        className="flex h-7 items-end gap-px"
        role="img"
        aria-label={`近 24 小时连通性 ${pctLabel}`}
      >
        {items.map((bar, i) => {
          const status = String(bar.status || "unknown");
          const color =
            status === "up"
              ? "bg-status-success"
              : status === "down"
                ? "bg-severity-critical/80"
                : "bg-ink-muted/25";
          const tip = bar.from_at
            ? `${formatBarRange(bar.from_at, bar.to_at)} · ${statusLabel(status)}`
            : statusLabel(status);
          return (
            <span
              key={`${bar.from_at || "x"}-${i}`}
              title={tip}
              className={`w-[3px] rounded-[1px] transition-opacity hover:opacity-80 ${color}`}
              style={{ height: status === "unknown" ? "40%" : "100%" }}
            />
          );
        })}
      </div>
      <div className="flex items-center gap-1.5 font-mono text-[10px] text-ink-muted">
        <span>24h</span>
        <span className="text-ink-secondary">{pctLabel}</span>
      </div>
    </div>
  );
}

function statusLabel(status: string): string {
  if (status === "up") return "在线";
  if (status === "down") return "离线";
  return "无数据";
}

function formatBarRange(fromAt: string, toAt: string): string {
  const a = formatShortTime(fromAt);
  const b = formatShortTime(toAt);
  if (a === "—" && b === "—") return "";
  return `${a} – ${b}`;
}

function formatShortTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

function taskSummary(task?: NodeRecord["current_task"]): string {
  if (!task) return "—";
  const target = task.target ? ` · ${task.target}` : "";
  return `${task.title || task.conversation_id}${target}`;
}

function maskTokenPlaceholder(): string {
  return "*".repeat(32);
}

function maskToken(value: string): string {
  if (value.length <= 12) return "*".repeat(value.length);
  return `${value.slice(0, 6)}${"*".repeat(Math.min(24, Math.max(8, value.length - 12)))}${value.slice(-6)}`;
}

/** Mini info tile — same spirit as Finding detail Info cells. */
function InfoCard({
  label,
  value,
  mono,
  tone = "default",
  className = "",
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: "default" | "danger";
  className?: string;
  title?: string;
}) {
  const valueClass =
    tone === "danger"
      ? "text-severity-critical"
      : "text-ink";
  return (
    <div className={`rounded-md bg-canvas-inset p-2.5 ${className}`} title={title}>
      <div className="text-xs text-ink-muted">{label}</div>
      <div
        className={`mt-1 line-clamp-3 break-words text-xs ${mono ? "font-mono" : ""} ${valueClass}`}
      >
        {value || "—"}
      </div>
    </div>
  );
}

function formatDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}