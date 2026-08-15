import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Clock,
  History,
  Network,
  Pencil,
  Plus,
  Server,
  ShieldAlert,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";
import { authFetch } from "../lib/api";
import { handleTypedInput, useRenderAudit } from "../lib/renderAudit";
import AssetDetailDialog from "../components/AssetDetailDialog";
import ConfirmDialog from "../components/ConfirmDialog";
import GroupLedgerDialog from "../components/GroupLedgerDialog";
import ServiceLedgerDialog from "../components/ServiceLedgerDialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { buildRiskChips, type RiskChip } from "../components/cards/FindingCard";
import { parseBulkHostCsv, summarizeBulkGroups } from "../lib/bulkHostImport";

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
  created_at?: string | null;
  updated_at?: string | null;
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
  created_at?: string | null;
  updated_at?: string | null;
};

/** Host list sort modes (UI filter bar). Icons carry direction / meaning; no parenthetical copy. */
type HostSortKey = "address" | "created_desc" | "created_asc" | "ports_desc" | "vulns_desc";

const HOST_SORT_OPTIONS: { value: HostSortKey; label: string; Icon: LucideIcon }[] = [
  { value: "address", label: "地址", Icon: Network },
  { value: "created_desc", label: "最新添加", Icon: History },
  { value: "created_asc", label: "最早添加", Icon: Clock },
  { value: "ports_desc", label: "端口数", Icon: Server },
  { value: "vulns_desc", label: "漏洞数", Icon: ShieldAlert },
];

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
const BULK_PLACEHOLDER = `address,port,protocol,name
10.0.0.1,80,tcp,http
10.0.0.1,443,tcp,https
pay.example.com,8080,tcp,http
10.0.0.2,22,tcp,ssh
# 同一主机多行 = 多端口；port 也可写 80/tcp
# 协议可选 tcp/udp/http/https…；仅主机一行也可
`;

function isGroupId(id: string) {
  return Boolean(id) && id !== ALL_SECTION;
}

/** IPv4 → [a,b,c,d] for numeric compare; null if not IPv4. */
function parseIPv4(address: string): number[] | null {
  const s = String(address || "").trim();
  // Strip optional brackets / zone / trailing port only when clearly IPv4 host:port
  const host = s.includes(":") && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(s) ? s.split(":")[0] : s;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1, 5).map((x) => Number(x));
  if (parts.some((n) => n > 255)) return null;
  return parts;
}

