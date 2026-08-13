import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";
import { authFetch } from "../lib/api";
import { casePath } from "../lib/caseRoutes";
import AssetDetailDialog from "../components/AssetDetailDialog";
import ConfirmDialog from "../components/ConfirmDialog";

type RelatedVuln = {
  id: string;
  title: string;
  severity: string;
  status: string;
  confidence: string;
  port?: string | null;
  description?: string | null;
};

type RiskSummary = {
  open_total: number;
  by_severity: Record<string, number>;
  highest: string;
  label: string;
};

type Service = {
  port: string;
  name?: string;
  protocol?: string | null;
  product?: string | null;
  version?: string | null;
  url?: string | null;
  note?: string | null;
  tags?: string[];
};

type Asset = {
  id: string;
  conversation_id?: string | null;
  node_id?: string | null;
  name: string;
  address: string;
  type: string;
  type_label?: string;
  tags: string[];
  properties: Record<string, unknown>;
  source: string;
  source_label?: string;
  open_ports?: string[];
  services?: Service[];
  aliases?: string[];
  ports_summary?: string;
  tech_summary?: string;
  risk?: RiskSummary;
  related_vulnerabilities: RelatedVuln[];
  created_at?: string | null;
  updated_at?: string | null;
};

type TreeHost = {
  id: string;
  address: string;
  name: string;
  tags: string[];
  aliases: string[];
  services: Service[];
  source?: string;
  source_label?: string;
  risk?: RiskSummary;
  related_vulnerabilities?: RelatedVuln[];
  updated_at?: string | null;
};

type TreeGroup = {
  id: string;
  name: string;
  hosts: TreeHost[];
};

type AssetTree = {
  groups: TreeGroup[];
  all_groups: { id: string; name: string }[];
  all_tags: string[];
};

type AssetGroup = {
  id: string;
  name: string;
  members: { asset_id: string; ports: string[] }[];
};

type Conversation = { id: string; title?: string };

/** Sentinel: asset selected as host-only (no port inventory yet). */
const HOST_ONLY = "__host__";

const EMPTY_FORM = { address: "", tags: "" };
const ACTIVE_CONVERSATION_KEY = "active_conversation_id";
/**
 * Consumed by ConversationPage after Asset「创建任务」.
 * Creates a Case with prefilled target/scope + composer draft — does **not** auto-send
 * so the user can pick @专家 before dispatch.
 */
export const PENDING_ASSET_TASK_KEY = "pending_asset_task";

export type PendingAssetTask = {
  text: string;
  target: { type: string; value: string };
  scope: { allow: string[]; deny: string[] };
  /** Conversation created for this launch — must win over restore races. */
  conversationId: string;
  /** When false/omitted, open Case + draft only; user sends after choosing expert. */
  autoSend?: boolean;
};

