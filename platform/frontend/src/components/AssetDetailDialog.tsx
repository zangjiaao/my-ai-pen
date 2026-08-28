import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { authFetch } from "../lib/api";
import { asString, type SecurityAsset, type SecurityVulnerability } from "../lib/securityTypes";
import FindingCard, { groupFindingsByKind } from "./cards/FindingCard";
import { IntelList, useAssetIntel } from "./IntelList";
import VulnDetailDialog from "./VulnDetailDialog";
import ConfirmDialog from "./ConfirmDialog";

type DetailTab = "edit" | "ports" | "intel" | "risk";

type ServiceRow = {
  port: string;
  name?: string;
  tags?: string[];
  note?: string | null;
};

type RelatedVuln = {
  id: string;
  title: string;
  severity: string;
  status: string;
  confidence?: string;
  port?: string | null;
  description?: string | null;
};

type AssetDetail = Omit<SecurityAsset, "related_vulnerabilities"> & {
  type_label?: string;
  source_label?: string;
  ports_summary?: string;
  tech_summary?: string;
  services?: ServiceRow[];
  risk?: {
    open_total: number;
    label?: string;
  };
  related_vulnerabilities?: RelatedVuln[];
};

interface Props {
  open: boolean;
  assetId?: string | null;
  initial?: Partial<AssetDetail> | null;
  knownTags?: string[];
  /** @deprecated use knownTags */
  systems?: string[];
  onClose: () => void;
  onSaved?: (asset: AssetDetail) => void;
  onDeleted?: (id: string) => void;
}

