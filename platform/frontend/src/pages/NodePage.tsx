import { ApiError, authFetch } from "../lib/api";
import { useState, useEffect, useMemo, type ReactNode } from "react";
import { Check, Copy, Eye, EyeOff, RefreshCw } from "lucide-react";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";
import {
  EXTENSION_PACKS,
  effectiveOffers,
  expertLabel,
  expertMeta,
  type ExpertId,
} from "../lib/experts";

const STATUS_FILTERS = ["全部", "online", "offline"] as const;

type ConnectivityBar = {
  status: "up" | "down" | "unknown" | string;
  from_at: string;
  to_at: string;
};

/** Optional runtime version info reported by the node. */
type NodeCapabilities = {
  runtime?: string;
  version?: string;
};

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
  /** Installed expert pack ids (default effective: ["pentest"]). */
  offers?: string[] | null;
};

export default function NodePage() {
  const [nodes, setNodes] = useState<NodeRecord[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>("全部");
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
    // Worker nodes only (backend also filters); hide any legacy platform agent rows.
    const workers = data.filter((n) => n.type !== "platform" && n.id !== "00000000-0000-0000-0000-000000000001");
    setNodes(workers);
    setSelectedNode((current) => (current ? workers.find((n) => n.id === current.id) || null : null));
  };
  useEffect(() => {
    void load();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return nodes.filter((n) => {
      if (statusFilter !== "全部" && n.status !== statusFilter) return false;
      if (!q) return true;
      const offers = effectiveOffers(n.offers).join(" ");
      const hay = `${n.name} ${n.ip || ""} ${offers} ${taskSummary(n.current_task)}`.toLowerCase();
      return hay.includes(q);
    });
  }, [nodes, search, statusFilter]);

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
    try {
      await authFetch(`/api/nodes/${id}`, { method: "DELETE" });
      if (selectedNode?.id === id) setSelectedNode(null);
      window.dispatchEvent(new Event("nodes:changed"));
      window.dispatchEvent(new Event("experts:changed"));
      void load();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "删除节点失败");
    }
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
              placeholder="搜索节点名称、IP…"
              className="rounded-md border border-hairline px-3 py-2 text-sm focus:border-ink focus:outline-none"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as (typeof STATUS_FILTERS)[number])}
              className="rounded-md border border-hairline px-3 py-2 text-sm"
            >
              {STATUS_FILTERS.map((s) => (
                <option key={s} value={s}>
                  {s === "全部" ? "全部状态" : s === "online" ? "在线" : "离线"}
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
                const packs = isPlatform ? [] : effectiveOffers(n.offers);
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
                          <OnlineBadge online={online} />
                          <span className="min-w-0 truncate text-base font-semibold text-ink">{n.name}</span>
                        </div>
                        <p className="mt-1 font-mono text-xs text-ink-secondary">
                          {n.ip || (isPlatform ? "平台内置" : "—")}
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
                      <div className="min-w-0 flex-1 space-y-1.5 text-xs text-ink-secondary">
                        <p>
                          <span className="text-ink-muted">注册 </span>
                          <span className="text-ink">{formatDate(n.registered_at)}</span>
                        </p>
                        <p>
                          <span className="text-ink-muted">心跳 </span>
                          <span className="text-ink">{formatDate(n.last_heartbeat)}</span>
                        </p>
                        {!isPlatform && (
                          <p className="flex flex-wrap items-center gap-1 pt-0.5">
                            <span className="text-ink-muted">专家包 </span>
                            {packs.length === 0 ? (
                              <span className="text-ink-muted">—</span>
                            ) : (
                              packs.map((pack) => (
                                <span
                                  key={pack}
                                  className="rounded-pill border border-hairline bg-canvas-inset px-1.5 py-px text-[10px] text-ink"
                                >
                                  {expertLabel(pack)}
                                </span>
                              ))
                            )}
                          </p>
                        )}
                      </div>
                      {!isPlatform && (
                        <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
                          <ConnectivityStrip bars={n.connectivity} uptimePct={n.connectivity_uptime_pct} />
                        </div>
                      )}
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
  const [expertBusy, setExpertBusy] = useState<string | null>(null);
  const [expertError, setExpertError] = useState("");
  const [localOffers, setLocalOffers] = useState<ExpertId[]>(() => effectiveOffers(node.offers));
  /** Physical node: 概述 / 配置 / 扩展（装包）. Skills live on Expert 名片. */
  type DetailTab = "overview" | "config" | "extensions";
  const [detailTab, setDetailTab] = useState<DetailTab>("overview");

  const caps = normalizeCapabilities(node.capabilities);

  const detailTabs: { key: DetailTab; label: string; count?: number }[] = [
    { key: "overview", label: "概述" },
    ...(!isPlatform
      ? [
          { key: "config" as const, label: "配置" },
          { key: "extensions" as const, label: "扩展", count: localOffers.length },
        ]
      : []),
  ];
  const activeDetailTab = detailTabs.some((t) => t.key === detailTab)
    ? detailTab
    : (detailTabs[0]?.key ?? "overview");
  const showSave = isPentest && activeDetailTab === "config";

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
    setExpertError("");
    setExpertBusy(null);
    setLocalOffers(effectiveOffers(node.offers));
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
    node.offers,
  ]);

  const installExpert = async (expertId: ExpertId) => {
    setExpertBusy(expertId);
    setExpertError("");
    try {
      const res = await authFetch<{ offers?: string[] }>(`/api/nodes/${node.id}/experts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expert_id: expertId }),
      });
      setLocalOffers(effectiveOffers(res.offers ?? [...localOffers, expertId]));
      window.dispatchEvent(new Event("nodes:changed"));
      onSaved();
    } catch (e) {
      setExpertError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "安装失败");
    } finally {
      setExpertBusy(null);
    }
  };

  const uninstallExpert = async (expertId: ExpertId) => {
    if (localOffers.length <= 1) {
      setExpertError("节点至少保留一个专家包");
      return;
    }
    setExpertBusy(expertId);
    setExpertError("");
    try {
      const res = await authFetch<{ offers?: string[] }>(
        `/api/nodes/${node.id}/experts/${encodeURIComponent(expertId)}`,
        { method: "DELETE" },
      );
      setLocalOffers(effectiveOffers(res.offers));
      window.dispatchEvent(new Event("nodes:changed"));
      onSaved();
    } catch (e) {
      setExpertError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "卸载失败");
    } finally {
      setExpertBusy(null);
    }
  };

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-6" onClick={onClose}>
      <div
        className="flex max-h-[min(88vh,840px)] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-hairline-soft bg-canvas shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header: status + name */}
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
                  !isPlatform && (
                    <button
                      type="button"
                      onClick={() => setEditingName(true)}
                      className="text-xs text-ink-muted opacity-0 transition-opacity hover:text-ink group-hover/title:opacity-100"
                    >
                      改名
                    </button>
                  )
                )}
              </div>
              <p className="mt-1 font-mono text-sm text-ink-secondary">
                {node.ip || (isPlatform ? "平台内置" : "—")}
              </p>
            </div>
            <button type="button" onClick={onClose} className="rounded-md border border-hairline px-3 py-1.5 text-xs">
              关闭
            </button>
          </div>
        </div>

        {/* Tabs: 概述 | 配置 | 扩展 */}
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

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {activeDetailTab === "overview" && (
            <div className="space-y-4">
              <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <InfoCard label="IP" value={node.ip || (isPlatform ? "平台内置" : "—")} mono />
                <InfoCard label="最近心跳" value={formatDate(node.last_heartbeat)} />
                <InfoCard label="注册时间" value={formatDate(node.registered_at)} />
              </section>

              {!isPlatform && (
                <section className="rounded-md border border-hairline-soft p-4">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">已安装专家包</p>
                    <button
                      type="button"
                      onClick={() => setDetailTab("extensions")}
                      className="text-xs text-ink-secondary underline-offset-2 hover:underline"
                    >
                      管理 →
                    </button>
                  </div>
                  {localOffers.length === 0 ? (
                    <p className="text-xs text-ink-muted">
                      内置 default 可用；暂无已装拓展包
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {localOffers.map((pack) => {
                        const meta = expertMeta(pack);
                        return (
                          <div
                            key={pack}
                            className="rounded-md border border-hairline bg-canvas-inset/50 px-3 py-2"
                            title={meta?.description}
                          >
                            <p className="text-sm font-medium text-ink">{expertLabel(pack)}</p>
                            <p className="mt-0.5 font-mono text-[10px] text-ink-muted">{pack}</p>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              )}

              {!isPlatform && node.last_failure_reason ? (
                <InfoCard
                  label="最近失败"
                  value={node.last_failure_reason}
                  tone="danger"
                  title={node.last_failure_reason}
                />
              ) : null}

              {(caps?.runtime || caps?.version) && (
                <p className="font-mono text-[11px] text-ink-muted">
                  {[caps.runtime, caps.version].filter(Boolean).join(" · ")}
                </p>
              )}
            </div>
          )}

          {activeDetailTab === "config" && (
            <div className="space-y-4">
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

              {isPentest ? (
                <>
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
                    <p className="mt-1 text-xs text-ink-muted">整任务主会话墙钟与工具轮次上限。</p>
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
                </>
              ) : (
                <p className="text-xs text-ink-muted">此节点类型无可调运行预算。</p>
              )}
            </div>
          )}

          {activeDetailTab === "extensions" && !isPlatform && (
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium">扩展包</p>
                <p className="mt-1 text-xs text-ink-muted">
                  Node 内置通用助理（default），无需安装。此处只管理拓展能力包（渗透/CTF 等）。装好后去「专家管理」创建专家并绑定本节点。
                </p>
              </div>
              {expertError && (
                <p className="rounded-md border border-status-error/30 bg-status-error/5 px-3 py-2 text-xs text-status-error">
                  {expertError}
                </p>
              )}
              <ul className="space-y-3">
                {EXTENSION_PACKS.map((pack) => {
                  const installed = localOffers.includes(pack.id);
                  const busy = expertBusy === pack.id;
                  return (
                    <li
                      key={pack.id}
                      className="flex flex-col gap-3 rounded-md border border-hairline-soft p-4 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-ink">{pack.label}</span>
                          <span className="font-mono text-[11px] text-ink-muted">{pack.id}</span>
                          {installed ? (
                            <span className="rounded-pill bg-status-success/10 px-1.5 py-px text-[10px] text-status-success">
                              已安装
                            </span>
                          ) : (
                            <span className="rounded-pill border border-hairline px-1.5 py-px text-[10px] text-ink-muted">
                              未安装
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-xs text-ink-secondary">{pack.description}</p>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        {installed ? (
                          <button
                            type="button"
                            disabled={busy}
                            title={`卸载 ${pack.label}`}
                            onClick={() => void uninstallExpert(pack.id)}
                            className="rounded-md border border-hairline px-3 py-1.5 text-xs text-ink-secondary hover:bg-surface-default disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {busy ? "处理中…" : "卸载"}
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void installExpert(pack.id)}
                            className="rounded-md bg-ink px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {busy ? "处理中…" : "安装"}
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <p className="text-[11px] text-ink-muted">
                内置：
                <span className="ml-1 font-mono text-ink">default</span>
                {" · "}
                已装拓展：
                <span className="ml-1 font-mono text-ink">
                  {localOffers.join(", ") || "（无）"}
                </span>
              </p>
            </div>
          )}
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

function normalizeCapabilities(raw: unknown): NodeCapabilities | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  return {
    runtime: typeof o.runtime === "string" ? o.runtime : undefined,
    version: typeof o.version === "string" ? o.version : undefined,
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