export default function AssetPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [openMenu, setOpenMenu] = useState<"tag" | "group" | null>(null);
  const filterBarRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Asset | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [tree, setTree] = useState<TreeGroup[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [allGroups, setAllGroups] = useState<{ id: string; name: string }[]>([]);
  const [groupRows, setGroupRows] = useState<AssetGroup[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [launching, setLaunching] = useState(false);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkDeleteError, setBulkDeleteError] = useState("");
  const [showGroupForm, setShowGroupForm] = useState(false);
  const [groupFormName, setGroupFormName] = useState("");
  const [groupFormError, setGroupFormError] = useState("");
  const [savingGroup, setSavingGroup] = useState(false);
  const [renamingGroup, setRenamingGroup] = useState<{ id: string; name: string } | null>(null);
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState<AssetGroup | null>(null);
  const [deletingGroup, setDeletingGroup] = useState(false);
  const [showAssemble, setShowAssemble] = useState(false);
  const [assembleGroupId, setAssembleGroupId] = useState("");
  const [assemblePorts, setAssemblePorts] = useState<Record<string, string[]>>({});
  const [assembleError, setAssembleError] = useState("");
  const [savingAssemble, setSavingAssemble] = useState(false);

  /** assetId → selected ports (or HOST_ONLY). */
  const [checkedPorts, setCheckedPorts] = useState<Record<string, string[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (search.trim()) p.set("search", search.trim());
    for (const t of selectedTags) p.append("tag", t);
    for (const g of selectedGroups) p.append("group", g);
    return p;
  }, [search, selectedTags, selectedGroups]);

  const load = async () => {
    setError("");
    try {
      const [treeRes, catalog] = await Promise.all([
        authFetch<AssetTree>(`/api/assets/tree?${params}`),
        authFetch<Asset[]>("/api/assets?limit=200"),
      ]);
      setTree(treeRes.groups || []);
      setAllGroups(treeRes.all_groups || []);
      setAllTags(treeRes.all_tags || []);
      setAssets(catalog);
      if (selected) {
        const fresh = catalog.find((item) => item.id === selected.id);
        if (fresh) setSelected(fresh);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "资产加载失败");
    }
  };

  const loadFilterOptions = async () => {
    try {
      const groups = await authFetch<AssetGroup[]>("/api/asset-groups").catch(() => [] as AssetGroup[]);
      setGroupRows(groups);
    } catch {
      /* optional */
    }
  };

  useEffect(() => {
    void load();
  }, [params.toString()]);

  useEffect(() => {
    void loadFilterOptions();
  }, []);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!filterBarRef.current?.contains(e.target as Node)) setOpenMenu(null);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const toggleInList = (list: string[], value: string, setList: (next: string[]) => void) => {
    setList(list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);
  };

  const multiLabel = (
    selected: string[],
    allLabel: string,
    options: { value: string; label: string }[],
  ) => {
    if (!selected.length) return allLabel;
    if (selected.length === 1) {
      return options.find((o) => o.value === selected[0])?.label || selected[0];
    }
    return `${selected.length} 项`;
  };

  const openAsset = async (id: string) => {
    const detail = await authFetch<Asset>(`/api/assets/${id}`);
    setSelected(detail);
  };

  const openCreateDialog = () => {
    setForm(EMPTY_FORM);
    setFormError("");
    setShowForm(true);
  };

  const closeCreateDialog = () => {
    if (saving) return;
    setShowForm(false);
    setForm(EMPTY_FORM);
    setFormError("");
  };

  const createAsset = async () => {
    if (!form.address.trim()) {
      setFormError("请填写 IP 或域名");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      await authFetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: form.address.trim(),
          tags: form.tags
            .split(/[,，;；\n]+/)
            .map((t) => t.trim())
            .filter(Boolean),
        }),
      });
      setShowForm(false);
      setForm(EMPTY_FORM);
      await load();
      void loadFilterOptions();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setSaving(false);
    }
  };

  const selectedSummary = useMemo(() => {
    let assetsCount = 0;
    let portsCount = 0;
    const ids: string[] = [];
    for (const [assetId, ports] of Object.entries(checkedPorts)) {
      if (!ports.length) continue;
      assetsCount += 1;
      ids.push(assetId);
      if (ports.includes(HOST_ONLY)) {
        // host-only counts as one target, not a port
      } else {
        portsCount += ports.length;
      }
    }
    return { assetsCount, portsCount, ids };
  }, [checkedPorts]);

  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const visibleHosts = useMemo(() => {
    const seen = new Map<string, TreeHost>();
    for (const section of tree) {
      for (const host of section.hosts) {
        if (!seen.has(host.id)) seen.set(host.id, host);
      }
    }
    return [...seen.values()];
  }, [tree]);

  const bulkDeleteTargets = useMemo(() => {
    return selectedSummary.ids
      .map((id) => assetById.get(id))
      .filter((a): a is Asset => Boolean(a));
  }, [assetById, selectedSummary.ids]);

  const bulkDeleteDescription = useMemo(() => {
    const n = bulkDeleteTargets.length;
    if (!n) return "请先勾选要删除的资产。";
    const labels = bulkDeleteTargets.map((a) => a.address || a.name || a.id);
    const preview = labels.slice(0, 8).map((x) => `· ${x}`).join("\n");
    const more = labels.length > 8 ? `\n· …共 ${labels.length} 个` : "";
    return (
      `确定删除以下 ${n} 个主机资产？\n\n${preview}${more}\n\n` +
      "关联漏洞仅解绑，不会删除。此操作不可撤销。"
    );
  }, [bulkDeleteTargets]);

  const toggleExpand = (assetId: string, e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    setExpanded((prev) => ({ ...prev, [assetId]: !prev[assetId] }));
  };

  const selectAllPortsForAsset = (asset: Asset) => {
    const ports = listPorts(asset);
    return ports.length ? ports : [HOST_ONLY];
  };

  const isAssetFullySelected = (asset: Asset) => {
    const sel = checkedPorts[asset.id] || [];
    if (!sel.length) return false;
    const ports = listPorts(asset);
    if (!ports.length) return sel.includes(HOST_ONLY);
    return ports.every((p) => sel.includes(p));
  };

  const isAssetPartiallySelected = (asset: Asset) => {
    const sel = checkedPorts[asset.id] || [];
    if (!sel.length) return false;
    if (isAssetFullySelected(asset)) return false;
    return true;
  };

  const toggleAsset = (asset: Asset) => {
    setCheckedPorts((prev) => {
      const next = { ...prev };
      const ports = listPorts(asset);
      const sel = prev[asset.id] || [];
      const fully =
        ports.length > 0
          ? ports.every((p) => sel.includes(p))
          : sel.includes(HOST_ONLY);
      if (fully) {
        delete next[asset.id];
      } else {
        next[asset.id] = ports.length ? [...ports] : [HOST_ONLY];
      }
      return next;
    });
  };

  const togglePort = (asset: Asset, port: string) => {
    setCheckedPorts((prev) => {
      const current = new Set((prev[asset.id] || []).filter((p) => p !== HOST_ONLY));
      if (current.has(port)) current.delete(port);
      else current.add(port);
      const next = { ...prev };
      if (!current.size) delete next[asset.id];
      else next[asset.id] = [...current];
      return next;
    });
    // Auto-expand when picking individual ports
    setExpanded((prev) => ({ ...prev, [asset.id]: true }));
  };

  const catalogForHost = (host: TreeHost): Asset =>
    assetById.get(host.id) || {
      id: host.id,
      name: host.name,
      address: host.address,
      type: "host",
      tags: host.tags,
      properties: {},
      source: host.source || "manual",
      services: host.services,
      related_vulnerabilities: host.related_vulnerabilities || [],
    };

  const allFullySelected =
    visibleHosts.length > 0 && visibleHosts.every((h) => isAssetFullySelected(catalogForHost(h)));
  const someSelected = visibleHosts.some((h) => (checkedPorts[h.id] || []).length > 0);

  const toggleAllAssets = () => {
    if (allFullySelected) {
      setCheckedPorts({});
      return;
    }
    const next: Record<string, string[]> = {};
    for (const h of visibleHosts) {
      next[h.id] = selectAllPortsForAsset(catalogForHost(h));
    }
    setCheckedPorts(next);
  };

  const toggleGroupExpand = (groupId: string) => {
    setExpandedGroups((prev) => ({ ...prev, [groupId]: prev[groupId] === false }));
  };

  const createGroup = async () => {
    const name = groupFormName.trim();
    if (!name) {
      setGroupFormError("请填写组名");
      return;
    }
    setSavingGroup(true);
    setGroupFormError("");
    try {
      await authFetch("/api/asset-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      setShowGroupForm(false);
      setGroupFormName("");
      await load();
      void loadFilterOptions();
    } catch (err) {
      setGroupFormError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setSavingGroup(false);
    }
  };

  const renameGroup = async () => {
    if (!renamingGroup) return;
    const name = renamingGroup.name.trim();
    if (!name) {
      setGroupFormError("请填写组名");
      return;
    }
    setSavingGroup(true);
    setGroupFormError("");
    try {
      await authFetch(`/api/asset-groups/${renamingGroup.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      setRenamingGroup(null);
      await load();
      void loadFilterOptions();
    } catch (err) {
      setGroupFormError(err instanceof Error ? err.message : "重命名失败");
    } finally {
      setSavingGroup(false);
    }
  };

  const deleteGroup = async () => {
    if (!confirmDeleteGroup) return;
    setDeletingGroup(true);
    try {
      await authFetch(`/api/asset-groups/${confirmDeleteGroup.id}`, { method: "DELETE" });
      setConfirmDeleteGroup(null);
      setSelectedGroups((prev) => prev.filter((id) => id !== confirmDeleteGroup.id));
      await load();
      void loadFilterOptions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除组失败");
    } finally {
      setDeletingGroup(false);
    }
  };

  const openAssemble = () => {
    const first = allGroups[0]?.id || "";
    setAssembleGroupId(first);
    const next: Record<string, string[]> = {};
    for (const id of selectedSummary.ids) {
      const sel = (checkedPorts[id] || []).filter((p) => p !== HOST_ONLY);
      next[id] = sel;
    }
    setAssemblePorts(next);
    setAssembleError("");
    setShowAssemble(true);
  };

  const saveAssemble = async () => {
    if (!assembleGroupId) {
      setAssembleError("请选择组");
      return;
    }
    setSavingAssemble(true);
    setAssembleError("");
    try {
      for (const id of selectedSummary.ids) {
        await authFetch(`/api/asset-groups/${assembleGroupId}/hosts/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ports: assemblePorts[id] || [] }),
        });
      }
      setShowAssemble(false);
      setNotice("已写入组装");
      await load();
      void loadFilterOptions();
    } catch (err) {
      setAssembleError(err instanceof Error ? err.message : "组装失败");
    } finally {
      setSavingAssemble(false);
    }
  };

  const clearSelection = () => setCheckedPorts({});

  const buildTaskPayload = (): Omit<PendingAssetTask, "conversationId"> | null => {
    // scope.allow must be host / origin level (http://host:port), NEVER deep paths.
    // Service.url notes like …/vulnerabilities/brute/ are focus hints only — if they go
    // into allow, the agent correctly refuses to leave that single path (one-vuln trap).
    const allow: string[] = [];
    const lines: string[] = [];
    const pushAllow = (entry: string) => {
      const e = String(entry || "").trim();
      if (!e || allow.includes(e)) return;
      allow.push(e);
    };
    for (const asset of assets) {
      const sel = checkedPorts[asset.id];
      if (!sel?.length) continue;
      const host = asset.address;
      const ports = listPorts(asset);
      const services = asset.services || [];
      const notesByPort = Object.fromEntries(
        services.filter((s) => s.port && s.note).map((s) => [s.port, String(s.note)]),
      );

      if (sel.includes(HOST_ONLY) || (ports.length && ports.every((p) => sel.includes(p)))) {
        // Whole host (+ origins for each known port)
        pushAllow(host);
        if (ports.length) {
          for (const p of ports) {
            const origin = scopeOriginForPort(asset, p);
            pushAllow(origin);
            const focus = serviceFocusPath(asset, p);
            const note = notesByPort[p];
            const label = origin;
            const extra = [focus && focus !== origin ? `入口：${focus}` : "", note ? `备注：${note}` : ""]
              .filter(Boolean)
              .join("；");
            lines.push(extra ? `- ${label}（${extra}）` : `- ${label}`);
          }
        } else {
          lines.push(`- ${host}（全部端口/服务，以资产台账为准）`);
        }
      } else {
        // Selected ports only — still host:port / origin scope, not module path
        pushAllow(host);
        for (const p of sel) {
          const origin = scopeOriginForPort(asset, p);
          pushAllow(origin);
          const focus = serviceFocusPath(asset, p);
          const note = notesByPort[p];
          const svc = services.find((s) => s.port === p);
          const svcLabel = svc?.name ? `${p}/${svc.name}` : p;
          const extra = [focus && focus !== origin ? `优先入口：${focus}` : "", note ? `备注：${note}` : ""]
            .filter(Boolean)
            .join("；");
          lines.push(
            extra
              ? `- ${host} · ${svcLabel} · ${origin}（${extra}）`
              : `- ${host} · ${svcLabel} · ${origin}`,
          );
        }
      }
    }
    if (!allow.length) return null;
    // Prefer origin URL as primary target when present
    const primary = allow.find((a) => a.startsWith("http")) || allow[0]!;
    const text =
      "请对以下授权目标进行安全测试。\n\n" +
      "**Scope（scope.allow）是主机/源站级边界**（host 或 http(s)://host:port），" +
      "同一源站下的路径与模块均在授权范围内，不要把备注里的「优先入口」当成唯一可测路径。\n\n" +
      "目标清单：\n" +
      lines.join("\n") +
      "\n\n若条目含「优先入口」或端口备注，请优先覆盖该入口，但仍应做合理同源扩展（同端口下的其他攻击面），除非用户明确禁止。";
    return {
      text,
      target: { type: primary.startsWith("http") ? "url" : "host", value: primary },
      scope: { allow, deny: [] },
    };
  };

  const launchTask = async () => {
    const payload = buildTaskPayload();
    if (!payload) {
      setError("请先勾选资产或端口");
      return;
    }
    setLaunching(true);
    setError("");
    setNotice("");
    try {
      const conv = await authFetch<Conversation>("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      // Create Case + draft only — do not auto-dispatch so user can switch @专家 first.
      const pending: PendingAssetTask = {
        ...payload,
        conversationId: conv.id,
        autoSend: false,
      };
      // Pin active conversation before navigation so ConversationPage restore cannot
      // fall back to a different running session.
      localStorage.setItem(ACTIVE_CONVERSATION_KEY, conv.id);
      sessionStorage.setItem(PENDING_ASSET_TASK_KEY, JSON.stringify(pending));
      setNotice("已创建会话，请选择专家后发送…");
      navigate(casePath(conv.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建任务失败");
    } finally {
      setLaunching(false);
    }
  };

  const openBulkDeleteConfirm = () => {
    if (!bulkDeleteTargets.length) {
      setError("请先勾选要删除的资产");
      return;
    }
    setBulkDeleteError("");
    setConfirmBulkDelete(true);
  };

  const closeBulkDeleteConfirm = () => {
    if (bulkDeleting) return;
    setConfirmBulkDelete(false);
    setBulkDeleteError("");
  };

  const confirmBulkDeleteAssets = async () => {
    const targets = bulkDeleteTargets;
    if (!targets.length) {
      setBulkDeleteError("没有可删除的资产");
      return;
    }
    setBulkDeleting(true);
    setBulkDeleteError("");
    setError("");
    const failed: string[] = [];
    const deletedIds: string[] = [];
    for (const asset of targets) {
      try {
        await authFetch(`/api/assets/${asset.id}`, { method: "DELETE" });
        deletedIds.push(asset.id);
      } catch (err) {
        const label = asset.address || asset.name || asset.id;
        const msg = err instanceof Error ? err.message : "删除失败";
        failed.push(`${label}：${msg}`);
      }
    }
    setBulkDeleting(false);
    if (deletedIds.length) {
      setCheckedPorts((prev) => {
        const next = { ...prev };
        for (const id of deletedIds) delete next[id];
        return next;
      });
      if (selected && deletedIds.includes(selected.id)) {
        setSelected(null);
      }
      await load();
      void loadFilterOptions();
    }
    if (failed.length) {
      setBulkDeleteError(
        `成功 ${deletedIds.length} 个，失败 ${failed.length} 个：\n${failed.slice(0, 5).join("\n")}`,
      );
      // Keep dialog open so the user can see partial failures.
      return;
    }
    setConfirmBulkDelete(false);
    setNotice(`已删除 ${deletedIds.length} 个资产`);
  };

  return (
    <div className="flex h-screen bg-canvas">
      <Sidebar activeId={null} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar title="资产管理" />
        <div className="flex flex-1 overflow-hidden">
          <main className="flex-1 overflow-y-auto p-6">
            <div className="mb-4 flex flex-wrap items-center gap-3" ref={filterBarRef}>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="关键词：地址 / 别名 / 端口 / 标签 / 组名"
                className="min-w-[16rem] rounded-md border border-hairline px-3 py-2 text-sm focus:border-ink focus:outline-none"
              />

              <MultiFilter
                label="组"
                buttonText={multiLabel(
                  selectedGroups,
                  "全部组",
                  allGroups.map((g) => ({ value: g.id, label: g.name })),
                )}
                open={openMenu === "group"}
                onToggle={() => setOpenMenu((m) => (m === "group" ? null : "group"))}
                onClear={() => setSelectedGroups([])}
                options={allGroups.map((g) => ({ value: g.id, label: g.name }))}
                selected={selectedGroups}
                onToggleValue={(v) => toggleInList(selectedGroups, v, setSelectedGroups)}
                emptyText="暂无组"
              />

              <MultiFilter
                label="标签"
                buttonText={multiLabel(
                  selectedTags,
                  "全部标签",
                  allTags.map((t) => ({ value: t, label: t })),
                )}
                open={openMenu === "tag"}
                onToggle={() => setOpenMenu((m) => (m === "tag" ? null : "tag"))}
                onClear={() => setSelectedTags([])}
                options={allTags.map((t) => ({ value: t, label: t }))}
                selected={selectedTags}
                onToggleValue={(v) => toggleInList(selectedTags, v, setSelectedTags)}
                emptyText="暂无标签"
              />

              <button
                type="button"
                onClick={openCreateDialog}
                className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-on-ink hover:opacity-90"
              >
                添加资产
              </button>
              <button
                type="button"
                onClick={() => {
                  setGroupFormName("");
                  setGroupFormError("");
                  setShowGroupForm(true);
                }}
                className="rounded-md border border-hairline px-3 py-2 text-sm hover:bg-surface-default"
              >
                新建组
              </button>
            </div>

            {selectedSummary.assetsCount > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-hairline-soft bg-surface-default px-3 py-2">
                <span className="text-xs text-ink-secondary">
                  已选 {selectedSummary.assetsCount} 个主机
                  {selectedSummary.portsCount > 0 ? ` · ${selectedSummary.portsCount} 个端口` : ""}
                </span>
                <button
                  type="button"
                  disabled={launching || bulkDeleting}
                  onClick={() => void launchTask()}
                  className="rounded-md bg-ink px-3 py-1 text-[11px] font-medium text-on-ink disabled:opacity-50"
                >
                  {launching ? "创建中…" : "创建任务"}
                </button>
                <button
                  type="button"
                  disabled={bulkDeleting || launching || !allGroups.length}
                  onClick={openAssemble}
                  className="rounded-md border border-hairline px-2.5 py-1 text-[11px] font-medium hover:bg-canvas disabled:opacity-50"
                >
                  装入组
                </button>
                <button
                  type="button"
                  disabled={bulkDeleting || launching}
                  onClick={openBulkDeleteConfirm}
                  className="rounded-md border border-severity-critical/40 px-2.5 py-1 text-[11px] font-medium text-severity-critical hover:bg-severity-critical/10 disabled:opacity-50"
                >
                  删除
                </button>
                <button
                  type="button"
                  disabled={bulkDeleting}
                  onClick={clearSelection}
                  className="rounded-md border px-2.5 py-1 text-[11px] text-ink-secondary hover:bg-canvas disabled:opacity-50"
                >
                  清除选择
                </button>
              </div>
            )}

            {error && (
              <div className="mb-4 rounded-md border border-severity-critical/30 bg-severity-critical-subtle px-4 py-3 text-sm text-severity-critical">
                {error}
              </div>
            )}
            {notice && (
              <div className="mb-4 rounded-md border border-hairline-soft bg-surface-default px-4 py-3 text-sm text-ink-secondary">
                {notice}
              </div>
            )}

            <div className="rounded-md border border-hairline-soft bg-surface-raised">
              <div className="flex items-center gap-2 border-b border-hairline bg-surface-default px-3 py-2 text-xs text-ink-secondary">
                <input
                  type="checkbox"
                  checked={allFullySelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected && !allFullySelected;
                  }}
                  onChange={toggleAllAssets}
                  className="rounded border-hairline"
                  aria-label="全选资产"
                />
                <span>组 / 主机 / 端口</span>
              </div>
              <div className="divide-y divide-hairline-soft">
                {tree.map((section) => {
                  const groupOpen = expandedGroups[section.id] !== false;
                  const isUngrouped = !section.id;
                  return (
                    <div key={section.id || "ungrouped"}>
                      <div className="flex items-center gap-2 px-3 py-2 hover:bg-surface-default">
                        <button
                          type="button"
                          className="w-5 text-left text-xs text-ink-muted"
                          onClick={() => toggleGroupExpand(section.id)}
                          aria-label={groupOpen ? "收起组" : "展开组"}
                        >
                          {groupOpen ? "▾" : "▸"}
                        </button>
                        <div className="min-w-0 flex-1 text-sm font-medium text-ink">
                          {section.name}
                          <span className="ml-2 text-[11px] font-normal text-ink-muted">
                            {section.hosts.length}
                          </span>
                        </div>
                        {!isUngrouped ? (
                          <div className="flex shrink-0 gap-2">
                            <button
                              type="button"
                              className="text-[11px] text-ink-muted hover:text-ink"
                              onClick={() => {
                                setGroupFormError("");
                                setRenamingGroup({ id: section.id, name: section.name });
                              }}
                            >
                              重命名
                            </button>
                            <button
                              type="button"
                              className="text-[11px] text-ink-muted hover:text-severity-critical"
                              onClick={() => {
                                const row = groupRows.find((g) => g.id === section.id);
                                setConfirmDeleteGroup(row || { id: section.id, name: section.name, members: [] });
                              }}
                            >
                              删除
                            </button>
                          </div>
                        ) : null}
                      </div>
                      {groupOpen
                        ? section.hosts.map((host) => {
                            const asset = catalogForHost(host);
                            const hostKey = `${section.id}:${host.id}`;
                            const isOpen = Boolean(expanded[hostKey]);
                            const full = isAssetFullySelected(asset);
                            const partial = isAssetPartiallySelected(asset);
                            const sel = checkedPorts[host.id] || [];
                            const aliases = host.aliases?.length ? host.aliases : aliasesFromAsset(asset);
                            return (
                              <Fragment key={hostKey}>
                                <div
                                  className="flex cursor-pointer items-center gap-2 px-3 py-2 pl-8 hover:bg-surface-default"
                                  onClick={() => void openAsset(host.id)}
                                >
                                  <input
                                    type="checkbox"
                                    checked={full}
                                    ref={(el) => {
                                      if (el) el.indeterminate = partial;
                                    }}
                                    onChange={() => toggleAsset(asset)}
                                    onClick={(e) => e.stopPropagation()}
                                    className="rounded border-hairline"
                                    aria-label={`选择 ${host.address}`}
                                  />
                                  <button
                                    type="button"
                                    className="w-5 text-xs text-ink-muted"
                                    onClick={(e) => toggleExpand(hostKey, e)}
                                    aria-label={isOpen ? "收起端口" : "展开端口"}
                                  >
                                    {isOpen ? "▾" : "▸"}
                                  </button>
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate font-mono text-sm text-ink">{host.address}</div>
                                    {aliases.length ? (
                                      <div className="truncate font-mono text-[11px] text-ink-muted">
                                        {aliases.join(" · ")}
                                      </div>
                                    ) : null}
                                  </div>
                                  <div className="shrink-0">
                                    <TagList tags={host.tags || []} />
                                  </div>
                                </div>
                                {isOpen ? (
                                  (host.services || []).length ? (
                                    (host.services || []).map((svc) => {
                                      const checked = sel.includes(svc.port);
                                      const label = svc.name ? `${svc.port}/${svc.name}` : svc.port;
                                      return (
                                        <div
                                          key={`${hostKey}:${svc.port}`}
                                          className="flex items-center gap-2 px-3 py-1.5 pl-16 text-xs"
                                        >
                                          <input
                                            type="checkbox"
                                            checked={checked}
                                            onChange={() => togglePort(asset, svc.port)}
                                            className="rounded border-hairline"
                                          />
                                          <span className="font-mono text-ink">{label}</span>
                                          <div className="ml-auto">
                                            <TagList tags={svc.tags || []} />
                                          </div>
                                        </div>
                                      );
                                    })
                                  ) : (
                                    <p className="px-3 py-1.5 pl-16 text-xs text-ink-muted">
                                      {section.id ? "裸主机（本组未选端口）" : "暂无端口"}
                                    </p>
                                  )
                                ) : null}
                              </Fragment>
                            );
                          })
                        : null}
                    </div>
                  );
                })}
                {!tree.length && (
                  <p className="px-4 py-10 text-center text-sm text-ink-muted">
                    {assets.length
                      ? "没有匹配的主机。试试少选几个标签，或清空组筛选。"
                      : "暂无资产。点击「添加资产」录入 IP/域名，再用「新建组」组装。"}
                  </p>
                )}
              </div>
            </div>
          </main>

          <AssetDetailDialog
            open={Boolean(selected)}
            assetId={selected?.id}
            initial={selected}
            knownTags={allTags}
            groups={groupRows}
            onClose={() => setSelected(null)}
            onSaved={() => {
              void load();
              void loadFilterOptions();
            }}
            onDeleted={(id) => {
              setSelected(null);
              setCheckedPorts((prev) => {
                if (!(id in prev)) return prev;
                const next = { ...prev };
                delete next[id];
                return next;
              });
              void load();
              void loadFilterOptions();
            }}
          />

          <ConfirmDialog
            open={confirmBulkDelete}
            title={bulkDeleteTargets.length > 1 ? "批量删除资产" : "删除资产"}
            description={bulkDeleteDescription}
            busy={bulkDeleting}
            confirmLabel={bulkDeleteTargets.length > 1 ? `删除 ${bulkDeleteTargets.length} 个` : "删除"}
            onCancel={closeBulkDeleteConfirm}
            onConfirm={() => void confirmBulkDeleteAssets()}
            error={bulkDeleteError || null}
          />

          {showForm && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center theme-overlay px-4"
              onClick={closeCreateDialog}
            >
              <div
                className="w-full max-w-md rounded-lg border border-hairline-soft bg-canvas p-6 shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <h2 className="text-lg font-semibold">添加资产</h2>
                <p className="mt-1 text-xs text-ink-muted">
                  一个资产对应一个 IP 或域名。用「新建组」把主机和所选端口装进去；标签打在主机或端口上，不是组。
                </p>
                <div className="mt-4 space-y-3">
                  <Field label="IP / 域名">
                    <input
                      value={form.address}
                      onChange={(e) => setForm({ ...form, address: e.target.value })}
                      placeholder="例如 10.0.0.8 或 pay.example.com"
                      className="w-full rounded-md border border-hairline px-3 py-2 text-sm font-mono"
                      autoFocus
                    />
                  </Field>
                  <Field label="标签（可选，多个用逗号分隔）">
                    <input
                      list="create-tag-options"
                      value={form.tags}
                      onChange={(e) => setForm({ ...form, tags: e.target.value })}
                      placeholder="如：支付系统, 生产"
                      className="w-full rounded-md border border-hairline px-3 py-2 text-sm"
                    />
                    <datalist id="create-tag-options">
                      {allTags.map((t) => (
                        <option key={t} value={t} />
                      ))}
                    </datalist>
                  </Field>
                </div>
                {formError && <p className="mt-3 text-xs text-severity-critical">{formError}</p>}
                <div className="mt-6 flex justify-end gap-2 border-t border-hairline-soft pt-4">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={closeCreateDialog}
                    className="rounded-md border border-hairline px-3 py-1.5 text-xs"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void createAsset()}
                    className="rounded-md bg-ink px-4 py-1.5 text-xs font-medium text-on-ink disabled:opacity-60"
                  >
                    {saving ? "保存中…" : "保存"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {(showGroupForm || renamingGroup) && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center theme-overlay px-4"
              onClick={() => {
                if (savingGroup) return;
                setShowGroupForm(false);
                setRenamingGroup(null);
              }}
            >
              <div
                className="w-full max-w-md rounded-lg border border-hairline-soft bg-canvas p-6 shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <h2 className="text-lg font-semibold">{renamingGroup ? "重命名组" : "新建组"}</h2>
                <Field label="组名">
                  <input
                    value={renamingGroup ? renamingGroup.name : groupFormName}
                    onChange={(e) => {
                      if (renamingGroup) setRenamingGroup({ ...renamingGroup, name: e.target.value });
                      else setGroupFormName(e.target.value);
                    }}
                    placeholder="例如 XXX公司 / OA"
                    className="w-full rounded-md border border-hairline px-3 py-2 text-sm"
                    autoFocus
                  />
                </Field>
                {groupFormError && <p className="mt-3 text-xs text-severity-critical">{groupFormError}</p>}
                <div className="mt-6 flex justify-end gap-2 border-t border-hairline-soft pt-4">
                  <button
                    type="button"
                    disabled={savingGroup}
                    onClick={() => {
                      setShowGroupForm(false);
                      setRenamingGroup(null);
                    }}
                    className="rounded-md border border-hairline px-3 py-1.5 text-xs"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={savingGroup}
                    onClick={() => void (renamingGroup ? renameGroup() : createGroup())}
                    className="rounded-md bg-ink px-4 py-1.5 text-xs font-medium text-on-ink disabled:opacity-60"
                  >
                    {savingGroup ? "保存中…" : "保存"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {showAssemble && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center theme-overlay px-4"
              onClick={() => {
                if (!savingAssemble) setShowAssemble(false);
              }}
            >
              <div
                className="w-full max-w-lg rounded-lg border border-hairline-soft bg-canvas p-6 shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <h2 className="text-lg font-semibold">装入组</h2>
                <p className="mt-1 text-xs text-ink-muted">
                  把已选主机装进一个组，并勾选该组要包含的端口。不勾端口 = 裸主机。
                </p>
                <Field label="组">
                  <select
                    value={assembleGroupId}
                    onChange={(e) => setAssembleGroupId(e.target.value)}
                    className="w-full rounded-md border border-hairline px-3 py-2 text-sm"
                  >
                    {!allGroups.length ? <option value="">请先新建组</option> : null}
                    {allGroups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="mt-3 max-h-64 space-y-3 overflow-y-auto">
                  {selectedSummary.ids.map((id) => {
                    const asset = assetById.get(id);
                    if (!asset) return null;
                    const ports = listPorts(asset);
                    const picked = new Set(assemblePorts[id] || []);
                    return (
                      <div key={id} className="rounded-md border border-hairline-soft px-3 py-2">
                        <div className="font-mono text-sm">{asset.address}</div>
                        {ports.length ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {ports.map((port) => (
                              <label key={port} className="inline-flex items-center gap-1 text-xs">
                                <input
                                  type="checkbox"
                                  checked={picked.has(port)}
                                  onChange={() => {
                                    setAssemblePorts((prev) => {
                                      const cur = new Set(prev[id] || []);
                                      if (cur.has(port)) cur.delete(port);
                                      else cur.add(port);
                                      return { ...prev, [id]: [...cur] };
                                    });
                                  }}
                                />
                                <span className="font-mono">{port}</span>
                              </label>
                            ))}
                          </div>
                        ) : (
                          <p className="mt-1 text-[11px] text-ink-muted">无端口，将以裸主机装入</p>
                        )}
                      </div>
                    );
                  })}
                </div>
                {assembleError && <p className="mt-3 text-xs text-severity-critical">{assembleError}</p>}
                <div className="mt-6 flex justify-end gap-2 border-t border-hairline-soft pt-4">
                  <button
                    type="button"
                    disabled={savingAssemble}
                    onClick={() => setShowAssemble(false)}
                    className="rounded-md border border-hairline px-3 py-1.5 text-xs"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={savingAssemble}
                    onClick={() => void saveAssemble()}
                    className="rounded-md bg-ink px-4 py-1.5 text-xs font-medium text-on-ink disabled:opacity-60"
                  >
                    {savingAssemble ? "保存中…" : "保存"}
                  </button>
                </div>
              </div>
            </div>
          )}

          <ConfirmDialog
            open={Boolean(confirmDeleteGroup)}
            title="删除组"
            description={
              confirmDeleteGroup
                ? `确定删除组「${confirmDeleteGroup.name}」？主机会回到未分组，不会删除主机。`
                : ""
            }
            busy={deletingGroup}
            confirmLabel="删除组"
            onCancel={() => setConfirmDeleteGroup(null)}
            onConfirm={() => void deleteGroup()}
          />
        </div>
      </div>
    </div>
  );
}

function aliasesFromAsset(asset: Asset): string[] {
  const raw = asset.aliases || (asset.properties as { aliases?: unknown })?.aliases;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        return String(rec.value || rec.address || rec.host || "").trim();
      }
      return "";
    })
    .filter(Boolean);
}