export default function AssetDetailDialog({
  open,
  assetId,
  initial,
  knownTags = [],
  systems = [],
  onClose,
  onSaved,
  onDeleted,
}: Props) {
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<DetailTab>("edit");
  const [form, setForm] = useState({ note: "", address: "", tags: [] as string[], aliases: [] as string[] });
  const [tagDraft, setTagDraft] = useState("");
  const [aliasDraft, setAliasDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [selectedVuln, setSelectedVuln] = useState<Partial<SecurityVulnerability> | null>(null);
  const [selectedPorts, setSelectedPorts] = useState<string[]>([]);
  const [confirmRemovePorts, setConfirmRemovePorts] = useState(false);
  const [removingPorts, setRemovingPorts] = useState(false);
  const id = assetId || initial?.id || initial?.asset_id || null;
  const tagSuggestions = Array.from(new Set([...knownTags, ...systems].filter(Boolean)));
  const loadGen = useRef(0);

  useEffect(() => {
    if (!open) return;
    const gen = ++loadGen.current;
    setError("");
    setTab("edit");
    setSelectedVuln(null);
    setConfirmDelete(false);
    setSelectedPorts([]);
    setConfirmRemovePorts(false);
    setTagDraft("");
    setAliasDraft("");
    const seed = normalizeInitial(initial);
    setDetail(seed);
    if (seed) applyForm(seed);
    if (!id) return;
    setLoading(true);
    authFetch<AssetDetail>(`/api/assets/${id}`)
      .then((data) => {
        if (gen !== loadGen.current) return;
        setDetail(data);
        applyForm(data);
      })
      .catch((err) => {
        if (gen !== loadGen.current) return;
        setError(err instanceof Error ? err.message : "资产加载失败");
      })
      .finally(() => {
        if (gen === loadGen.current) setLoading(false);
      });
  }, [open, id]);

  const asset = detail || normalizeInitial(initial);
  const savedAliases = aliasesFromDetail(asset);
  const vulns = (asset?.related_vulnerabilities || []) as RelatedVuln[];
  const host = asString(asset?.address, "");
  const services = useMemo(
    () => normalizeServices(asset?.services || asset?.properties?.services),
    [asset?.services, asset?.properties],
  );

  const findingRows = useMemo(
    () =>
      vulns.map((v) => ({
        id: v.id,
        vulnerability_id: v.id,
        title: v.title,
        severity: v.severity,
        status: v.status,
        confidence: v.confidence,
        port: v.port,
        description: v.description,
        affected_asset: host || undefined,
        location: v.port ? `:${v.port}` : undefined,
      })) as Array<Record<string, unknown>>,
    [vulns, host],
  );
  const riskGroups = useMemo(() => groupFindingsByKind(findingRows), [findingRows]);
  const { rows: intelRows } = useAssetIntel(id ? String(id) : null);

  const tabs: { key: DetailTab; label: string; count?: number }[] = [
    { key: "edit", label: "编辑" },
    { key: "ports", label: "端口", count: services.length },
    { key: "intel", label: "情报", count: intelRows.filter((r) => (r.forget_count || 0) <= 0).length },
    { key: "risk", label: "漏洞", count: vulns.length },
  ];

  const availableSuggestions = useMemo(() => {
    const selected = new Set(form.tags.map((t) => t.toLowerCase()));
    return tagSuggestions.filter((t) => !selected.has(t.toLowerCase()));
  }, [tagSuggestions, form.tags]);

  function applyForm(data: AssetDetail) {
    setForm({
      note: hostNoteFromDetail(data),
      address: asString(data.address),
      tags: Array.isArray(data.tags) ? data.tags.map(String).filter(Boolean) : [],
      aliases: aliasesFromDetail(data),
    });
    setTagDraft("");
    setAliasDraft("");
  }

  const addTag = (raw: string) => {
    const tag = raw.trim();
    if (!tag) return;
    setForm((prev) => {
      if (prev.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return prev;
      return { ...prev, tags: [...prev.tags, tag] };
    });
    setTagDraft("");
  };

  const removeTag = (tag: string) => {
    setForm((prev) => ({
      ...prev,
      tags: prev.tags.filter((t) => t.toLowerCase() !== tag.toLowerCase()),
    }));
  };

  const onTagKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(tagDraft);
      return;
    }
    if (e.key === "Backspace" && !tagDraft && form.tags.length) {
      removeTag(form.tags[form.tags.length - 1]);
    }
  };

  const addAlias = (raw: string) => {
    const alias = raw.trim();
    if (!alias) return;
    const primary = form.address.trim().toLowerCase();
    if (alias.toLowerCase() === primary) return;
    setForm((prev) => {
      if (prev.aliases.some((a) => a.toLowerCase() === alias.toLowerCase())) return prev;
      return { ...prev, aliases: [...prev.aliases, alias] };
    });
    setAliasDraft("");
  };

  const removeAlias = (alias: string) => {
    setForm((prev) => ({
      ...prev,
      aliases: prev.aliases.filter((a) => a.toLowerCase() !== alias.toLowerCase()),
    }));
  };

  const onAliasKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addAlias(aliasDraft);
      return;
    }
    if (e.key === "Backspace" && !aliasDraft && form.aliases.length) {
      removeAlias(form.aliases[form.aliases.length - 1]);
    }
  };

  const saveEdit = async () => {
    if (!id) return;
    if (!form.address.trim()) {
      setError("请填写 IP 或域名");
      return;
    }
    const tags = [...form.tags];
    const draft = tagDraft.trim();
    if (draft && !tags.some((t) => t.toLowerCase() === draft.toLowerCase())) {
      tags.push(draft);
    }
    const aliases = [...form.aliases];
    const aliasIn = aliasDraft.trim();
    const primary = form.address.trim().toLowerCase();
    if (
      aliasIn &&
      aliasIn.toLowerCase() !== primary &&
      !aliases.some((a) => a.toLowerCase() === aliasIn.toLowerCase())
    ) {
      aliases.push(aliasIn);
    }
    setSaving(true);
    setError("");
    loadGen.current += 1;
    try {
      const updated = await authFetch<AssetDetail>(`/api/assets/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: form.address.trim(),
          tags,
          aliases,
          note: form.note.trim(),
        }),
      });
      const returned = aliasesFromDetail(updated);
      const kept = {
        ...updated,
        aliases: returned.length ? returned : aliases,
        properties: {
          ...(updated.properties || {}),
          aliases: returned.length ? returned : aliases,
        },
      };
      setDetail(kept);
      applyForm(kept);
      onSaved?.(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const togglePort = (port: string) => {
    setSelectedPorts((prev) => (prev.includes(port) ? prev.filter((p) => p !== port) : [...prev, port]));
  };

  const toggleAllPorts = () => {
    if (selectedPorts.length === services.length) {
      setSelectedPorts([]);
      return;
    }
    setSelectedPorts(services.map((s) => s.port));
  };

  const removeSelectedPorts = async () => {
    if (!id || !selectedPorts.length) return;
    setRemovingPorts(true);
    setError("");
    try {
      const updated = await authFetch<AssetDetail>(`/api/assets/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remove_ports: selectedPorts }),
      });
      setDetail(updated);
      setSelectedPorts([]);
      setConfirmRemovePorts(false);
      onSaved?.(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除端口失败");
    } finally {
      setRemovingPorts(false);
    }
  };

  const deleteAsset = async () => {
    if (!id) return;
    setDeleting(true);
    setError("");
    try {
      await authFetch(`/api/assets/${id}`, { method: "DELETE" });
      setConfirmDelete(false);
      onDeleted?.(id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center theme-overlay px-4 py-6" onClick={onClose}>
      <div
        className="flex max-h-[min(88vh,720px)] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-hairline-soft bg-canvas shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-5 pt-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                <h2 className="truncate font-mono text-lg font-semibold">
                  {asString(asset?.address, "资产")}
                </h2>
                {hostNoteFromDetail(asset) ? (
                  <span className="truncate text-xs text-ink-muted">{hostNoteFromDetail(asset)}</span>
                ) : null}
              </div>
              {savedAliases.length ? (
                <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[11px] text-ink-secondary">
                  {savedAliases.map((alias) => (
                    <span key={alias}>{alias}</span>
                  ))}
                </div>
              ) : null}
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
                {(asset?.source_label || asset?.source) && (
                  <span className="rounded-md bg-canvas-inset px-1.5 py-0.5 text-[11px] text-ink-secondary">
                    {asString(asset?.source_label || asset?.source)}
                  </span>
                )}
                {asset?.updated_at ? (
                  <span title={asString(asset.updated_at)}>更新 {formatDate(asset.updated_at)}</span>
                ) : null}
                {loading ? <span>加载中…</span> : null}
              </div>
            </div>
            <button type="button" onClick={onClose} className="rounded-md border px-3 py-1.5 text-xs">
              关闭
            </button>
          </div>
        </div>

        <div className="shrink-0 border-b border-hairline-soft px-5">
          <div className="flex gap-4">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => {
                  setTab(t.key);
                  setError("");
                }}
                className={`px-0.5 py-2.5 text-[13px] font-medium ${
                  tab === t.key
                    ? "border-b-2 border-ink text-ink"
                    : "border-b-2 border-transparent text-ink-secondary hover:text-ink"
                }`}
              >
                {t.label}
                {t.count != null && t.count > 0 ? (
                  <span className="ml-1 text-[11px] font-normal text-ink-muted">{t.count}</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <div className="mb-3 rounded-md border border-severity-critical/30 bg-severity-critical-subtle px-3 py-2 text-sm text-severity-critical">
              {error}
            </div>
          )}

          {tab === "edit" && (
            <div className="space-y-3">
              <label className="block space-y-1">
                <span className="text-[11px] text-ink-muted">IP / 域名</span>
                <input
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  className="w-full rounded-md border border-hairline bg-surface px-2.5 py-2 font-mono text-sm text-ink outline-none focus:border-ink"
                />
              </label>

              <div className="space-y-1">
                <span className="text-[11px] text-ink-muted">别名</span>
                <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 py-2">
                  {form.aliases.map((alias) => (
                    <span
                      key={alias}
                      className="inline-flex items-center gap-1 rounded-md bg-canvas-inset px-2 py-1 font-mono text-xs text-ink"
                    >
                      {alias}
                      <button
                        type="button"
                        onClick={() => removeAlias(alias)}
                        className="rounded text-ink-muted hover:text-severity-critical"
                        aria-label={`移除别名 ${alias}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    value={aliasDraft}
                    onChange={(e) => setAliasDraft(e.target.value)}
                    onKeyDown={onAliasKeyDown}
                    onBlur={() => {
                      if (aliasDraft.trim()) addAlias(aliasDraft);
                    }}
                    placeholder={form.aliases.length ? "继续添加…" : "例如 localhost"}
                    className="min-w-[8rem] flex-1 border-0 bg-transparent px-1 py-1 font-mono text-sm text-ink outline-none placeholder:text-ink-muted"
                  />
                  <button
                    type="button"
                    disabled={!aliasDraft.trim()}
                    onClick={() => addAlias(aliasDraft)}
                    className="shrink-0 rounded-md border border-hairline px-2 py-1 text-[11px] text-ink-secondary hover:bg-canvas disabled:opacity-40"
                  >
                    添加
                  </button>
                </div>
                <p className="text-[11px] leading-relaxed text-ink-muted">
                  同一主机的其它地址（IP / 域名）。备注不当身份。
                </p>
              </div>

              <div className="space-y-1">
                <span className="text-[11px] text-ink-muted">标签</span>
                <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 py-2">
                  {form.tags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1 rounded-md bg-canvas-inset px-2 py-1 text-xs text-ink"
                    >
                      {tag}
                      <button
                        type="button"
                        onClick={() => removeTag(tag)}
                        className="rounded text-ink-muted hover:text-severity-critical"
                        aria-label={`移除标签 ${tag}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value)}
                    onKeyDown={onTagKeyDown}
                    onBlur={() => {
                      if (tagDraft.trim()) addTag(tagDraft);
                    }}
                    placeholder={form.tags.length ? "继续添加…" : "输入标签后回车"}
                    className="min-w-[8rem] flex-1 border-0 bg-transparent px-1 py-1 text-sm text-ink outline-none placeholder:text-ink-muted"
                  />
                  <button
                    type="button"
                    disabled={!tagDraft.trim()}
                    onClick={() => addTag(tagDraft)}
                    className="shrink-0 rounded-md border border-hairline px-2 py-1 text-[11px] text-ink-secondary hover:bg-canvas disabled:opacity-40"
                  >
                    添加
                  </button>
                </div>
                {availableSuggestions.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {availableSuggestions.slice(0, 8).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => addTag(t)}
                        className="rounded-md border border-dashed border-hairline px-2 py-0.5 text-[11px] text-ink-secondary hover:border-ink hover:bg-surface-default hover:text-ink"
                      >
                        + {t}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              <label className="block space-y-1">
                <span className="text-[11px] text-ink-muted">备注</span>
                <textarea
                  value={form.note}
                  onChange={(e) => setForm({ ...form, note: e.target.value })}
                  rows={3}
                  className="w-full rounded-md border border-hairline bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-ink"
                />
              </label>

              <div className="rounded-md border border-severity-critical/30 bg-severity-critical-subtle/40 p-3.5">
                <p className="text-sm font-medium text-severity-critical">危险区域</p>
                <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
                  删除资产后不可恢复。关联漏洞只会解绑，不会一并删除。
                </p>
                <button
                  type="button"
                  disabled={deleting || !id}
                  onClick={() => {
                    setError("");
                    setConfirmDelete(true);
                  }}
                  className="mt-3 rounded-md border border-severity-critical/40 bg-canvas px-3 py-1.5 text-xs font-medium text-severity-critical hover:bg-severity-critical-subtle disabled:opacity-50"
                >
                  {deleting ? "删除中…" : "删除资产"}
                </button>
              </div>
            </div>
          )}

          {tab === "ports" && (
            <div className="space-y-2">
              {services.length ? (
                <>
                  <div className="flex items-center justify-between gap-2 pb-1">
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-secondary">
                      <input
                        type="checkbox"
                        checked={selectedPorts.length === services.length}
                        onChange={toggleAllPorts}
                      />
                      全选
                    </label>
                    <span className="text-[11px] text-ink-muted">
                      {selectedPorts.length ? `已选 ${selectedPorts.length}` : "勾选后可批量删除"}
                    </span>
                  </div>
                  {services.map((svc) => {
                    const on = selectedPorts.includes(svc.port);
                    return (
                      <label
                        key={svc.port}
                        className={`flex cursor-pointer items-start gap-2.5 rounded-md border px-2.5 py-2 ${
                          on ? "border-ink bg-surface" : "border-hairline-soft hover:bg-surface"
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={on}
                          onChange={() => togglePort(svc.port)}
                        />
                        <span className="min-w-0 flex-1">
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
                      </label>
                    );
                  })}
                </>
              ) : (
                <p className="py-6 text-center text-sm text-ink-muted">这台主机还没有端口。可在卡片上添加。</p>
              )}
            </div>
          )}

          {tab === "intel" && (
            <IntelList
              rows={intelRows}
              emptyCopy="这台主机还没有线索。Agent 笔记本会记在这里。"
            />
          )}

          {tab === "risk" && (
            <div className="space-y-4">
              {riskGroups.map((group) =>
                group.items.length === 0 ? null : (
                  <section key={group.id} className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium text-ink-muted">
                        {group.label} ({group.items.length})
                      </p>
                      <span className="font-mono text-[10px] text-ink-muted">{group.hint}</span>
                    </div>
                    {group.items.map((finding, index) => (
                      <FindingCard
                        key={String(finding.id || finding.vulnerability_id || `${group.id}-${index}`)}
                        finding={{
                          ...finding,
                          finding_kind: group.id === "auth" ? "auth" : group.id,
                          kind: group.id === "auth" ? "auth" : group.id,
                          category: group.id === "auth" ? "auth" : group.id,
                        }}
                        onOpen={setSelectedVuln}
                      />
                    ))}
                  </section>
                ),
              )}
              {!vulns.length && <p className="py-6 text-center text-sm text-ink-muted">暂无风险项</p>}
            </div>
          )}
        </div>

        {tab === "edit" && (
          <div className="shrink-0 border-t border-hairline-soft px-5 py-3">
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className="rounded-md border px-3 py-1.5 text-xs">
                取消
              </button>
              <button
                type="button"
                disabled={saving || !id}
                onClick={() => void saveEdit()}
                onMouseDown={(e) => e.preventDefault()}
                className="rounded-md bg-ink px-4 py-1.5 text-xs font-medium text-on-ink disabled:opacity-50"
              >
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        )}
        {tab === "ports" && selectedPorts.length > 0 ? (
          <div className="shrink-0 border-t border-hairline-soft px-5 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-ink-secondary">已选 {selectedPorts.length} 个端口</span>
              <button
                type="button"
                disabled={removingPorts || !id}
                onClick={() => {
                  setError("");
                  setConfirmRemovePorts(true);
                }}
                className="rounded-md border border-severity-critical/40 px-3 py-1.5 text-xs font-medium text-severity-critical hover:bg-severity-critical-subtle disabled:opacity-50"
              >
                删除选中
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <VulnDetailDialog
        open={Boolean(selectedVuln)}
        vulnerabilityId={(selectedVuln?.id || selectedVuln?.vulnerability_id) as string | undefined}
        initial={selectedVuln}
        onClose={() => setSelectedVuln(null)}
      />

      <ConfirmDialog
        open={confirmDelete}
        title="删除资产"
        description={`确定删除资产「${host || form.address || "该资产"}」？关联漏洞仅解绑，不会删除。此操作不可撤销。`}
        busy={deleting}
        onCancel={() => {
          if (!deleting) setConfirmDelete(false);
        }}
        onConfirm={() => void deleteAsset()}
        error={error || null}
      />
      <ConfirmDialog
        open={confirmRemovePorts}
        title="删除端口"
        description={`确定从该主机移除 ${selectedPorts.length} 个端口（${selectedPorts.join(", ")}）？关联漏洞不会被删除，仅从端口清单中去掉。`}
        busy={removingPorts}
        onCancel={() => {
          if (!removingPorts) setConfirmRemovePorts(false);
        }}
        onConfirm={() => void removeSelectedPorts()}
        error={error || null}
      />
    </div>
  );
}

function normalizeInitial(initial?: Props["initial"]): AssetDetail | null {
  if (!initial) return null;
  return {
    id: String(initial.id || initial.asset_id || ""),
    asset_id: initial.asset_id,
    name: asString(initial.name || initial.address, "未知资产"),
    address: asString(initial.address),
    type: asString(initial.type || initial.asset_type, "host"),
    asset_type: initial.asset_type,
    type_label: initial.type_label,
    source_label: initial.source_label,
    tags: initial.tags || [],
    properties: initial.properties || {},
    open_ports: initial.open_ports,
    services: initial.services as ServiceRow[] | undefined,
    source: initial.source,
    risk: initial.risk,
    ports_summary: initial.ports_summary,
    tech_summary: initial.tech_summary,
    related_vulnerabilities: (initial.related_vulnerabilities || []) as RelatedVuln[],
    created_at: initial.created_at,
    updated_at: initial.updated_at,
  };
}

function normalizeServices(value: unknown): ServiceRow[] {
  if (!Array.isArray(value)) return [];
  const rows: ServiceRow[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const port = String(rec.port ?? "").trim();
    if (!port) continue;
    const noteRaw = rec.note ?? rec.remark ?? rec.comment;
    rows.push({
      port,
      name: asString(rec.name || rec.service || rec.product, ""),
      note: typeof noteRaw === "string" && noteRaw.trim() ? noteRaw.trim() : null,
      tags: Array.isArray(rec.tags)
        ? rec.tags.map((t) => String(t).trim()).filter(Boolean)
        : [],
    });
  }
  return rows.sort((a, b) => Number(a.port) - Number(b.port));
}

function aliasesFromDetail(asset?: AssetDetail | null): string[] {
  if (!asset) return [];
  const fromList = (raw: unknown): string[] => {
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
  };
  const top = fromList(asset.aliases);
  if (top.length) return top;
  return fromList((asset.properties as { aliases?: unknown } | undefined)?.aliases);
}

function hostNoteFromDetail(asset?: AssetDetail | null): string {
  if (!asset) return "";
  const props = asset.properties || {};
  for (const key of ["note", "remark", "comment"] as const) {
    const text = String(props[key] ?? "").trim();
    if (text) return text;
  }
  if (asset.name && asset.name !== asset.address) return asString(asset.name);
  return "";
}

function formatDate(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value.slice(0, 10);
  return d.toLocaleDateString();
}
