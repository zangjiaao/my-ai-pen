import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";
import { authFetch } from "../lib/api";
import AssetDetailDialog from "../components/AssetDetailDialog";
import GroupLedgerDialog from "../components/GroupLedgerDialog";
import ServiceLedgerDialog from "../components/ServiceLedgerDialog";

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

type TreeHost = {
  id: string;
  address: string;
  name: string;
  tags: string[];
  aliases: string[];
  services: Service[];
  related_vulnerabilities?: RelatedVuln[];
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
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [openMenu, setOpenMenu] = useState<"tag" | "group" | null>(null);
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
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [hostId, setHostId] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [serviceKey, setServiceKey] = useState<{ assetId: string; port: string } | null>(null);

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
      const [treeRes, catalog, groups] = await Promise.all([
        authFetch<AssetTree>(`/api/assets/tree?${params}`),
        authFetch<Asset[]>("/api/assets?limit=200"),
        authFetch<AssetGroup[]>("/api/asset-groups").catch(() => [] as AssetGroup[]),
      ]);
      setTree(treeRes.groups || []);
      setAllGroups(treeRes.all_groups || []);
      setAllTags(treeRes.all_tags || []);
      setAssets(catalog);
      setGroupRows(groups);
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
      await authFetch<AssetGroup>("/api/asset-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      setShowGroupForm(false);
      setGroupFormName("");
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
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden px-8 py-6">
          <div className="mb-6 flex shrink-0 flex-wrap items-center gap-3" ref={filterBarRef}>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="关键词：地址 / 别名 / 端口 / 标签 / 组名"
              className="min-w-[20rem] flex-1 rounded-md border border-hairline bg-canvas px-4 py-2.5 text-[15px] focus:border-ink focus:outline-none"
            />
            <MultiFilter
              label="组"
              buttonText={multiLabel(selectedGroups, "全部", allGroups.map((g) => ({ value: g.id, label: g.name })))}
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
              buttonText={multiLabel(selectedTags, "全部", allTags.map((t) => ({ value: t, label: t })))}
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
                  setForm(EMPTY_FORM);
                  setFormError("");
                  setShowForm(true);
                }}
                className="rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-on-ink"
              >
                添加主机
              </button>
              <button
                type="button"
                onClick={() => {
                  setGroupFormName("");
                  setGroupFormError("");
                  setShowGroupForm(true);
                }}
                className="rounded-full border border-hairline px-5 py-2.5 text-sm"
              >
                新建组
              </button>
            </div>
          </div>

          {error ? (
            <div className="mb-4 shrink-0 rounded-md border border-severity-critical/30 bg-severity-critical-subtle px-4 py-3 text-sm text-severity-critical">
              {error}
            </div>
          ) : null}

          <div className="min-h-0 flex-1 space-y-8 overflow-y-auto pb-10">
            {tree.map((section) => {
              const key = section.id || "ungrouped";
              const isOpen = !collapsed[key];
              const isUngrouped = !section.id;
              return (
                <section key={key}>
                  <div className="mb-3 flex items-center gap-3">
                    <button
                      type="button"
                      className="flex items-center gap-2 text-ink"
                      onClick={() => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))}
                      aria-expanded={isOpen}
                      aria-label={isOpen ? "收起组" : "展开组"}
                    >
                      <span className="text-sm text-ink-muted">{isOpen ? "▾" : "▸"}</span>
                    </button>
                    {isUngrouped ? (
                      <span className="text-xl font-medium tracking-tight">{section.name}</span>
                    ) : (
                      <button
                        type="button"
                        className="text-xl font-medium tracking-tight hover:underline"
                        onClick={() => setGroupId(section.id)}
                      >
                        {section.name}
                      </button>
                    )}
                    <span className="text-sm text-ink-muted">{section.hosts.length} 台</span>
                  </div>
                  {isOpen ? (
                    <div className="space-y-4">
                      {!section.hosts.length ? (
                        <p className="rounded-lg border border-dashed border-hairline px-6 py-8 text-sm text-ink-muted">
                          组是空的。添加主机时选进这个组即可。
                        </p>
                      ) : null}
                      {section.hosts.map((host) => {
                        const aliases = host.aliases?.length
                          ? host.aliases
                          : aliasesFromAsset(assetById.get(host.id));
                        const ports = host.services || [];
                        return (
                          <article
                            key={`${section.id}:${host.id}`}
                            className="flex overflow-hidden rounded-lg border border-hairline bg-canvas"
                          >
                            <button
                              type="button"
                              onClick={() => setHostId(host.id)}
                              className="flex w-[38%] min-w-[16rem] flex-col items-start justify-between border-r border-hairline px-6 py-5 text-left hover:bg-surface"
                            >
                              <div className="w-full">
                                <div className="truncate font-mono text-[22px] font-medium leading-tight tracking-tight text-ink">
                                  {host.address}
                                </div>
                                {aliases.map((alias) => (
                                  <div
                                    key={alias}
                                    className="mt-1.5 truncate font-mono text-[13px] text-ink-secondary"
                                  >
                                    {alias}
                                  </div>
                                ))}
                              </div>
                              {host.tags?.length ? (
                                <div className="mt-5 flex flex-wrap gap-1.5">
                                  {host.tags.map((tag) => (
                                    <span
                                      key={tag}
                                      className="rounded-md bg-surface px-2 py-0.5 text-[12px] text-ink-secondary"
                                    >
                                      {tag}
                                    </span>
                                  ))}
                                </div>
                              ) : (
                                <span className="mt-5 text-[12px] text-ink-muted">无标签</span>
                              )}
                            </button>
                            <div className="min-w-0 flex-1">
                              {ports.length ? (
                                ports.map((svc) => (
                                  <button
                                    key={svc.port}
                                    type="button"
                                    onClick={() => setServiceKey({ assetId: host.id, port: svc.port })}
                                    className="flex w-full items-center justify-between gap-4 border-b border-hairline-soft px-6 py-3.5 last:border-b-0 hover:bg-surface"
                                  >
                                    <span className="font-mono text-[15px] text-ink">
                                      {svc.name ? `${svc.port} / ${svc.name}` : svc.port}
                                    </span>
                                    <span className="flex flex-wrap justify-end gap-1.5">
                                      {(svc.tags || []).map((tag) => (
                                        <span
                                          key={tag}
                                          className="rounded-md bg-surface px-2 py-0.5 text-[12px] text-ink-secondary"
                                        >
                                          {tag}
                                        </span>
                                      ))}
                                    </span>
                                  </button>
                                ))
                              ) : (
                                <div className="px-6 py-8 text-sm text-ink-muted">
                                  {isUngrouped ? "还没有端口" : "裸主机 · 本组未选端口"}
                                </div>
                              )}
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  ) : null}
                </section>
              );
            })}
            {!tree.length ? (
              <p className="px-2 py-20 text-center text-sm text-ink-muted">
                {assets.length ? "没有匹配的主机。" : "还没有资产。添加主机，再建组组装。"}
              </p>
            ) : null}
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
          setSelectedGroups((prev) => prev.filter((id) => id !== groupId));
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