function listPorts(asset: Asset): string[] {
  const set = new Set<string>();
  for (const s of asset.services || []) {
    if (s.port) set.add(String(s.port));
  }
  for (const p of asset.open_ports || []) {
    if (p) set.add(String(p));
  }
  return [...set].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
}

/**
 * Scope-safe origin for a port: scheme://host[:port] only.
 * Never return deep paths from service.url (those over-constrain the agent).
 */
function scopeOriginForPort(asset: Asset, port: string): string {
  const host = asset.address;
  const svc = (asset.services || []).find((s) => String(s.port) === String(port));
  const name = (svc?.name || "").toLowerCase();
  if (svc?.url) {
    try {
      const raw = String(svc.url).trim();
      const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
      const u = new URL(withScheme);
      const h = u.hostname || host;
      if (u.port) return `${u.protocol}//${h}:${u.port}`;
      if (u.protocol === "https:") return `https://${h}`;
      // Default port omitted — keep host-only http/https
      if (port === "80" || port === "443") return `${u.protocol}//${h}`;
      return `${u.protocol}//${h}:${port}`;
    } catch {
      /* fall through */
    }
  }
  if (port === "443" || name === "https") return `https://${host}`;
  if (port === "80" || name === "http") return `http://${host}`;
  if (/^\d+$/.test(port) && Number(port) > 0) {
    if (name === "https" || port === "8443") return `https://${host}:${port}`;
    return `http://${host}:${port}`;
  }
  return `${host}:${port}`;
}

