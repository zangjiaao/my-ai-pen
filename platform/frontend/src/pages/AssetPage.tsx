import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";
import { authFetch } from "../lib/api";
import AssetDetailDialog from "../components/AssetDetailDialog";
import ConfirmDialog from "../components/ConfirmDialog";
import GroupLedgerDialog from "../components/GroupLedgerDialog";
import ServiceLedgerDialog from "../components/ServiceLedgerDialog";
import { buildRiskChips, type RiskChip } from "../components/cards/FindingCard";

type RelatedVuln = {
  id: string;
  title: string;
  severity: string;
  status: string;
  confidence: string;
  port?: string | null;
  description?: string | null;
};

type Service = {
  port: string;
  name?: string;
  protocol?: string | null;
  tags?: string[];
  paths?: { path: string; source?: string }[];
  note?: string | null;
};

type Asset = {
  id: string;
  name: string;
  address: string;
  type: string;
  tags: string[];
  properties: Record<string, unknown>;
  source: string;
  services?: Service[];
  aliases?: string[];
  related_vulnerabilities: RelatedVuln[];
};

type RiskSummary = {
  open_total: number;
  highest?: string;
  label?: string;
};

type TreeHost = {
  id: string;
  address: string;
  name: string;
  tags: string[];
  aliases: string[];
  services: Service[];
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

const EMPTY_FORM = { address: "", tags: "", groupIds: [] as string[] };
const ALL_SECTION = "all";

function isGroupId(id: string) {
  return Boolean(id) && id !== ALL_SECTION;
}

export default function AssetPage() {
  const [search, setSearch] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [openMenu, setOpenMenu] = useState<"tag" | "move" | null>(null);
  const filterBarRef = useRef<HTMLDivElement>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [tree, setTree] = useState<TreeGroup[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [allGroups, setAllGroups] = useState<{ id: string; name: string }[]>([]);
  const [groupRows, setGroupRows] = useState<AssetGroup[]>([]);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState("");
  const [showGroupForm, setShowGroupForm] = useState(false);
  const [groupFormName, setGroupFormName] = useState("");
  const [groupFormError, setGroupFormError] = useState("");
  const [savingGroup, setSavingGroup] = useState(false);
  const [activeSectionId, setActiveSectionId] = useState<string>(ALL_SECTION);
  const [hostId, setHostId] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [serviceKey, setServiceKey] = useState<{ assetId: string; port: string } | null>(null);
  const [addPortHostId, setAddPortHostId] = useState<string | null>(null);
  const [addPortForm, setAddPortForm] = useState({ port: "", name: "" });
  const [addPortError, setAddPortError] = useState("");
  const [addingPort, setAddingPort] = useState(false);
  const [deleteHost, setDeleteHost] = useState<{ id: string; address: string } | null>(null);
  const [deletingHost, setDeletingHost] = useState(false);
  const [deleteHostError, setDeleteHostError] = useState("");
  const [deletePort, setDeletePort] = useState<{ assetId: string; port: string; address: string } | null>(null);
  const [deletingPort, setDeletingPort] = useState(false);
  const [deletePortError, setDeletePortError] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState("");

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (search.trim()) p.set("search", search.trim());
    for (const t of selectedTags) p.append("tag", t);
    return p;
  }, [search, selectedTags]);

  const load = async () => {
    setError("");
    try {
      const [treeRes, catalog, groups] = await Promise.all([
        authFetch<AssetTree>(`/api/assets/tree?${params}`),
        authFetch<Asset[]>("/api/assets?limit=200"),
        authFetch<AssetGroup[]>("/api/asset-groups").catch(() => [] as AssetGroup[]),
      ]);
      const nextTree = treeRes.groups || [];
      const nextGroups = treeRes.all_groups || [];
      setTree(nextTree);
      setAllGroups(nextGroups);
      setAllTags(treeRes.all_tags || []);
      setAssets(catalog);
      setGroupRows(groups);
      const navIds = [
        ALL_SECTION,
        ...nextGroups.map((g) => g.id),
        ...(nextTree.some((s) => !s.id) ? [""] : []),
      ];
      setActiveSectionId((prev) => (navIds.includes(prev) ? prev : ALL_SECTION));
    } catch (err) {
      setError(err instanceof Error ? err.message : "资产加载失败");
    }
  };

  useEffect(() => {
    void load();
  }, [params.toString()]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!filterBarRef.current?.contains(e.target as Node)) setOpenMenu(null);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const selectedHost = hostId ? assetById.get(hostId) || null : null;
  const selectedGroup = groupId ? groupRows.find((g) => g.id === groupId) || null : null;
  const groupTabs = useMemo(() => {
    const byId = new Map(tree.map((s) => [s.id, s]));
    const items = allGroups.map((g) => ({
      id: g.id,
      name: g.name,
      count: byId.get(g.id)?.hosts.length ?? 0,
    }));
    const ungrouped = byId.get("");
    if (ungrouped) items.push({ id: "", name: "未分组", count: ungrouped.hosts.length });
    return items;
  }, [tree, allGroups]);
  const allViewHosts = useMemo(() => {
    const seen = new Map<string, TreeHost>();
    for (const section of tree) {
      for (const host of section.hosts) {
        if (seen.has(host.id)) continue;
        const catalog = assetById.get(host.id);
        seen.set(host.id, {
          ...host,
          aliases: host.aliases?.length ? host.aliases : aliasesFromAsset(catalog),
          services: catalog?.services?.length ? catalog.services : host.services,
          related_vulnerabilities: host.related_vulnerabilities?.length
            ? host.related_vulnerabilities
            : catalog?.related_vulnerabilities,
        });
      }
    }
    return [...seen.values()].sort((a, b) => a.address.localeCompare(b.address));
  }, [tree, assetById]);
  const isAll = activeSectionId === ALL_SECTION;
  const isUngrouped = activeSectionId === "";
  const activeSection = isAll
    ? { id: ALL_SECTION, name: "全部", hosts: allViewHosts }
    : tree.find((s) => s.id === activeSectionId) || {
        id: activeSectionId,
        name: groupTabs.find((n) => n.id === activeSectionId)?.name || "未分组",
        hosts: [] as TreeHost[],
      };
  const cardColumns = useCardColumns();
  const hostColumns = useMemo(
    () => splitRoundRobin(activeSection.hosts, cardColumns),
    [activeSection.hosts, cardColumns],
  );
  const moveTargets = useMemo(() => {
    const groups = allGroups.filter((g) => g.id !== activeSectionId);
    if (isAll || isGroupId(activeSectionId)) groups.push({ id: "", name: "未分组" });
    return groups;
  }, [allGroups, activeSectionId, isAll]);

  useEffect(() => {
    setSelectedIds([]);
    setMoveError("");
    setOpenMenu((m) => (m === "move" ? null : m));
  }, [activeSectionId]);

  const createAsset = async () => {
    if (!form.address.trim()) {
      setFormError("请填写 IP 或域名");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const created = await authFetch<Asset>("/api/assets", {
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
      for (const gid of form.groupIds) {
        await authFetch(`/api/asset-groups/${gid}/hosts/${created.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ports: [] }),
        });
      }
      setShowForm(false);
      setForm(EMPTY_FORM);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setSaving(false);
    }
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const assemblyPortsFor = (hostId: string, host: TreeHost | undefined) => {
    if (isGroupId(activeSectionId)) {
      const member = groupRows
        .find((g) => g.id === activeSectionId)
        ?.members.find((m) => m.asset_id === hostId);
      return member?.ports ?? [];
    }
    return (host?.services || []).map((s) => s.port);
  };

  const moveSelectedTo = async (targetId: string) => {
    if (!selectedIds.length) return;
    setMoving(true);
    setMoveError("");
    try {
      for (const id of selectedIds) {
        const host = activeSection.hosts.find((h) => h.id === id);
        const already = targetId
          ? Boolean(groupRows.find((g) => g.id === targetId)?.members.some((m) => m.asset_id === id))
          : false;
        if (targetId && !already) {
          await authFetch(`/api/asset-groups/${targetId}/hosts/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ports: assemblyPortsFor(id, host) }),
          });
        }
        if (isGroupId(activeSectionId)) {
          await authFetch(`/api/asset-groups/${activeSectionId}/hosts/${id}`, { method: "DELETE" });
        } else if (isAll && !targetId) {
          for (const group of groupRows) {
            if (group.members.some((m) => m.asset_id === id)) {
              await authFetch(`/api/asset-groups/${group.id}/hosts/${id}`, { method: "DELETE" });
            }
          }
        }
      }
      setSelectedIds([]);
      setOpenMenu(null);
      setActiveSectionId(targetId);
      await load();
    } catch (err) {
      setMoveError(err instanceof Error ? err.message : "移动失败");
      await load();
    } finally {
      setMoving(false);
    }
  };

  const startAddPort = (host: TreeHost) => {
    if (addPortHostId === host.id) {
      setAddPortHostId(null);
      setAddPortError("");
      return;
    }
    setAddPortHostId(host.id);
    setAddPortForm({ port: "", name: "" });
    setAddPortError("");
  };

  const addPortToHost = async (host: TreeHost) => {
    const port = addPortForm.port.trim();
    if (!port) {
      setAddPortError("请填写端口号");
      return;
    }
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      setAddPortError("端口号须为 1–65535 的数字");
      return;
    }
    const portNorm = String(Number(port));
    if ((host.services || []).some((s) => s.port === portNorm || s.port === port)) {
      setAddPortError(`端口 ${portNorm} 已存在`);
      return;
    }
    setAddingPort(true);
    setAddPortError("");
    try {
      const name = addPortForm.name.trim();
      await authFetch(`/api/assets/${host.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          services: [{ port: portNorm, name }],
        }),
      });
      if (isGroupId(activeSectionId)) {
        const member = groupRows
          .find((g) => g.id === activeSectionId)
          ?.members.find((m) => m.asset_id === host.id);
        const current = member?.ports ?? [];
        if (!current.includes(portNorm)) {
          await authFetch(`/api/asset-groups/${activeSectionId}/hosts/${host.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ports: [...current, portNorm] }),
          });
        }
      }
      setAddPortHostId(null);
      setAddPortForm({ port: "", name: "" });
      await load();
    } catch (err) {
      setAddPortError(err instanceof Error ? err.message : "添加端口失败");
    } finally {
      setAddingPort(false);
    }
  };

  const deletePortNow = async () => {
    if (!deletePort) return;
    setDeletingPort(true);
    setDeletePortError("");
    try {
      await authFetch(`/api/assets/${deletePort.assetId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remove_ports: [deletePort.port] }),
      });
      if (serviceKey?.assetId === deletePort.assetId && serviceKey.port === deletePort.port) {
        setServiceKey(null);
      }
      setDeletePort(null);
      await load();
    } catch (err) {
      setDeletePortError(err instanceof Error ? err.message : "删除端口失败");
    } finally {
      setDeletingPort(false);
    }
  };

  const deleteHostNow = async () => {
    if (!deleteHost) return;
    setDeletingHost(true);
    setDeleteHostError("");
    try {
      await authFetch(`/api/assets/${deleteHost.id}`, { method: "DELETE" });
      if (hostId === deleteHost.id) setHostId(null);
      if (serviceKey?.assetId === deleteHost.id) setServiceKey(null);
      if (addPortHostId === deleteHost.id) setAddPortHostId(null);
      setSelectedIds((prev) => prev.filter((id) => id !== deleteHost.id));
      setDeleteHost(null);
      await load();
    } catch (err) {
      setDeleteHostError(err instanceof Error ? err.message : "删除失败");
    } finally {
      setDeletingHost(false);
    }
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
      const created = await authFetch<AssetGroup>("/api/asset-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      setShowGroupForm(false);
      setGroupFormName("");
      setActiveSectionId(created.id);
      await load();
    } catch (err) {
      setGroupFormError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setSavingGroup(false);
    }
  };

  return (
    <div className="flex h-screen bg-canvas">
      <Sidebar activeId={null} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar title="资产管理" />
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="shrink-0 px-6 pt-6" ref={filterBarRef}>
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索地址 / 别名 / 端口 / 标签"
                className="min-w-[12rem] rounded-md border border-hairline bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-ink"
              />
              <MultiFilter
                label="标签"
                buttonText={multiLabel(selectedTags, "全部标签", allTags.map((t) => ({ value: t, label: t })))}
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
                onClick={() => {
                  setForm({
                    ...EMPTY_FORM,
                    groupIds: isGroupId(activeSectionId) ? [activeSectionId] : [],
                  });
                  setFormError("");
                  setShowForm(true);
                }}
                className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-ink px-4 py-2 text-sm font-medium text-on-ink"
              >
                <Plus className="h-4 w-4" />
                添加主机
              </button>
            </div>

            <div className="flex items-end gap-4 border-b border-hairline">
              <button
                type="button"
                onClick={() => setActiveSectionId(ALL_SECTION)}
                className={`shrink-0 border-b-2 pb-2.5 text-sm ${
                  isAll
                    ? "border-ink font-medium text-ink"
                    : "border-transparent text-ink-secondary hover:text-ink"
                }`}
              >
                全部
                <span className="ml-1.5 text-[11px] font-normal text-ink-muted">{allViewHosts.length}</span>
              </button>
              {groupTabs.length ? <span className="mb-2.5 h-3.5 w-px shrink-0 bg-hairline" /> : null}
              <div className="flex min-w-0 flex-1 gap-5 overflow-x-auto">
                {groupTabs.map((item) => {
                  const active = item.id === activeSectionId;
                  return (
                    <button
                      key={item.id || "ungrouped"}
                      type="button"
                      onClick={() => setActiveSectionId(item.id)}
                      className={`shrink-0 border-b-2 pb-2.5 text-sm ${
                        active
                          ? "border-ink font-medium text-ink"
                          : "border-transparent text-ink-secondary hover:text-ink"
                      }`}
                    >
                      {item.name}
                      <span className="ml-1.5 text-[11px] font-normal text-ink-muted">{item.count}</span>
                    </button>
                  );
                })}
              </div>
              <div className="flex shrink-0 items-center gap-2 pb-2">
                {selectedIds.length ? (
                  <div className="flex h-7 items-center gap-2 rounded-md border border-hairline bg-surface px-2 text-xs">
                    <span className="leading-none text-ink-secondary">已选 {selectedIds.length}</span>
                    <span className="h-3 w-px shrink-0 bg-hairline" />
                    <div className="relative">
                      <button
                        type="button"
                        disabled={moving || !moveTargets.length}
                        onClick={() => setOpenMenu((m) => (m === "move" ? null : "move"))}
                        className="p-0 font-medium leading-none text-ink disabled:opacity-50"
                      >
                        {moving ? "移动中…" : "移动到"}
                      </button>
                      {openMenu === "move" ? (
                        <div className="absolute right-0 z-20 mt-1 min-w-[8rem] overflow-y-auto rounded-md border border-hairline-soft bg-canvas py-1 shadow-lg">
                          {moveTargets.map((g) => (
                            <button
                              key={g.id || "ungrouped"}
                              type="button"
                              disabled={moving}
                              onClick={() => void moveSelectedTo(g.id)}
                              className="block w-full px-3 py-1.5 text-left text-xs hover:bg-surface-default"
                            >
                              {g.name}
                            </button>
                          ))}
                          {!moveTargets.length ? (
                            <p className="px-3 py-2 text-xs text-ink-muted">没有其他组</p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      disabled={moving}
                      onClick={() => {
                        setSelectedIds([]);
                        setMoveError("");
                      }}
                      className="p-0 leading-none text-ink-muted hover:text-ink"
                    >
                      取消
                    </button>
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    setGroupFormName("");
                    setGroupFormError("");
                    setShowGroupForm(true);
                  }}
                  className="h-7 rounded-md border border-hairline bg-surface px-2 text-xs leading-none text-ink hover:bg-canvas"
                >
                  新建组
                </button>
                {isGroupId(activeSectionId) ? (
                  <button
                    type="button"
                    onClick={() => setGroupId(activeSection.id)}
                    className="h-7 rounded-md border border-hairline bg-surface px-2 text-xs leading-none text-ink hover:bg-canvas"
                  >
                    编辑组
                  </button>
                ) : null}
              </div>
            </div>
            {error ? <p className="mt-3 text-sm text-severity-critical">{error}</p> : null}
            {moveError ? <p className="mt-3 text-sm text-severity-critical">{moveError}</p> : null}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {!activeSection.hosts.length ? (
              <p className="py-8 text-sm text-ink-muted">
                {isAll
                  ? "还没有主机。点右上角添加即可。"
                  : isUngrouped
                    ? "没有未分组的主机。"
                    : "这一组还没有主机。添加主机时选进这个组即可。"}
              </p>
            ) : (
              <div className="flex items-start gap-3">
                {hostColumns.map((column, colIdx) => (
                  <div key={colIdx} className="flex min-w-0 flex-1 flex-col gap-3">
                {column.map((host) => {
                  const catalog = assetById.get(host.id);
                  const aliases = host.aliases?.length ? host.aliases : aliasesFromAsset(catalog);
                  const ports = host.services?.length ? host.services : catalog?.services || [];
                  const vulns = host.related_vulnerabilities?.length
                    ? host.related_vulnerabilities
                    : catalog?.related_vulnerabilities || [];
                  const pathTotal = ports.reduce((n, s) => n + (s.paths?.length || 0), 0);
                  const displayName = host.name && host.name !== host.address ? host.name : "";
                  const hostNote = hostNoteFromAsset(catalog) || displayName;
                  const selected = selectedIds.includes(host.id);
                  return (
                    <article
                      key={host.id}
                      onClick={() => toggleSelected(host.id)}
                      className={`flex cursor-pointer flex-col rounded-lg border px-5 py-4 ${
                        selected ? "border-ink bg-surface" : "border-hairline bg-canvas hover:bg-surface"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1 text-left">
                          <div className="truncate font-mono text-base font-medium text-ink">{host.address}</div>
                          {aliases.map((alias) => (
                            <div key={alias} className="mt-0.5 truncate font-mono text-xs text-ink-secondary">
                              {alias}
                            </div>
                          ))}
                          {(host.tags?.length || hostNote) ? (
                            <div className="mt-2 flex flex-wrap items-center gap-1">
                              {(host.tags || []).map((tag) => (
                                <span key={tag} className="rounded-md bg-canvas-inset px-1.5 py-0.5 text-[11px] text-ink-secondary">
                                  {tag}
                                </span>
                              ))}
                              {hostNote ? (
                                <span className="min-w-0 truncate text-[11px] text-ink-muted">{hostNote}</span>
                              ) : null}
                            </div>
                          ) : null}
                          <p className="mt-2 text-[11px] text-ink-muted">
                            {[
                              ports.length ? `${ports.length} 个端口` : "无端口",
                              pathTotal ? `${pathTotal} 条攻击面` : null,
                              vulns.length ? `${vulns.length} 条发现` : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        </div>
                        <div
                          className="flex shrink-0 items-center gap-0.5 pt-0.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            title="编辑"
                            aria-label="编辑"
                            onClick={() => setHostId(host.id)}
                            className="rounded-md p-1 text-ink-muted hover:bg-canvas-inset hover:text-ink"
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            type="button"
                            title="添加端口"
                            aria-label="添加端口"
                            onClick={() => startAddPort(host)}
                            className="rounded-md p-1 text-ink-muted hover:bg-canvas-inset hover:text-ink"
                          >
                            <Plus size={14} />
                          </button>
                          <button
                            type="button"
                            title="删除主机"
                            aria-label="删除主机"
                            onClick={() => {
                              setDeleteHostError("");
                              setDeleteHost({ id: host.id, address: host.address });
                            }}
                            className="rounded-md p-1 text-ink-muted hover:bg-canvas-inset hover:text-severity-critical"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                      {addPortHostId === host.id ? (
                        <form
                          className="mt-3 flex flex-wrap items-end gap-2"
                          onClick={(e) => e.stopPropagation()}
                          onSubmit={(e) => {
                            e.preventDefault();
                            void addPortToHost(host);
                          }}
                        >
                          <label className="min-w-[6.5rem] space-y-1">
                            <span className="block text-[11px] text-ink-muted">端口</span>
                            <input
                              value={addPortForm.port}
                              onChange={(e) =>
                                setAddPortForm((prev) => ({
                                  ...prev,
                                  port: e.target.value.replace(/[^\d]/g, ""),
                                }))
                              }
                              placeholder="8080"
                              inputMode="numeric"
                              autoFocus
                              disabled={addingPort}
                              className="w-full rounded-md border border-hairline bg-surface px-2.5 py-2 font-mono text-sm text-ink outline-none focus:border-ink"
                            />
                          </label>
                          <label className="min-w-[8rem] flex-1 space-y-1">
                            <span className="block text-[11px] text-ink-muted">服务名（可选）</span>
                            <input
                              value={addPortForm.name}
                              onChange={(e) =>
                                setAddPortForm((prev) => ({ ...prev, name: e.target.value }))
                              }
                              placeholder="http / ssh"
                              disabled={addingPort}
                              className="w-full rounded-md border border-hairline bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-ink"
                            />
                          </label>
                          <button
                            type="button"
                            disabled={addingPort}
                            onClick={() => {
                              setAddPortHostId(null);
                              setAddPortError("");
                            }}
                            className="rounded-md border border-hairline px-2.5 py-1.5 text-xs"
                          >
                            取消
                          </button>
                          <button
                            type="submit"
                            disabled={addingPort || !addPortForm.port.trim()}
                            className="rounded-md bg-ink px-2.5 py-1.5 text-xs font-medium text-on-ink disabled:opacity-50"
                          >
                            {addingPort ? "添加中…" : "添加"}
                          </button>
                          {addPortError ? (
                            <p className="w-full text-[11px] text-severity-critical">{addPortError}</p>
                          ) : null}
                        </form>
                      ) : null}
                      <div className="mt-3 min-w-0 border-t border-hairline-soft pt-2">
                        {ports.length ? (
                          ports.map((svc) => {
                            const portVulns = vulns.filter((v) => String(v.port || "") === String(svc.port));
                            const portRisk = buildRiskChips(
                              portVulns.map((v) => ({
                                id: v.id,
                                title: v.title,
                                severity: v.severity,
                                status: v.status,
                                confidence: v.confidence,
                                port: v.port,
                                description: v.description,
                              })),
                            );
                            const vulnChips = portRisk.filter((c) => c.key.startsWith("sev-"));
                            const otherChips = portRisk.filter((c) => !c.key.startsWith("sev-"));
                            return (
                              <div
                                key={svc.port}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setServiceKey({ assetId: host.id, port: svc.port });
                                }}
                                className="group/port relative -mx-2 grid w-[calc(100%+1rem)] cursor-pointer grid-cols-[minmax(0,42%)_minmax(0,1fr)] items-start gap-3 rounded-md px-2 py-2 text-left hover:bg-canvas-inset"
                              >
                                <span className="min-w-0">
                                  <span className="block font-mono text-sm text-ink">
                                    {svc.name ? `${svc.port} / ${svc.name}` : svc.port}
                                  </span>
                                  {(svc.tags?.length || svc.note) ? (
                                    <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
                                      {(svc.tags || []).map((tag) => (
                                        <span
                                          key={tag}
                                          className="rounded-md bg-canvas-inset px-1.5 py-0.5 text-[11px] text-ink-secondary"
                                        >
                                          {tag}
                                        </span>
                                      ))}
                                      {svc.note ? (
                                        <span className="min-w-0 truncate text-[11px] text-ink-muted">{svc.note}</span>
                                      ) : null}
                                    </span>
                                  ) : null}
                                </span>
                                <span className="flex min-w-0 flex-col items-end gap-1">
                                  {vulnChips.length || otherChips.length ? (
                                    <>
                                      {vulnChips.length ? (
                                        <span className="flex min-w-0 flex-wrap justify-end gap-1">
                                          {vulnChips.map((c) => (
                                            <RiskChipBadge key={c.key} chip={c} />
                                          ))}
                                        </span>
                                      ) : null}
                                      {otherChips.length ? (
                                        <span className="flex min-w-0 flex-wrap justify-end gap-1">
                                          {otherChips.map((c) => (
                                            <RiskChipBadge key={c.key} chip={c} />
                                          ))}
                                        </span>
                                      ) : null}
                                    </>
                                  ) : (
                                    <span className="font-mono text-xs text-ink-muted">——</span>
                                  )}
                                </span>
                                <button
                                  type="button"
                                  title="删除端口"
                                  aria-label={`删除端口 ${svc.port}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setDeletePortError("");
                                    setDeletePort({
                                      assetId: host.id,
                                      port: svc.port,
                                      address: host.address,
                                    });
                                  }}
                                  className="absolute right-1 top-1/2 z-10 hidden -translate-y-1/2 rounded-md bg-canvas p-1.5 text-ink-muted shadow-sm hover:text-severity-critical group-hover/port:inline-flex"
                                >
                                  <Trash2 size={16} />
                                </button>
                              </div>
                            );
                          })
                        ) : (
                          <p className="text-sm text-ink-muted">{isUngrouped ? "还没有端口" : "裸主机"}</p>
                        )}
                      </div>
                    </article>
                  );
                })}
                  </div>
                ))}
              </div>
            )}
          </div>
        </main>
      </div>

      <AssetDetailDialog
        open={Boolean(hostId)}
        assetId={hostId}
        initial={selectedHost}
        knownTags={allTags}
        onClose={() => setHostId(null)}
        onSaved={() => void load()}
        onDeleted={() => {
          setHostId(null);
          void load();
        }}
      />

      <GroupLedgerDialog
        open={Boolean(selectedGroup)}
        group={selectedGroup}
        catalog={assets}
        onClose={() => setGroupId(null)}
        onSaved={() => void load()}
        onDeleted={() => {
          setGroupId(null);
          setActiveSectionId("");
          void load();
        }}
        onOpenHost={(id) => {
          setGroupId(null);
          setHostId(id);
        }}
        onOpenService={(assetId, port) => {
          setGroupId(null);
          setServiceKey({ assetId, port });
        }}
      />

      <ServiceLedgerDialog
        open={Boolean(serviceKey)}
        assetId={serviceKey?.assetId || null}
        port={serviceKey?.port || null}
        knownTags={allTags}
        onClose={() => setServiceKey(null)}
        onSaved={() => void load()}
      />

      <ConfirmDialog
        open={Boolean(deleteHost)}
        title="删除主机"
        description={`确定删除主机「${deleteHost?.address || "该主机"}」？关联漏洞仅解绑，不会删除。此操作不可撤销。`}
        busy={deletingHost}
        onCancel={() => {
          if (!deletingHost) {
            setDeleteHost(null);
            setDeleteHostError("");
          }
        }}
        onConfirm={() => void deleteHostNow()}
        error={deleteHostError || null}
      />
      <ConfirmDialog
        open={Boolean(deletePort)}
        title="删除端口"
        description={`确定从「${deletePort?.address || "该主机"}」移除端口 ${deletePort?.port || ""}？关联漏洞不会被删除，仅从端口清单中去掉。`}
        busy={deletingPort}
        onCancel={() => {
          if (!deletingPort) {
            setDeletePort(null);
            setDeletePortError("");
          }
        }}
        onConfirm={() => void deletePortNow()}
        error={deletePortError || null}
      />

      {showForm ? (
        <Modal title="添加主机" onClose={() => !saving && setShowForm(false)}>
          <p className="text-xs text-ink-muted">一个主机对应一个 IP 或域名。标签打在主机上，组是另外组装的。</p>
          <Field label="IP / 域名">
            <input
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              placeholder="10.0.0.8 或 pay.example.com"
              className="w-full rounded-md border border-hairline bg-surface px-2.5 py-2 font-mono text-sm text-ink outline-none focus:border-ink"
              autoFocus
            />
          </Field>
          <Field label="标签（可选，逗号分隔）">
            <input
              value={form.tags}
              onChange={(e) => setForm({ ...form, tags: e.target.value })}
              className="w-full rounded-md border border-hairline bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-ink"
            />
          </Field>
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-ink-secondary">放入组（可选）</span>
            {allGroups.length ? (
              <div className="flex flex-wrap gap-2">
                {allGroups.map((g) => {
                  const on = form.groupIds.includes(g.id);
                  return (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() =>
                        setForm((prev) => ({
                          ...prev,
                          groupIds: on
                            ? prev.groupIds.filter((id) => id !== g.id)
                            : [...prev.groupIds, g.id],
                        }))
                      }
                      className={`rounded-full border px-3 py-1 text-xs ${
                        on ? "border-ink bg-ink text-on-ink" : "border-hairline text-ink-secondary hover:border-ink"
                      }`}
                    >
                      {g.name}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-ink-muted">还没有组。可以先新建组，再回来选。</p>
            )}
          </div>
          {formError ? <p className="text-xs text-severity-critical">{formError}</p> : null}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" disabled={saving} onClick={() => setShowForm(false)} className="rounded-md border px-3 py-1.5 text-xs">
              取消
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void createAsset()}
              className="rounded-md bg-ink px-4 py-1.5 text-xs font-medium text-on-ink"
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </Modal>
      ) : null}

      {showGroupForm ? (
        <Modal title="新建组" onClose={() => !savingGroup && setShowGroupForm(false)}>
          <Field label="组名">
            <input
              value={groupFormName}
              onChange={(e) => setGroupFormName(e.target.value)}
              placeholder="XXX公司 / OA"
              className="w-full rounded-md border border-hairline bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-ink"
              autoFocus
            />
          </Field>
          {groupFormError ? <p className="text-xs text-severity-critical">{groupFormError}</p> : null}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" disabled={savingGroup} onClick={() => setShowGroupForm(false)} className="rounded-md border px-3 py-1.5 text-xs">
              取消
            </button>
            <button
              type="button"
              disabled={savingGroup}
              onClick={() => void createGroup()}
              className="rounded-md bg-ink px-4 py-1.5 text-xs font-medium text-on-ink"
            >
              {savingGroup ? "保存中…" : "保存"}
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function useCardColumns() {
  const [count, setCount] = useState(1);
  useEffect(() => {
    const lg = window.matchMedia("(min-width: 1024px)");
    const xl = window.matchMedia("(min-width: 1280px)");
    const apply = () => setCount(xl.matches ? 3 : lg.matches ? 2 : 1);
    apply();
    lg.addEventListener("change", apply);
    xl.addEventListener("change", apply);
    return () => {
      lg.removeEventListener("change", apply);
      xl.removeEventListener("change", apply);
    };
  }, []);
  return count;
}

function splitRoundRobin<T>(items: T[], columns: number): T[][] {
  const n = Math.max(1, columns);
  const cols: T[][] = Array.from({ length: n }, () => []);
  items.forEach((item, i) => cols[i % n].push(item));
  return cols;
}

function RiskChipBadge({ chip }: { chip: RiskChip }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase ${chip.badgeClass}`}
    >
      {chip.label}
      {chip.count > 1 ? <span className="opacity-80">{chip.count}</span> : null}
    </span>
  );
}

function hostNoteFromAsset(asset?: Asset): string {
  if (!asset) return "";
  const props = asset.properties || {};
  for (const key of ["note", "remark", "comment"] as const) {
    const text = String(props[key] ?? "").trim();
    if (text) return text;
  }
  return "";
}

function aliasesFromAsset(asset?: Asset): string[] {
  if (!asset) return [];
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

function toggleInList(list: string[], value: string, setList: (next: string[]) => void) {
  setList(list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);
}

function multiLabel(selected: string[], allLabel: string, options: { value: string; label: string }[]) {
  if (!selected.length) return allLabel;
  if (selected.length === 1) return options.find((o) => o.value === selected[0])?.label || selected[0];
  return `${selected.length} 项`;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-ink-secondary">{label}</span>
      {children}
    </label>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center theme-overlay px-4" onClick={onClose}>
      <div className="w-full max-w-md space-y-3 rounded-lg border border-hairline-soft bg-canvas p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">{title}</h2>
        {children}
      </div>
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
}: {
  label: string;
  buttonText: string;
  open: boolean;
  onToggle: () => void;
  onClear: () => void;
  options: { value: string; label: string }[];
  selected: string[];
  onToggleValue: (value: string) => void;
  emptyText?: string;
}) {
  return (
    <div className="relative">
      <button type="button" onClick={onToggle} className="rounded-md border border-hairline bg-surface px-2.5 py-2 text-sm text-ink hover:bg-canvas">
        {label}：{buttonText}
        {selected.length > 0 ? <span className="ml-1 text-[10px] text-ink-muted">{selected.length}</span> : null}
      </button>
      {open ? (
        <div className="absolute left-0 z-20 mt-1 max-h-64 min-w-[10rem] overflow-y-auto rounded-md border border-hairline-soft bg-canvas py-1 shadow-lg">
          <button type="button" className="block w-full px-3 py-1.5 text-left text-xs text-ink-muted hover:bg-surface-default" onClick={onClear}>
            清除
          </button>
          {options.map((opt) => (
            <label key={opt.value} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-surface-default">
              <input type="checkbox" checked={selected.includes(opt.value)} onChange={() => onToggleValue(opt.value)} />
              <span className="truncate">{opt.label}</span>
            </label>
          ))}
          {!options.length && emptyText ? <p className="px-3 py-2 text-xs text-ink-muted">{emptyText}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