/** Default address order: IPv4 by octet, then domains A–Z (case-insensitive). IPs before domains. */
function compareHostAddress(a: string, b: string): number {
  const ia = parseIPv4(a);
  const ib = parseIPv4(b);
  if (ia && ib) {
    for (let i = 0; i < 4; i++) {
      if (ia[i] !== ib[i]) return ia[i] - ib[i];
    }
    return 0;
  }
  if (ia && !ib) return -1;
  if (!ia && ib) return 1;
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

function hostPortCount(h: TreeHost): number {
  return (h.services || []).length;
}

function hostVulnCount(h: TreeHost): number {
  return (h.related_vulnerabilities || []).length || h.risk?.open_total || 0;
}

function hostCreatedMs(h: TreeHost): number {
  const raw = h.created_at || h.updated_at;
  if (!raw) return 0;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}

function sortHosts(hosts: TreeHost[], key: HostSortKey): TreeHost[] {
  const list = [...hosts];
  list.sort((a, b) => {
    let cmp = 0;
    switch (key) {
      case "created_desc":
        cmp = hostCreatedMs(b) - hostCreatedMs(a);
        break;
      case "created_asc":
        cmp = hostCreatedMs(a) - hostCreatedMs(b);
        break;
      case "ports_desc":
        cmp = hostPortCount(b) - hostPortCount(a);
        break;
      case "vulns_desc":
        cmp = hostVulnCount(b) - hostVulnCount(a);
        break;
      case "address":
      default:
        cmp = compareHostAddress(a.address, b.address);
        break;
    }
    if (cmp !== 0) return cmp;
    // Stable tie-break: numeric IP / alpha address, then id.
    const addr = compareHostAddress(a.address, b.address);
    if (addr !== 0) return addr;
    return a.id.localeCompare(b.id);
  });
  return list;
}

export default function AssetPage() {
  useRenderAudit("AssetPage");
  const [search, setSearch] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [hostSort, setHostSort] = useState<HostSortKey>("address");
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
  /** single = one host field; bulk = CSV multi host/port/protocol */
  const [createMode, setCreateMode] = useState<"single" | "bulk">("single");
  const [bulkText, setBulkText] = useState("");
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
  /** Multi-select: remove from assembly (→ 未分组), not hard-delete Host. */
  const [confirmBulkRemove, setConfirmBulkRemove] = useState(false);
  const [removingBulk, setRemovingBulk] = useState(false);
  const [bulkRemoveError, setBulkRemoveError] = useState("");
  /** Multi-select: hard-delete Hosts from ledger (all Groups lose them). */
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [deletingBulk, setDeletingBulk] = useState(false);
  const [bulkDeleteError, setBulkDeleteError] = useState("");

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
        authFetch<Asset[]>("/api/assets?limit=2000"),
        authFetch<AssetGroup[]>("/api/asset-groups").catch(() => [] as AssetGroup[]),
      ]);
      const nextTree = treeRes.groups || [];
      const nextGroups = treeRes.all_groups || [];
      setTree(nextTree);
      setAllGroups(nextGroups);
      setAllTags(treeRes.all_tags || []);
      setAssets(catalog);
      setGroupRows(groups);
      // Drop only vanished Hosts (deleted). Keep selection across search/tag filters.
      const live = new Set(catalog.map((a) => a.id));
      setSelectedIds((prev) => prev.filter((id) => live.has(id)));
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
  const enrichHost = (host: TreeHost): TreeHost => {
    const catalog = assetById.get(host.id);
    return {
      ...host,
      aliases: host.aliases?.length ? host.aliases : aliasesFromAsset(catalog),
      services: catalog?.services?.length ? catalog.services : host.services || [],
      related_vulnerabilities: host.related_vulnerabilities?.length
        ? host.related_vulnerabilities
        : catalog?.related_vulnerabilities,
      created_at: host.created_at || catalog?.created_at || null,
      updated_at: host.updated_at || catalog?.updated_at || null,
    };
  };

  const allViewHosts = useMemo(() => {
    const seen = new Map<string, TreeHost>();
    for (const section of tree) {
      for (const host of section.hosts) {
        if (seen.has(host.id)) continue;
        seen.set(host.id, enrichHost(host));
      }
    }
    return sortHosts([...seen.values()], hostSort);
  }, [tree, assetById, hostSort]);
  const isAll = activeSectionId === ALL_SECTION;
  const isUngrouped = activeSectionId === "";
  const activeSection = useMemo(() => {
    if (isAll) {
      return { id: ALL_SECTION, name: "全部", hosts: allViewHosts };
    }
    const section = tree.find((s) => s.id === activeSectionId);
    const raw = section?.hosts || [];
    const hosts = sortHosts(raw.map(enrichHost), hostSort);
    return {
      id: activeSectionId,
      name: section?.name || groupTabs.find((n) => n.id === activeSectionId)?.name || "未分组",
      hosts,
    };
  }, [isAll, allViewHosts, tree, activeSectionId, groupTabs, hostSort, assetById]);
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

  // Selection is sticky across search / tags / tab changes so multi-step pick works
  // (filter → select → refilter → select more → move). Only cleared by 取消, after
  // bulk ops, or when a Host is deleted from the ledger.

  const bulkPreview = useMemo(() => parseBulkHostCsv(bulkText), [bulkText]);

  const attachToGroups = async (assetId: string, ports: string[]) => {
    for (const gid of form.groupIds) {
      await authFetch(`/api/asset-groups/${gid}/hosts/${assetId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ports }),
      });
    }
  };

  const createAsset = async () => {
    if (createMode === "bulk") {
      const parsed = parseBulkHostCsv(bulkText);
      if (!parsed.groups.length) {
        setFormError(
          parsed.errors.length
            ? parsed.errors.slice(0, 3).join("；")
            : "请粘贴 CSV：address,port,protocol,name",
        );
        return;
      }
      setSaving(true);
      setFormError("");
      try {
        let ok = 0;
        const fail: string[] = [];
        for (const group of parsed.groups) {
          try {
            const created = await authFetch<Asset>("/api/assets", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                address: group.address,
                tags: group.tags,
                ports: group.services.map((s) => s.port),
                services: group.services.map((s) => ({
                  port: s.port,
                  protocol: s.protocol || undefined,
                  name: s.name || undefined,
                })),
                group_ids: form.groupIds,
              }),
            });
            await attachToGroups(
              created.id,
              group.services.map((s) => s.port),
            );
            ok += 1;
          } catch (err) {
            fail.push(
              `${group.address}: ${err instanceof Error ? err.message : "失败"}`,
            );
          }
        }
        if (!ok && fail.length) {
          setFormError(fail.slice(0, 4).join("；"));
          return;
        }
        setShowForm(false);
        setForm(EMPTY_FORM);
        setBulkText("");
        setCreateMode("single");
        if (fail.length) {
          setError(`已创建 ${ok} 台，部分失败：${fail.slice(0, 3).join("；")}`);
        }
        await load();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "批量创建失败");
      } finally {
        setSaving(false);
      }
      return;
    }

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
          group_ids: form.groupIds,
        }),
      });
      await attachToGroups(created.id, []);
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

  const sectionHostIds = useMemo(
    () => activeSection.hosts.map((h) => h.id),
    [activeSection.hosts],
  );
  const selectedInViewCount = useMemo(
    () => sectionHostIds.filter((id) => selectedIds.includes(id)).length,
    [sectionHostIds, selectedIds],
  );
  const selectedOutsideViewCount = selectedIds.length - selectedInViewCount;
  const allSectionSelected =
    sectionHostIds.length > 0 && sectionHostIds.every((id) => selectedIds.includes(id));
  const someSectionSelected =
    sectionHostIds.some((id) => selectedIds.includes(id)) && !allSectionSelected;

  /** Toggle only the current filtered list; other selected ids stay (accumulate across filters). */
  const toggleSelectAllSection = () => {
    if (allSectionSelected) {
      setSelectedIds((prev) => prev.filter((id) => !sectionHostIds.includes(id)));
      return;
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of sectionHostIds) next.add(id);
      return [...next];
    });
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

  const resolveHostForPorts = (id: string): TreeHost | undefined => {
    const fromView =
      activeSection.hosts.find((h) => h.id === id) || allViewHosts.find((h) => h.id === id);
    if (fromView) return fromView;
    const a = assetById.get(id);
    if (!a) return undefined;
    return {
      id: a.id,
      address: a.address,
      name: a.name,
      tags: a.tags || [],
      aliases: aliasesFromAsset(a),
      services: a.services || [],
    } as TreeHost;
  };

  const portsByAssetForSelection = (ids: string[]) => {
    const ports_by_asset: Record<string, string[]> = {};
    for (const id of ids) {
      ports_by_asset[id] = assemblyPortsFor(id, resolveHostForPorts(id));
    }
    return ports_by_asset;
  };

  const moveSelectedTo = async (targetId: string) => {
    if (!selectedIds.length) return;
    setMoving(true);
    setMoveError("");
    try {
      // One request / one DB transaction — not N× PUT+DELETE (was ~30s for /24).
      await authFetch("/api/asset-groups/batch-move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          asset_ids: selectedIds,
          target_group_id: targetId || null,
          source_group_id: isGroupId(activeSectionId) ? activeSectionId : null,
          remove_from_all_groups: Boolean(isAll && !targetId),
          ports_by_asset: portsByAssetForSelection(selectedIds),
          default_ports: [],
        }),
      });
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

  const selectedAddresses = useMemo(() => {
    const byId = new Map<string, string>();
    for (const a of assets) byId.set(a.id, a.address);
    for (const h of activeSection.hosts) byId.set(h.id, h.address);
    return selectedIds.map((id) => byId.get(id) || id);
  }, [selectedIds, activeSection.hosts, assets]);

  /** Drop assembly membership; Host stays in ledger (lands in 未分组 if no other Group). */
  const removeSelectedNow = async () => {
    if (!selectedIds.length) return;
    // Already ungrouped — nothing to remove from.
    if (isUngrouped) {
      setConfirmBulkRemove(false);
      return;
    }
    setRemovingBulk(true);
    setBulkRemoveError("");
    try {
      await authFetch("/api/asset-groups/batch-move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          asset_ids: selectedIds,
          target_group_id: null,
          // Named group tab: only leave this Group (other Groups keep the Host).
          source_group_id: isGroupId(activeSectionId) ? activeSectionId : null,
          // 全部: strip every assembly → 未分组.
          remove_from_all_groups: Boolean(isAll),
          default_ports: [],
        }),
      });
      setSelectedIds([]);
      setConfirmBulkRemove(false);
      await load();
    } catch (err) {
      setBulkRemoveError(err instanceof Error ? err.message : "移出失败");
    } finally {
      setRemovingBulk(false);
    }
  };

  /** Permanently delete Hosts from owner ledger (assemblies cascade away). */
  const deleteSelectedNow = async () => {
    if (!selectedIds.length) return;
    setDeletingBulk(true);
    setBulkDeleteError("");
    const ids = [...selectedIds];
    try {
      await authFetch("/api/assets/batch-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asset_ids: ids }),
      });
      if (hostId && ids.includes(hostId)) setHostId(null);
      if (serviceKey && ids.includes(serviceKey.assetId)) setServiceKey(null);
      if (addPortHostId && ids.includes(addPortHostId)) setAddPortHostId(null);
      setSelectedIds([]);
      setConfirmBulkDelete(false);
      await load();
    } catch (err) {
      setBulkDeleteError(err instanceof Error ? err.message : "批量删除失败");
    } finally {
      setDeletingBulk(false);
    }
  };

  const bulkBusy = moving || removingBulk || deletingBulk;

  const createGroup = async () => {
    const name = groupFormName.trim();
    if (!name) {
      setGroupFormError("请填写组名");
      return;
    }
    const attachIds = [...selectedIds];
    setSavingGroup(true);
    setGroupFormError("");
    try {
      const created = await authFetch<AssetGroup>("/api/asset-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (attachIds.length) {
        // Create + move selected Hosts into the new Group in one user action.
        await authFetch("/api/asset-groups/batch-move", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            asset_ids: attachIds,
            target_group_id: created.id,
            source_group_id: isGroupId(activeSectionId) ? activeSectionId : null,
            remove_from_all_groups: false,
            ports_by_asset: portsByAssetForSelection(attachIds),
            default_ports: [],
          }),
        });
        setSelectedIds([]);
      }
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
                onChange={handleTypedInput("AssetPage.search", setSearch, { allow: ["AssetPage"] })}
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
              <Select
                value={hostSort}
                onValueChange={(v) => setHostSort(v as HostSortKey)}
              >
                <SelectTrigger
                  className="w-auto min-w-[9rem] max-w-[16rem] shrink-0"
                  aria-label="主机列表排序"
                >
                  <SelectValue placeholder="排序：地址">
                    {`排序：${HOST_SORT_OPTIONS.find((o) => o.value === hostSort)?.label || "地址"}`}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {HOST_SORT_OPTIONS.map((opt) => {
                    const Icon = opt.Icon;
                    return (
                      <SelectItem key={opt.value} value={opt.value}>
                        <span className="inline-flex items-center gap-2">
                          <Icon className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden />
                          {opt.label}
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <button
                type="button"
                onClick={() => {
                  setForm({
                    ...EMPTY_FORM,
                    groupIds: isGroupId(activeSectionId) ? [activeSectionId] : [],
                  });
                  setFormError("");
                  setCreateMode("single");
                  setBulkText("");
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
                {activeSection.hosts.length ? (
                  <label className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-hairline bg-surface px-2 text-xs leading-none text-ink hover:bg-canvas">
                    <input
                      type="checkbox"
                      checked={allSectionSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someSectionSelected;
                      }}
                      onChange={toggleSelectAllSection}
                      className="rounded border-hairline"
                      aria-label="全选当前列表主机"
                    />
                    <span>
                      {allSectionSelected
                        ? "取消当前列表"
                        : `全选当前列表${activeSection.hosts.length ? ` ${activeSection.hosts.length}` : ""}`}
                    </span>
                  </label>
                ) : null}
                {selectedIds.length ? (
                  <div className="flex h-7 items-center gap-2 rounded-md border border-hairline bg-surface px-2 text-xs">
                    <span className="leading-none text-ink-secondary" title="搜索/筛选不会清空已选；可跨条件累加">
                      已选 {selectedIds.length}
                      {selectedOutsideViewCount > 0
                        ? `（当前列表 ${selectedInViewCount}）`
                        : ""}
                    </span>
                    <span className="h-3 w-px shrink-0 bg-hairline" />
                    <div className="relative">
                      <button
                        type="button"
                        disabled={bulkBusy || !moveTargets.length}
                        onClick={() => setOpenMenu((m) => (m === "move" ? null : "move"))}
                        className="p-0 font-medium leading-none text-ink disabled:opacity-50"
                      >
                        {moving ? "移动中…" : "移动到"}
                      </button>
                      {openMenu === "move" ? (
                        <div className="absolute right-0 z-20 mt-1 max-h-60 min-w-[8rem] overflow-y-auto rounded-md border border-hairline-soft bg-canvas py-1 shadow-lg">
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
                    {!isUngrouped ? (
                      <button
                        type="button"
                        disabled={bulkBusy}
                        onClick={() => {
                          setBulkRemoveError("");
                          setConfirmBulkDelete(false);
                          setConfirmBulkRemove(true);
                          setOpenMenu(null);
                        }}
                        className="p-0 font-medium leading-none text-ink disabled:opacity-50"
                      >
                        移出
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={bulkBusy}
                      onClick={() => {
                        setBulkDeleteError("");
                        setConfirmBulkRemove(false);
                        setConfirmBulkDelete(true);
                        setOpenMenu(null);
                      }}
                      className="p-0 font-medium leading-none text-severity-critical disabled:opacity-50"
                    >
                      删除
                    </button>
                    <button
                      type="button"
                      disabled={bulkBusy}
                      onClick={() => {
                        setSelectedIds([]);
                        setMoveError("");
                        setBulkRemoveError("");
                        setBulkDeleteError("");
                        setConfirmBulkRemove(false);
                        setConfirmBulkDelete(false);
                      }}
                      className="p-0 leading-none text-ink-muted hover:text-ink"
                    >
                      取消
                    </button>
                  </div>
                ) : null}
                <button
                  type="button"
                  disabled={bulkBusy || savingGroup}
                  onClick={() => {
                    setGroupFormName("");
                    setGroupFormError("");
                    setShowGroupForm(true);
                  }}
                  className="h-7 rounded-md border border-hairline bg-surface px-2 text-xs leading-none text-ink hover:bg-canvas disabled:opacity-50"
                >
                  {selectedIds.length
                    ? `新建并加入组（${selectedIds.length}）`
                    : "新建组"}
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
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleSelected(host.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="shrink-0 rounded border-hairline"
                            aria-label={`选择 ${host.address}`}
                          />
                          <div className="truncate font-mono text-base font-medium text-ink">
                            {host.address}
                          </div>
                        </div>
                        <div
                          className="flex shrink-0 items-center gap-0.5"
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
        open={confirmBulkRemove && selectedIds.length > 0}
        title={`移出 ${selectedIds.length} 台主机`}
        description={
          selectedIds.length
            ? isAll
              ? `确定将已选 ${selectedIds.length} 台（${selectedAddresses.slice(0, 3).join("、")}${
                  selectedAddresses.length > 3 ? " 等" : ""
                }）从所有组移出？主机仍保留在台账，会进入「未分组」。`
              : `确定将已选 ${selectedIds.length} 台（${selectedAddresses.slice(0, 3).join("、")}${
                  selectedAddresses.length > 3 ? " 等" : ""
                }）从当前组移出？主机仍保留；若不在其他组则进入「未分组」。`
            : ""
        }
        busy={removingBulk}
        confirmLabel="移出"
        onCancel={() => {
          if (!removingBulk) {
            setConfirmBulkRemove(false);
            setBulkRemoveError("");
          }
        }}
        onConfirm={() => void removeSelectedNow()}
        error={bulkRemoveError || null}
      />
      <ConfirmDialog
        open={confirmBulkDelete && selectedIds.length > 0}
        title={`删除 ${selectedIds.length} 台主机`}
        description={
          selectedIds.length
            ? `确定彻底删除已选 ${selectedIds.length} 台主机（${selectedAddresses.slice(0, 3).join("、")}${
                selectedAddresses.length > 3 ? " 等" : ""
              }）？将从台账移除，并从所有组消失。关联漏洞仅解绑，不会删除。此操作不可撤销。`
            : ""
        }
        busy={deletingBulk}
        confirmLabel="删除"
        onCancel={() => {
          if (!deletingBulk) {
            setConfirmBulkDelete(false);
            setBulkDeleteError("");
          }
        }}
        onConfirm={() => void deleteSelectedNow()}
        error={bulkDeleteError || null}
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
          <div className="flex gap-1 rounded-md border border-hairline bg-canvas-inset p-0.5">
            {(
              [
                { id: "single" as const, label: "单台" },
                { id: "bulk" as const, label: "批量 CSV" },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                disabled={saving}
                onClick={() => {
                  setCreateMode(tab.id);
                  setFormError("");
                }}
                className={`flex-1 rounded px-2 py-1.5 text-xs font-medium ${
                  createMode === tab.id ? "bg-canvas text-ink shadow-sm" : "text-ink-secondary hover:text-ink"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {createMode === "single" ? (
            <>
              <p className="text-xs text-ink-muted">一个主机对应一个 IP 或域名。端口可在卡片上继续添加。</p>
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
            </>
          ) : (
            <>
              <p className="text-xs leading-relaxed text-ink-muted">
                每行一台主机的一个端口。列：
                <span className="font-mono text-ink-secondary"> address,port,protocol,name[,tags]</span>
                。同一 IP 多行会合并；协议如 tcp/udp/http/https；也支持{" "}
                <span className="font-mono">80/tcp</span> 或 <span className="font-mono">host:443</span>。
              </p>
              <Field label="CSV / 粘贴">
                <textarea
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  rows={10}
                  placeholder={BULK_PLACEHOLDER}
                  spellCheck={false}
                  className="w-full resize-y rounded-md border border-hairline bg-surface px-2.5 py-2 font-mono text-[12px] leading-relaxed text-ink outline-none focus:border-ink"
                  autoFocus
                />
              </Field>
              {bulkText.trim() ? (
                <div className="rounded-md border border-hairline-soft bg-canvas-inset px-2.5 py-2 text-[11px] text-ink-secondary">
                  <p className="font-medium text-ink">{summarizeBulkGroups(bulkPreview.groups)}</p>
                  {bulkPreview.groups.length ? (
                    <ul className="mt-1.5 max-h-28 space-y-0.5 overflow-y-auto font-mono">
                      {bulkPreview.groups.slice(0, 12).map((g) => (
                        <li key={g.address}>
                          {g.address}
                          {g.services.length
                            ? ` · ${g.services.map((s) => (s.protocol ? `${s.port}/${s.protocol}` : s.port)).join(", ")}`
                            : ""}
                          {g.tags.length ? ` · tags:${g.tags.join("|")}` : ""}
                        </li>
                      ))}
                      {bulkPreview.groups.length > 12 ? (
                        <li className="text-ink-muted">…另有 {bulkPreview.groups.length - 12} 台</li>
                      ) : null}
                    </ul>
                  ) : null}
                  {bulkPreview.errors.length ? (
                    <p className="mt-1 text-severity-critical">
                      {bulkPreview.errors.slice(0, 3).join("；")}
                      {bulkPreview.errors.length > 3 ? "…" : ""}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </>
          )}

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
              {saving
                ? "保存中…"
                : createMode === "bulk"
                  ? `创建${bulkPreview.groups.length ? ` ${bulkPreview.groups.length} 台` : ""}`
                  : "保存"}
            </button>
          </div>
        </Modal>
      ) : null}

      {showGroupForm ? (
        <Modal
          title={selectedIds.length ? "新建并加入组" : "新建组"}
          onClose={() => !savingGroup && setShowGroupForm(false)}
        >
          <Field label="组名">
            <input
              value={groupFormName}
              onChange={(e) => setGroupFormName(e.target.value)}
              placeholder="XXX公司 / OA"
              className="w-full rounded-md border border-hairline bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-ink"
              autoFocus
            />
          </Field>
          {selectedIds.length ? (
            <p className="text-xs text-ink-muted">
              将创建该组，并把已选 {selectedIds.length} 台主机移入（
              {selectedAddresses.slice(0, 3).join("、")}
              {selectedAddresses.length > 3 ? " 等" : ""}
              ）。
              {isGroupId(activeSectionId) ? " 同时从当前组移出。" : ""}
            </p>
          ) : null}
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
              {savingGroup
                ? selectedIds.length
                  ? "创建并加入中…"
                  : "保存中…"
                : selectedIds.length
                  ? `创建并加入 ${selectedIds.length} 台`
                  : "保存"}
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