/** Optional deep path from service.url for instruction focus (not scope.allow). */
function serviceFocusPath(asset: Asset, port: string): string | null {
  const svc = (asset.services || []).find((s) => String(s.port) === String(port));
  const raw = String(svc?.url || "").trim();
  if (!raw) return null;
  try {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    const u = new URL(withScheme);
    const path = u.pathname || "/";
    if (path && path !== "/") return raw.startsWith("http") ? raw : withScheme;
  } catch {
    if (raw.includes("/") && !/^[a-z0-9.-]+(?::\d+)?$/i.test(raw)) return raw;
  }
  return null;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-secondary">{label}</span>
      {children}
    </label>
  );
}

function TagList({ tags }: { tags: string[] }) {
  if (!tags.length) return <span className="text-xs text-ink-muted">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {tags.slice(0, 4).map((t) => (
        <span key={t} className="rounded-md bg-canvas-inset px-1.5 py-0.5 text-[11px] text-ink-secondary">
          {t}
        </span>
      ))}
      {tags.length > 4 ? <span className="text-[11px] text-ink-muted">+{tags.length - 4}</span> : null}
    </div>
  );
}

function MultiFilter({
  label,
  buttonText,
  open,
  onToggle,
  onClear,
  options,
  selected,
  onToggleValue,
  emptyText,
  wide,
}: {
  label: string;
  buttonText: string;
  open: boolean;
  onToggle: () => void;
  onClear: () => void;
  options: { value: string; label: string; mono?: boolean }[];
  selected: string[];
  onToggleValue: (value: string) => void;
  emptyText?: string;
  wide?: boolean;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        className="rounded-md border border-hairline px-3 py-2 text-sm hover:bg-surface-default"
      >
        {label}：{buttonText}
        {selected.length > 0 ? (
          <span className="ml-1 rounded bg-canvas-inset px-1.5 py-0.5 text-[10px] text-ink-muted">
            {selected.length}
          </span>
        ) : null}
      </button>
      {open && (
        <div
          className={`absolute left-0 z-20 mt-1 max-h-64 overflow-y-auto rounded-md border border-hairline-soft bg-canvas py-1 shadow-lg ${
            wide ? "w-72" : "min-w-[10rem]"
          }`}
        >
          <button
            type="button"
            className="block w-full px-3 py-1.5 text-left text-xs text-ink-muted hover:bg-surface-default"
            onClick={onClear}
          >
            清除选择
          </button>
          {options.map((opt) => (
            <label
              key={opt.value}
              className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-surface-default"
            >
              <input
                type="checkbox"
                checked={selected.includes(opt.value)}
                onChange={() => onToggleValue(opt.value)}
                className="rounded border-hairline"
              />
              <span className={`min-w-0 truncate ${opt.mono ? "font-mono text-xs" : ""}`}>
                {opt.label}
              </span>
            </label>
          ))}
          {!options.length && emptyText ? (
            <p className="px-3 py-2 text-xs text-ink-muted">{emptyText}</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
