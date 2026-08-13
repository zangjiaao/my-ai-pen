import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";
import { authFetch } from "../lib/api";
import AssetDetailDialog from "../components/AssetDetailDialog";
import GroupLedgerDialog from "../components/GroupLedgerDialog";
import ServiceLedgerDialog from "../components/ServiceLedgerDialog";
import { buildRiskChips } from "../components/cards/FindingCard";

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

export default function AssetPage() {
  const [search, setSearch] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [openMenu, setOpenMenu] = useState<"tag" | null>(null);
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
  const [activeSectionId, setActiveSectionId] = useState<string>("");
  const [hostId, setHostId] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [serviceKey, setServiceKey] = useState<{ assetId: string; port: string } | null>(null);

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
        ...nextGroups.map((g) => g.id),
        ...(nextTree.some((s) => !s.id) ? [""] : []),
      ];
      setActiveSectionId((prev) => (navIds.includes(prev) ? prev : navIds[0] ?? ""));
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
  const navItems = useMemo(() => {
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
  const activeSection = tree.find((s) => s.id === activeSectionId) || {
    id: activeSectionId,
    name: navItems.find((n) => n.id === activeSectionId)?.name || "未分组",
    hosts: [] as TreeHost[],
  };
  const isUngrouped = !activeSection.id;

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
            <div className="mb-5 flex flex-wrap items-center gap-3">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索地址 / 别名 / 端口 / 标签"
                className="min-w-[12rem] rounded-md border border-hairline px-3 py-2 text-sm focus:border-ink focus:outline-none"
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
              <div className="ml-auto flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setGroupFormName("");
                    setGroupFormError("");
                    setShowGroupForm(true);
                  }}
                  className="rounded-md border border-hairline px-3 py-2 text-sm hover:bg-surface"
                >
                  新建组
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setForm({
                      ...EMPTY_FORM,
                      groupIds: activeSectionId ? [activeSectionId] : [],
                    });
                    setFormError("");
                    setShowForm(true);
                  }}
                  className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-on-ink"
                >
                  添加主机
                </button>
              </div>
            </div>

            <div className="flex items-end justify-between gap-4 border-b border-hairline">
              <div className="flex min-w-0 flex-1 gap-5 overflow-x-auto">
                {navItems.map((item) => {
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
                {!navItems.length ? (
                  <span className="pb-2.5 text-sm text-ink-muted">还没有组</span>
                ) : null}
              </div>
              {!isUngrouped ? (
                <button
                  type="button"
                  onClick={() => setGroupId(activeSection.id)}
                  className="mb-2.5 shrink-0 text-xs text-ink-secondary hover:text-ink"
                >
                  编辑组
                </button>
              ) : null}
            </div>
            {error ? <p className="mt-3 text-sm text-severity-critical">{error}</p> : null}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {!activeSection.hosts.length ? (
              <p className="py-8 text-sm text-ink-muted">
                {navItems.length
                  ? "这一组还没有主机。添加主机时选进这个组即可。"
                  : "先新建组，再添加主机。"}
              </p>
            ) : (
              <div className="space-y-3">
                {activeSection.hosts.map((host) => {
                  const catalog = assetById.get(host.id);
                  const aliases = host.aliases?.length ? host.aliases : aliasesFromAsset(catalog);
                  const ports = host.services?.length ? host.services : catalog?.services || [];
                  const vulns = host.related_vulnerabilities?.length
                    ? host.related_vulnerabilities
                    : catalog?.related_vulnerabilities || [];
                  const pathTotal = ports.reduce((n, s) => n + (s.paths?.length || 0), 0);
                  const riskChips = buildRiskChips(
                    vulns.map((v) => ({
                      id: v.id,
                      title: v.title,
                      severity: v.severity,
                      status: v.status,
                      confidence: v.confidence,
                      port: v.port,
                      description: v.description,
                    })),
                  );
                  const displayName = host.name && host.name !== host.address ? host.name : "";
                  return (
                    <article
                      key={host.id}
                      className="grid grid-cols-[minmax(14rem,34%)_minmax(0,1fr)] gap-x-10 rounded-lg border border-hairline bg-canvas px-5 py-4 hover:bg-surface"
                    >
                      <button
                        type="button"
                        onClick={() => setHostId(host.id)}
                        className="min-w-0 self-start text-left"
                      >
                        <div className="truncate font-mono text-base font-medium text-ink">{host.address}</div>
                        {displayName ? (
                          <div className="mt-0.5 truncate text-xs text-ink-secondary">{displayName}</div>
                        ) : null}
                        {aliases.map((alias) => (
                          <div key={alias} className="mt-0.5 truncate font-mono text-xs text-ink-secondary">
                            {alias}
                          </div>
                        ))}
                        {host.tags?.length ? (
                          <div className="mt-3 flex flex-wrap gap-1">
                            {host.tags.map((tag) => (
                              <span key={tag} className="rounded-md bg-canvas-inset px-1.5 py-0.5 text-[11px] text-ink-secondary">
                                {tag}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        <div className="mt-3 flex flex-wrap items-center gap-1.5">
                          {riskChips.slice(0, 4).map((c) => (
                            <span
                              key={c.key}
                              className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase ${c.badgeClass}`}
                            >
                              {c.label}
                              <span className="opacity-80">{c.count}</span>
                            </span>
                          ))}
                        </div>
                        <p className="mt-2 text-[11px] text-ink-muted">
                          {[
                            ports.length ? `${ports.length} 个端口` : "无端口",
                            pathTotal ? `${pathTotal} 条攻击面` : null,
                            vulns.length ? `${vulns.length} 条发现` : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </button>
                      <div className="min-w-0 self-center">
                        {ports.length ? (
                          ports.map((svc) => {
                            const portVulns = vulns.filter((v) => String(v.port || "") === String(svc.port));
                            const paths = svc.paths || [];
                            return (
                              <button
                                key={svc.port}
                                type="button"
                                onClick={() => setServiceKey({ assetId: host.id, port: svc.port })}
                                className="-mx-2 flex w-[calc(100%+1rem)] items-start justify-between gap-4 rounded-md px-2 py-2 text-left hover:bg-canvas-inset"
                              >
                                <span className="min-w-0">
                                  <span className="font-mono text-sm text-ink">
                                    {svc.name ? `${svc.port} / ${svc.name}` : svc.port}
                                    {svc.protocol && svc.protocol !== svc.name ? (
                                      <span className="ml-1.5 text-[11px] text-ink-muted">{svc.protocol}</span>
                                    ) : null}
                                  </span>
                                  {svc.note ? (
                                    <span className="mt-0.5 block truncate text-[11px] text-ink-secondary">
                                      {svc.note}
                                    </span>
                                  ) : null}
                                  {paths.length ? (
                                    <span className="mt-0.5 block truncate font-mono text-[11px] text-ink-muted">
                                      {paths
                                        .slice(0, 2)
                                        .map((p) => p.path)
                                        .join("  ")}
                                      {paths.length > 2 ? `  +${paths.length - 2}` : ""}
                                    </span>
                                  ) : null}
                                </span>
                                <span className="flex shrink-0 flex-col items-end gap-1">
                                  <span className="flex flex-wrap justify-end gap-1">
                                    {(svc.tags || []).map((tag) => (
                                      <span
                                        key={tag}
                                        className="rounded-md bg-canvas-inset px-1.5 py-0.5 text-[11px] text-ink-secondary"
                                      >
                                        {tag}
                                      </span>
                                    ))}
                                  </span>
                                  {paths.length || portVulns.length ? (
                                    <span className="text-[11px] text-ink-muted">
                                      {[
                                        paths.length ? `${paths.length} 路径` : null,
                                        portVulns.length ? `${portVulns.length} 发现` : null,
                                      ]
                                        .filter(Boolean)
                                        .join(" · ")}
                                    </span>
                                  ) : null}
                                </span>
                              </button>
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
            )}
          </div>
        </main>
      </div>

      <AssetDetailDialog
        open={Boolean(hostId)}
        assetId={hostId}
        initial={selectedHost}
        knownTags={allTags}
        groups={groupRows}
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

      {showForm ? (
        <Modal title="添加主机" onClose={() => !saving && setShowForm(false)}>
          <p className="text-xs text-ink-muted">一个主机对应一个 IP 或域名。标签打在主机上，组是另外组装的。</p>
          <Field label="IP / 域名">
            <input
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              placeholder="10.0.0.8 或 pay.example.com"
              className="w-full rounded-md border border-hairline px-3 py-2 font-mono text-sm"
              autoFocus
            />
          </Field>
          <Field label="标签（可选，逗号分隔）">
            <input
              value={form.tags}
              onChange={(e) => setForm({ ...form, tags: e.target.value })}
              className="w-full rounded-md border border-hairline px-3 py-2 text-sm"
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
              className="w-full rounded-md border border-hairline px-3 py-2 text-sm"
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
      <button type="button" onClick={onToggle} className="rounded-md border border-hairline px-3.5 py-2.5 text-sm hover:bg-surface">
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
