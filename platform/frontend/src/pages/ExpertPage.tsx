/**
 * Expert management — virtual personas bound to physical Nodes.
 * Cards mirror Node page; detail: 概述 / 配置 / 能力.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Plus, RefreshCw } from "lucide-react";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";
import { ApiError, authFetch } from "../lib/api";
import {
  EXPERT_PACKS,
  expertCreatePackOptions,
  DEFAULT_EXPERT_ID,
  effectiveOffers,
  expertLabel,
  expertMeta,
  packCapabilities,
  type ExpertId,
} from "../lib/experts";

type NodeRow = {
  id: string;
  name: string;
  type: string;
  status: string;
  offers?: string[] | null;
};

type ExpertRow = {
  id: string;
  name: string;
  display_name?: string;
  pack_id: string;
  node_id: string;
  node_name?: string | null;
  node_status?: string | null;
  node_offers?: string[] | null;
  description?: string | null;
  enabled: boolean;
  created_at?: string | null;
};

export default function ExpertPage() {
  const [experts, setExperts] = useState<ExpertRow[]>([]);
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [packFilter, setPackFilter] = useState<string>("全部");
  const [selected, setSelected] = useState<ExpertRow | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const workerNodes = useMemo(
    () => nodes.filter((n) => n.type !== "platform"),
    [nodes],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [expertRows, nodeRows] = await Promise.all([
        authFetch<ExpertRow[]>("/api/experts"),
        authFetch<NodeRow[]>("/api/nodes"),
      ]);
      const list = Array.isArray(expertRows) ? expertRows : [];
      setExperts(list);
      setNodes(Array.isArray(nodeRows) ? nodeRows : []);
      setSelected((cur) => (cur ? list.find((e) => e.id === cur.id) || null : null));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onChange = () => {
      void load();
    };
    window.addEventListener("nodes:changed", onChange);
    window.addEventListener("experts:changed", onChange);
    return () => {
      window.removeEventListener("nodes:changed", onChange);
      window.removeEventListener("experts:changed", onChange);
    };
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return experts.filter((e) => {
      if (packFilter !== "全部" && e.pack_id !== packFilter) return false;
      if (!q) return true;
      const hay = `${e.name} ${e.pack_id} ${e.node_name || ""} ${e.description || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [experts, search, packFilter]);

  const deleteExpert = async (id: string, name: string) => {
    if (!window.confirm(`确定删除专家 @${name}？对话中将无法再 @ 此专家。`)) return;
    try {
      await authFetch(`/api/experts/${id}`, { method: "DELETE" });
      if (selected?.id === id) setSelected(null);
      window.dispatchEvent(new Event("experts:changed"));
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "删除失败");
    }
  };

  return (
    <div className="flex h-screen bg-canvas">
      <Sidebar activeId={null} onSelect={() => {}} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar title="专家管理" />
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索专家名、节点、说明…"
              className="rounded-md border border-hairline px-3 py-2 text-sm focus:border-ink focus:outline-none"
            />
            <select
              value={packFilter}
              onChange={(e) => setPackFilter(e.target.value)}
              className="rounded-md border border-hairline px-3 py-2 text-sm"
            >
              <option value="全部">全部能力包</option>
              {EXPERT_PACKS.filter((p) => p.id !== "consult").map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex items-center gap-1.5 rounded-md border border-hairline px-3 py-2 text-sm text-ink-secondary hover:bg-surface-default"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              刷新
            </button>
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="inline-flex items-center gap-1.5 rounded-md bg-ink px-4 py-2 text-sm font-medium text-white"
            >
              <Plus className="h-4 w-4" />
              创建专家
            </button>
          </div>

          {error && <p className="mb-3 text-sm text-severity-critical">{error}</p>}

          {loading ? (
            <p className="text-sm text-ink-muted">加载中…</p>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-ink-muted">
              {experts.length === 0
                ? "暂无专家。点击「创建专家」添加名片，对话里即可 @ 路由。"
                : "没有匹配的专家，请调整搜索或筛选。"}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {filtered.map((e) => {
                const online = e.node_status === "online";
                const caps = packCapabilities(e.pack_id);
                return (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => setSelected(e)}
                    className="group flex flex-col rounded-lg border border-hairline bg-canvas p-4 text-left transition-colors hover:bg-surface-default"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="min-w-0 truncate text-base font-semibold text-ink">
                            {e.name}
                          </span>
                          <NodeOnlineBadge online={online} />
                          {!e.enabled && (
                            <span className="rounded-md bg-canvas-inset px-1.5 py-0.5 text-[10px] text-ink-muted">
                              已禁用
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 truncate text-sm text-ink-secondary">
                          {expertLabel(e.pack_id)}
                        </p>
                      </div>
                      <span
                        onClick={(ev) => {
                          ev.stopPropagation();
                          void deleteExpert(e.id, e.name);
                        }}
                        className="shrink-0 cursor-pointer text-xs text-ink-muted opacity-0 transition-opacity hover:text-severity-critical group-hover:opacity-100"
                      >
                        删除
                      </span>
                    </div>
                    <div className="mt-4 space-y-1 text-xs text-ink-secondary">
                      <p>
                        <span className="text-ink-muted">能力包 </span>
                        <span className="rounded-pill border border-hairline bg-canvas-inset px-1.5 py-px font-medium text-ink">
                          {expertLabel(e.pack_id)}
                        </span>
                        <span className="ml-1 font-mono text-[10px] text-ink-muted">{e.pack_id}</span>
                      </p>
                      <p className="truncate">
                        <span className="text-ink-muted">物理节点 </span>
                        <span className="font-medium text-ink">{e.node_name || e.node_id.slice(0, 8)}</span>
                      </p>
                      <p className="text-ink-muted">
                        技能 {caps.skills.length} · 工具 {caps.tools.length}
                      </p>
                      {e.description ? (
                        <p className="truncate pt-0.5 text-ink-muted" title={e.description}>
                          {e.description}
                        </p>
                      ) : null}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {showCreate && (
        <CreateExpertDialog
          nodes={workerNodes}
          onClose={() => setShowCreate(false)}
          onCreated={async () => {
            setShowCreate(false);
            window.dispatchEvent(new Event("experts:changed"));
            await load();
          }}
        />
      )}

      {selected && (
        <ExpertDetailDialog
          expert={selected}
          nodes={workerNodes}
          onClose={() => setSelected(null)}
          onSaved={async () => {
            window.dispatchEvent(new Event("experts:changed"));
            await load();
          }}
          onDeleted={async () => {
            setSelected(null);
            window.dispatchEvent(new Event("experts:changed"));
            await load();
          }}
        />
      )}
    </div>
  );
}

function CreateExpertDialog({
  nodes,
  onClose,
  onCreated,
}: {
  nodes: NodeRow[];
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [nodeId, setNodeId] = useState(nodes[0]?.id || "");
  const [packId, setPackId] = useState<ExpertId>(DEFAULT_EXPERT_ID);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");

  const selectedNode = nodes.find((n) => n.id === nodeId) || null;
  const packOptions = useMemo(() => {
    const offers = effectiveOffers(selectedNode?.offers);
    return expertCreatePackOptions(selectedNode?.offers).map((p) => ({
      ...p,
      installed: p.id === "default" || offers.includes(p.id),
    }));
  }, [selectedNode]);

  useEffect(() => {
    const allowed = new Set(packOptions.map((p) => p.id));
    if (!allowed.has(packId) && packOptions.length > 0) {
      setPackId(packOptions[0]!.id as ExpertId);
    }
  }, [selectedNode, packId, packOptions]);

  const submit = async () => {
    setFormError("");
    setBusy(true);
    try {
      const n = name.trim();
      await authFetch("/api/experts", {
        method: "POST",
        body: JSON.stringify({
          name: n,
          display_name: n,
          pack_id: packId,
          node_id: nodeId,
          description: description.trim() || undefined,
        }),
      });
      await onCreated();
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SimpleDialog
      title="创建专家"
      description="名称即对话中的 @ 路由名。通用助理（default）内置；其他能力包须先在节点「扩展」中安装。"
      confirmLabel={busy ? "创建中…" : "创建"}
      confirming={busy}
      error={formError}
      onClose={() => !busy && onClose()}
      onConfirm={() => void submit()}
      confirmDisabled={
        busy ||
        !name.trim() ||
        !nodeId ||
        !packOptions.some((p) => p.id === packId && p.installed)
      }
    >
      {nodes.length === 0 ? (
        <p className="text-sm text-ink-muted">
          尚无工作节点。请先在{" "}
          <Link to="/nodes" className="font-medium text-ink underline">
            节点管理
          </Link>{" "}
          注册并启动 Node。
        </p>
      ) : (
        <div className="space-y-3">
          <label className="block text-xs text-ink-secondary">
            名称（必填，支持中英文）
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="渗透专家"
              className="mt-1 w-full rounded-md border border-hairline bg-canvas px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
            />
          </label>
          <label className="block text-xs text-ink-secondary">
            绑定物理节点
            <select
              value={nodeId}
              onChange={(e) => setNodeId(e.target.value)}
              className="mt-1 w-full rounded-md border border-hairline bg-canvas px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
            >
              {nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name} ({n.status}) — 内置 default
                  {effectiveOffers(n.offers).length
                    ? ` + ${effectiveOffers(n.offers).join(", ")}`
                    : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-ink-secondary">
            能力包
            <select
              value={packId}
              onChange={(e) => setPackId(e.target.value as ExpertId)}
              className="mt-1 w-full rounded-md border border-hairline bg-canvas px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
            >
              {packOptions.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.installed}>
                  {p.label}
                  {!p.installed ? "（节点未安装）" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-ink-secondary">
            说明（可选）
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="例：DVWA 常规 Web 渗透"
              className="mt-1 w-full rounded-md border border-hairline bg-canvas px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
            />
          </label>
        </div>
      )}
    </SimpleDialog>
  );
}

function ExpertDetailDialog({
  expert,
  nodes,
  onClose,
  onSaved,
  onDeleted,
}: {
  expert: ExpertRow;
  nodes: NodeRow[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onDeleted: () => void | Promise<void>;
}) {
  type DetailTab = "overview" | "config" | "capabilities";
  const [detailTab, setDetailTab] = useState<DetailTab>("overview");
  const [nameDraft, setNameDraft] = useState(expert.name);
  const [nodeId, setNodeId] = useState(expert.node_id);
  const [packId, setPackId] = useState(expert.pack_id);
  const [description, setDescription] = useState(expert.description || "");
  const [enabled, setEnabled] = useState(expert.enabled);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveOk, setSaveOk] = useState(false);

  useEffect(() => {
    setNameDraft(expert.name);
    setNodeId(expert.node_id);
    setPackId(expert.pack_id);
    setDescription(expert.description || "");
    setEnabled(expert.enabled);
    setSaveError("");
    setSaveOk(false);
    setDetailTab("overview");
  }, [expert.id, expert.name, expert.node_id, expert.pack_id, expert.description, expert.enabled]);

  const selectedNode = nodes.find((n) => n.id === nodeId) || null;
  const packOptions = useMemo(() => {
    const offers = effectiveOffers(selectedNode?.offers ?? expert.node_offers);
    return expertCreatePackOptions(selectedNode?.offers ?? expert.node_offers).map((p) => ({
      ...p,
      installed: p.id === "default" || offers.includes(p.id),
    }));
  }, [selectedNode, expert.node_offers]);

  const caps = packCapabilities(packId);
  const pack = expertMeta(packId);
  const online = expert.node_status === "online";

  const detailTabs: { key: DetailTab; label: string; count?: number }[] = [
    { key: "overview", label: "概述" },
    { key: "config", label: "配置" },
    {
      key: "capabilities",
      label: "能力",
      count: caps.skills.length + caps.tools.length,
    },
  ];

  const save = async () => {
    setSaving(true);
    setSaveError("");
    setSaveOk(false);
    try {
      const n = nameDraft.trim();
      await authFetch(`/api/experts/${expert.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: n,
          display_name: n,
          node_id: nodeId,
          pack_id: packId,
          description: description.trim() || null,
          enabled,
        }),
      });
      setSaveOk(true);
      await onSaved();
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`确定删除专家 @${expert.name}？`)) return;
    try {
      await authFetch(`/api/experts/${expert.id}`, { method: "DELETE" });
      await onDeleted();
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "删除失败");
    }
  };

  const showSave = detailTab === "config";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-6" onClick={onClose}>
      <div
        className="flex max-h-[min(88vh,840px)] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-hairline-soft bg-canvas shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-6 pt-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <NodeOnlineBadge online={online} />
                <h2 className="truncate text-lg font-semibold text-ink">{expert.name}</h2>
                <span className="rounded-pill border border-hairline bg-canvas-inset px-2 py-0.5 text-xs text-ink">
                  {expertLabel(expert.pack_id)}
                </span>
              </div>
              <p className="mt-1 text-sm text-ink-secondary">
                节点 {expert.node_name || expert.node_id.slice(0, 8)}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-hairline px-2.5 py-1 text-xs text-ink-secondary hover:bg-surface-default"
            >
              关闭
            </button>
          </div>
          <div className="mt-4 flex gap-4 border-b border-hairline-soft">
            {detailTabs.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setDetailTab(t.key)}
                className={`px-0.5 py-2.5 text-[13px] font-medium transition-colors ${
                  detailTab === t.key
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
          {detailTab === "overview" && (
            <div className="space-y-4">
              <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <InfoCard label="名称" value={expert.name} />
                <InfoCard label="能力包" value={expertLabel(expert.pack_id)} />
                <InfoCard
                  label="状态"
                  value={expert.enabled ? (online ? "可用（节点在线）" : "节点离线") : "已禁用"}
                />
              </section>
              <section className="grid gap-3 sm:grid-cols-2">
                <InfoCard label="物理节点" value={expert.node_name || expert.node_id} />
                <InfoCard label="节点状态" value={expert.node_status || "—"} />
              </section>
              {expert.description ? (
                <section className="rounded-md border border-hairline-soft p-4">
                  <p className="text-sm font-medium">说明</p>
                  <p className="mt-1 text-sm text-ink-secondary">{expert.description}</p>
                </section>
              ) : null}
              <section className="rounded-md border border-hairline-soft p-4">
                <p className="text-sm font-medium">能力摘要</p>
                <p className="mt-1 text-xs text-ink-muted">
                  来自能力包 <span className="font-mono text-ink">{packId}</span>
                  {pack ? ` — ${pack.description}` : ""}
                </p>
                <p className="mt-2 text-sm text-ink-secondary">
                  技能 {caps.skills.length} · 工具 {caps.tools.length}
                  <button
                    type="button"
                    onClick={() => setDetailTab("capabilities")}
                    className="ml-2 text-xs text-ink underline-offset-2 hover:underline"
                  >
                    查看详情 →
                  </button>
                </p>
              </section>
              <p className="text-xs text-ink-muted">
                对话中 @ 或选择「{expert.name}」即可路由到绑定节点并带上该能力包。
              </p>
            </div>
          )}

          {detailTab === "config" && (
            <div className="space-y-4">
              <p className="text-xs text-ink-muted">
                修改名称、绑定节点与能力包。通用助理（default）内置；其他能力包须先在节点「扩展」中安装。
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-xs text-ink-secondary sm:col-span-2">
                  名称
                  <input
                    value={nameDraft}
                    onChange={(e) => {
                      setNameDraft(e.target.value);
                      setSaveOk(false);
                    }}
                    className="mt-1 w-full rounded-md border border-hairline bg-canvas px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
                  />
                </label>
                <label className="block text-xs text-ink-secondary">
                  绑定物理节点
                  <select
                    value={nodeId}
                    onChange={(e) => {
                      setNodeId(e.target.value);
                      setSaveOk(false);
                    }}
                    className="mt-1 w-full rounded-md border border-hairline bg-canvas px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
                  >
                    {nodes.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.name} ({n.status})
                      </option>
                    ))}
                    {!nodes.some((n) => n.id === nodeId) && (
                      <option value={nodeId}>
                        {expert.node_name || nodeId}（当前）
                      </option>
                    )}
                  </select>
                </label>
                <label className="block text-xs text-ink-secondary">
                  能力包
                  <select
                    value={packId}
                    onChange={(e) => {
                      setPackId(e.target.value);
                      setSaveOk(false);
                    }}
                    className="mt-1 w-full rounded-md border border-hairline bg-canvas px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
                  >
                    {packOptions.map((p) => (
                      <option key={p.id} value={p.id} disabled={!p.installed && p.id !== packId}>
                        {p.label}
                        {!p.installed ? "（节点未安装）" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-xs text-ink-secondary sm:col-span-2">
                  说明
                  <input
                    value={description}
                    onChange={(e) => {
                      setDescription(e.target.value);
                      setSaveOk(false);
                    }}
                    className="mt-1 w-full rounded-md border border-hairline bg-canvas px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
                  />
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-secondary sm:col-span-2">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => {
                      setEnabled(e.target.checked);
                      setSaveOk(false);
                    }}
                    className="rounded border-hairline"
                  />
                  启用（禁用后不可在对话中选用）
                </label>
              </div>
              <button
                type="button"
                onClick={() => void remove()}
                className="text-xs text-severity-critical underline-offset-2 hover:underline"
              >
                删除此专家
              </button>
            </div>
          )}

          {detailTab === "capabilities" && (
            <div className="space-y-5">
              <p className="text-xs text-ink-muted">
                能力来自专家绑定的能力包（catalog），不是节点硬件属性。换包或换节点后以包定义为准。
              </p>
              <section>
                <p className="mb-2 text-sm font-medium">
                  技能 <span className="font-normal text-ink-muted">{caps.skills.length}</span>
                </p>
                {caps.skills.length === 0 ? (
                  <p className="text-xs text-ink-muted">此包无 skill 条目。</p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {caps.skills.map((s) => (
                      <div
                        key={s.id}
                        className="rounded-md border border-hairline-soft bg-canvas-inset/40 px-3 py-2.5"
                      >
                        <div className="flex min-w-0 items-baseline justify-between gap-2">
                          <p className="truncate text-sm font-medium text-ink">{s.label}</p>
                          <span className="shrink-0 font-mono text-[10px] text-ink-muted">{s.id}</span>
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-ink-secondary">{s.description}</p>
                      </div>
                    ))}
                  </div>
                )}
              </section>
              <section>
                <p className="mb-2 text-sm font-medium">
                  工具 <span className="font-normal text-ink-muted">{caps.tools.length}</span>
                </p>
                {caps.tools.length === 0 ? (
                  <p className="text-xs text-ink-muted">此包无工具条目。</p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {caps.tools.map((t) => (
                      <div
                        key={t.id}
                        className="rounded-md border border-hairline-soft bg-canvas-inset/40 px-3 py-2.5"
                      >
                        <div className="flex min-w-0 items-baseline justify-between gap-2">
                          <p className="truncate text-sm font-medium text-ink">{t.label}</p>
                          <span className="shrink-0 font-mono text-[10px] text-ink-muted">{t.id}</span>
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-ink-secondary">{t.description}</p>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>

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
                    onClick={() => void save()}
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

function SimpleDialog({
  title,
  description,
  children,
  confirmLabel,
  confirming,
  confirmDisabled,
  error,
  onClose,
  onConfirm,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  confirmLabel: string;
  confirming?: boolean;
  confirmDisabled?: boolean;
  error?: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-lg border border-hairline-soft bg-canvas p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
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
            disabled={confirming || confirmDisabled}
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

function NodeOnlineBadge({ online }: { online: boolean }) {
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

function InfoCard({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-md border border-hairline-soft px-3 py-2.5">
      <p className="text-[11px] text-ink-muted">{label}</p>
      <p className={`mt-0.5 truncate text-sm text-ink ${mono ? "font-mono" : "font-medium"}`} title={value}>
        {value}
      </p>
    </div>
  );
}
