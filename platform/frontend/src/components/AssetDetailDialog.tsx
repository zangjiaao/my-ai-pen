import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { authFetch } from "../lib/api";
import { asString, type SecurityAsset, type SecurityVulnerability } from "../lib/securityTypes";
import FindingCard, { groupFindingsByKind } from "./cards/FindingCard";
import VulnDetailDialog from "./VulnDetailDialog";
import ConfirmDialog from "./ConfirmDialog";

type DetailTab = "overview" | "risk" | "edit";

type RelatedVuln = {
  id: string;
  title: string;
  severity: string;
  status: string;
  confidence?: string;
  port?: string | null;
  description?: string | null;
};

type ServiceRow = {
  port: string;
  name?: string;
  protocol?: string | null;
  product?: string | null;
  version?: string | null;
  url?: string | null;
  note?: string | null;
};

type AssetDetail = SecurityAsset & {
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
  const [tab, setTab] = useState<DetailTab>("overview");
  const [form, setForm] = useState({ name: "", address: "", tags: [] as string[] });
  const [tagDraft, setTagDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [selectedVuln, setSelectedVuln] = useState<Partial<SecurityVulnerability> | null>(null);
  /** port -> draft note text while editing */
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  const [editingNotePort, setEditingNotePort] = useState<string | null>(null);
  const [savingNotePort, setSavingNotePort] = useState<string | null>(null);
  const [showAddPort, setShowAddPort] = useState(false);
  const [addPortForm, setAddPortForm] = useState({ port: "", name: "", note: "" });
  const [addingPort, setAddingPort] = useState(false);
  const [removingPort, setRemovingPort] = useState<string | null>(null);
  const [confirmRemovePort, setConfirmRemovePort] = useState<string | null>(null);
  const id = assetId || initial?.id || initial?.asset_id || null;
  const tagSuggestions = Array.from(new Set([...knownTags, ...systems].filter(Boolean)));

  useEffect(() => {
    if (!open) return;
    setError("");
    setTab("overview");
    setSelectedVuln(null);
    setConfirmDelete(false);
    setTagDraft("");
    setEditingNotePort(null);
    setNoteDrafts({});
    setNameDrafts({});
    setShowAddPort(false);
    setAddPortForm({ port: "", name: "", note: "" });
    setConfirmRemovePort(null);
    const seed = normalizeInitial(initial);
    setDetail(seed);
    if (seed) applyForm(seed);
    if (!id) return;
    setLoading(true);
    authFetch<AssetDetail>(`/api/assets/${id}`)
      .then((data) => {
        setDetail(data);
        applyForm(data);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "资产加载失败"))
      .finally(() => setLoading(false));
  }, [open, id]);

  const asset = detail || normalizeInitial(initial);
  const properties = asset?.properties || {};
  const services = useMemo(
    () => normalizeServices(asset?.services || properties.services),
    [asset?.services, properties.services],
  );
  const vulns = (asset?.related_vulnerabilities || []) as RelatedVuln[];
  const host = asString(asset?.address, "");

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

  const tabs: { key: DetailTab; label: string; count?: number }[] = [
    { key: "overview", label: "端口/服务" },
    { key: "risk", label: "风险", count: vulns.length },
    { key: "edit", label: "编辑" },
  ];

  const portCards = useMemo(() => {
    return services.map((s) => {
      const port = s.port;
      const serviceName = (s.name || "").trim();
      const url = (s.url || "").trim() || guessServiceUrl(host, port, serviceName, s.protocol || null);
      const note = (s.note || "").trim();
      // Display/edit body: user note if set, otherwise default to URL as the starting remark.
      const remark = note || url || "";
      return { port, serviceName, url, note, remark };
    });
  }, [services, host]);

  const savePortEdit = async (port: string) => {
    if (!id) return;
    const note = (noteDrafts[port] ?? "").trim();
    const name = (nameDrafts[port] ?? "").trim();
    setSavingNotePort(port);
    setError("");
    try {
      // Merge service name + note so users can fully maintain port info by hand.
      const updated = await authFetch<AssetDetail>(`/api/assets/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          services: [{ port, name, note }],
        }),
      });
      setDetail(updated);
      applyForm(updated);
      setEditingNotePort(null);
      setNoteDrafts((prev) => {
        const next = { ...prev };
        delete next[port];
        return next;
      });
      setNameDrafts((prev) => {
        const next = { ...prev };
        delete next[port];
        return next;
      });
      onSaved?.(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "端口信息保存失败");
    } finally {
      setSavingNotePort(null);
    }
  };

  const addPort = async () => {
    if (!id) return;
    const port = addPortForm.port.trim();
    if (!port) {
      setError("请填写端口号");
      return;
    }
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      setError("端口号须为 1–65535 的数字");
      return;
    }
    const portNorm = String(Number(port));
    if (services.some((s) => s.port === portNorm || s.port === port)) {
      setError(`端口 ${portNorm} 已存在，可直接编辑`);
      return;
    }
    setAddingPort(true);
    setError("");
    try {
      const name = addPortForm.name.trim();
      const note = addPortForm.note.trim();
      const updated = await authFetch<AssetDetail>(`/api/assets/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          services: [{ port: portNorm, name, note }],
        }),
      });
      setDetail(updated);
      applyForm(updated);
      setShowAddPort(false);
      setAddPortForm({ port: "", name: "", note: "" });
      onSaved?.(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "添加端口失败");
    } finally {
      setAddingPort(false);
    }
  };

  const removePort = async (port: string) => {
    if (!id) return;
    setRemovingPort(port);
    setError("");
    try {
      const updated = await authFetch<AssetDetail>(`/api/assets/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remove_ports: [port] }),
      });
      setDetail(updated);
      applyForm(updated);
      setConfirmRemovePort(null);
      if (editingNotePort === port) setEditingNotePort(null);
      onSaved?.(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除端口失败");
    } finally {
      setRemovingPort(null);
    }
  };

  const availableSuggestions = useMemo(() => {
    const selected = new Set(form.tags.map((t) => t.toLowerCase()));
    return tagSuggestions.filter((t) => !selected.has(t.toLowerCase()));
  }, [tagSuggestions, form.tags]);

  function applyForm(data: AssetDetail) {
    setForm({
      name: asString(data.name),
      address: asString(data.address),
      tags: Array.isArray(data.tags) ? data.tags.map(String).filter(Boolean) : [],
    });
    setTagDraft("");
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

  const saveEdit = async () => {
    if (!id) return;
    if (!form.address.trim()) {
      setError("请填写 IP 或域名");
      return;
    }
    // Flush draft tag on save if user typed but didn't press Enter.
    const tags = [...form.tags];
    const draft = tagDraft.trim();
    if (draft && !tags.some((t) => t.toLowerCase() === draft.toLowerCase())) {
      tags.push(draft);
    }
    setSaving(true);
    setError("");
    try {
      const updated = await authFetch<AssetDetail>(`/api/assets/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim() || form.address.trim(),
          address: form.address.trim(),
          tags,
        }),
      });
      setDetail(updated);
      applyForm(updated);
      onSaved?.(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-6" onClick={onClose}>
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
                {asset?.name && asset.name !== asset.address ? (
                  <span className="truncate text-xs text-ink-muted">{asString(asset.name)}</span>
                ) : null}
              </div>
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

          {tab === "overview" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-ink-muted">
                  {portCards.length ? `${portCards.length} 个端口/服务` : "可手动维护，或由 Agent 自动挂接"}
                </p>
                {!showAddPort ? (
                  <button
                    type="button"
                    disabled={!id || loading}
                    onClick={() => {
                      setShowAddPort(true);
                      setError("");
                    }}
                    className="rounded-md border border-hairline px-2.5 py-1 text-[11px] font-medium hover:bg-surface-default disabled:opacity-50"
                  >
                    添加端口
                  </button>
                ) : null}
              </div>

              {showAddPort ? (
                <div className="rounded-md border border-hairline-soft bg-surface-default px-3.5 py-3">
                  <p className="text-[13px] font-medium text-ink">添加端口</p>
                  <div className="mt-2.5 grid grid-cols-2 gap-2">
                    <label className="block space-y-1">
                      <span className="text-[11px] text-ink-muted">端口 *</span>
                      <input
                        value={addPortForm.port}
                        onChange={(e) =>
                          setAddPortForm((prev) => ({ ...prev, port: e.target.value.replace(/[^\d]/g, "") }))
                        }
                        placeholder="例如 8080"
                        inputMode="numeric"
                        autoFocus
                        className="w-full rounded-md border border-hairline bg-canvas px-2.5 py-1.5 font-mono text-sm focus:border-ink focus:outline-none"
                      />
                    </label>
                    <label className="block space-y-1">
                      <span className="text-[11px] text-ink-muted">服务名（可选）</span>
                      <input
                        value={addPortForm.name}
                        onChange={(e) => setAddPortForm((prev) => ({ ...prev, name: e.target.value }))}
                        placeholder="例如 http / ssh"
                        className="w-full rounded-md border border-hairline bg-canvas px-2.5 py-1.5 text-sm focus:border-ink focus:outline-none"
                      />
                    </label>
                  </div>
                  <label className="mt-2 block space-y-1">
                    <span className="text-[11px] text-ink-muted">备注（可选）</span>
                    <textarea
                      value={addPortForm.note}
                      onChange={(e) => setAddPortForm((prev) => ({ ...prev, note: e.target.value }))}
                      rows={2}
                      placeholder="URL、用途、测试重点等"
                      className="w-full rounded-md border border-hairline bg-canvas px-2.5 py-2 text-xs leading-relaxed focus:border-ink focus:outline-none"
                    />
                  </label>
                  <div className="mt-2.5 flex justify-end gap-2">
                    <button
                      type="button"
                      disabled={addingPort}
                      onClick={() => {
                        setShowAddPort(false);
                        setAddPortForm({ port: "", name: "", note: "" });
                        setError("");
                      }}
                      className="rounded-md border px-2.5 py-1 text-[11px]"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      disabled={addingPort || !addPortForm.port.trim()}
                      onClick={() => void addPort()}
                      className="rounded-md bg-ink px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-50"
                    >
                      {addingPort ? "添加中…" : "添加"}
                    </button>
                  </div>
                </div>
              ) : null}

              {portCards.length ? (
                portCards.map((card) => {
                  const isEditing = editingNotePort === card.port;
                  const draftNote =
                    noteDrafts[card.port] !== undefined ? noteDrafts[card.port] : card.remark;
                  const draftName =
                    nameDrafts[card.port] !== undefined ? nameDrafts[card.port] : card.serviceName;
                  const title = card.serviceName
                    ? `${card.port}/${card.serviceName}`
                    : `${card.port}`;
                  return (
                    <div
                      key={card.port}
                      className="rounded-md border border-hairline-soft bg-surface-default px-3.5 py-3"
                    >
                      {isEditing ? (
                        <div className="space-y-2">
                          <div className="grid grid-cols-[5.5rem_1fr] gap-2">
                            <label className="block space-y-1">
                              <span className="text-[11px] text-ink-muted">端口</span>
                              <input
                                value={card.port}
                                disabled
                                className="w-full rounded-md border border-hairline bg-canvas-inset px-2.5 py-1.5 font-mono text-sm text-ink-muted"
                              />
                            </label>
                            <label className="block space-y-1">
                              <span className="text-[11px] text-ink-muted">服务名</span>
                              <input
                                value={draftName}
                                onChange={(e) =>
                                  setNameDrafts((prev) => ({ ...prev, [card.port]: e.target.value }))
                                }
                                placeholder="例如 http / ssh"
                                autoFocus
                                className="w-full rounded-md border border-hairline bg-canvas px-2.5 py-1.5 text-sm focus:border-ink focus:outline-none"
                              />
                            </label>
                          </div>
                          <label className="block space-y-1">
                            <span className="text-[11px] text-ink-muted">备注</span>
                            <textarea
                              value={draftNote}
                              onChange={(e) =>
                                setNoteDrafts((prev) => ({ ...prev, [card.port]: e.target.value }))
                              }
                              rows={3}
                              placeholder={
                                card.url
                                  ? `${card.url}\n（可追加服务说明、测试重点等）`
                                  : "默认可填 URL，并追加其他补充信息"
                              }
                              className="w-full rounded-md border border-hairline bg-canvas px-2.5 py-2 text-xs leading-relaxed text-ink placeholder:text-ink-muted focus:border-ink focus:outline-none"
                            />
                          </label>
                          <div className="flex items-center justify-between gap-2">
                            <button
                              type="button"
                              disabled={removingPort === card.port || savingNotePort === card.port}
                              onClick={() => setConfirmRemovePort(card.port)}
                              className="text-[11px] text-severity-critical hover:underline disabled:opacity-50"
                            >
                              删除端口
                            </button>
                            <div className="flex gap-2">
                              <button
                                type="button"
                                disabled={savingNotePort === card.port}
                                onClick={() => {
                                  setEditingNotePort(null);
                                  setNoteDrafts((prev) => {
                                    const next = { ...prev };
                                    delete next[card.port];
                                    return next;
                                  });
                                  setNameDrafts((prev) => {
                                    const next = { ...prev };
                                    delete next[card.port];
                                    return next;
                                  });
                                }}
                                className="rounded-md border px-2.5 py-1 text-[11px]"
                              >
                                取消
                              </button>
                              <button
                                type="button"
                                disabled={savingNotePort === card.port}
                                onClick={() => void savePortEdit(card.port)}
                                className="rounded-md bg-ink px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-50"
                              >
                                {savingNotePort === card.port ? "保存中…" : "保存"}
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-start justify-between gap-3">
                            <p className="min-w-0 truncate font-mono text-base font-semibold text-ink">
                              {title}
                            </p>
                            <div className="flex shrink-0 items-center gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingNotePort(card.port);
                                  setNoteDrafts((prev) => ({
                                    ...prev,
                                    [card.port]: card.remark,
                                  }));
                                  setNameDrafts((prev) => ({
                                    ...prev,
                                    [card.port]: card.serviceName,
                                  }));
                                }}
                                className="text-[11px] text-ink-muted hover:text-ink"
                              >
                                编辑
                              </button>
                              <button
                                type="button"
                                disabled={removingPort === card.port}
                                onClick={() => setConfirmRemovePort(card.port)}
                                className="text-[11px] text-ink-muted hover:text-severity-critical disabled:opacity-50"
                              >
                                删除
                              </button>
                            </div>
                          </div>
                          <div className="mt-2.5 border-t border-hairline-soft pt-2.5">
                            {card.remark ? (
                              <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-secondary">
                                {card.remark}
                              </p>
                            ) : (
                              <p className="text-xs text-ink-muted">暂无备注</p>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })
              ) : !showAddPort ? (
                <p className="py-6 text-center text-sm text-ink-muted">
                  暂无端口/服务，点击上方「添加端口」手动维护
                </p>
              ) : null}
            </div>
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

          {tab === "edit" && (
            <div className="space-y-5">
              <label className="block space-y-1">
                <span className="text-[11px] text-ink-muted">显示名称（可选）</span>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="默认与地址相同"
                  className="w-full rounded-md border px-2.5 py-2 text-sm"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] text-ink-muted">IP / 域名</span>
                <input
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  className="w-full rounded-md border px-2.5 py-2 font-mono text-sm"
                />
              </label>

              <div className="space-y-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[11px] font-medium text-ink-secondary">标签</span>
                  <span className="text-[11px] text-ink-muted">用于业务分组，可多选</span>
                </div>
                <div className="rounded-md border border-hairline bg-surface-default px-2.5 py-2">
                  <div className="flex flex-wrap items-center gap-1.5">
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
                      className="min-w-[8rem] flex-1 border-0 bg-transparent px-1 py-1 text-sm outline-none placeholder:text-ink-muted"
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
                </div>
                {availableSuggestions.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-[11px] text-ink-muted">已有标签，点击添加</p>
                    <div className="flex flex-wrap gap-1.5">
                      {availableSuggestions.map((t) => (
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
                  </div>
                )}
                <p className="text-[11px] leading-relaxed text-ink-muted">
                  相同标签可把多个 IP/域名归为一组（如「支付系统」「生产」）。保存后可在列表按标签筛选。
                </p>
              </div>

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
                className="rounded-md bg-ink px-4 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        )}
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
        open={Boolean(confirmRemovePort)}
        title="删除端口"
        description={`确定从该资产移除端口 ${confirmRemovePort || ""}？关联漏洞不会被删除，仅从端口清单中去掉。`}
        busy={Boolean(removingPort)}
        onCancel={() => {
          if (!removingPort) setConfirmRemovePort(null);
        }}
        onConfirm={() => {
          if (confirmRemovePort) void removePort(confirmRemovePort);
        }}
        error={null}
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

function formatDate(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value.slice(0, 10);
  return d.toLocaleDateString();
}

function normalizeServices(value: unknown): ServiceRow[] {
  if (!Array.isArray(value)) return [];
  const rows: ServiceRow[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const port = String(rec.port ?? "").trim();
    if (!port) continue;
    const urlRaw = rec.url ?? rec.uri ?? rec.endpoint;
    const noteRaw = rec.note ?? rec.remark ?? rec.comment;
    rows.push({
      port,
      name: asString(rec.name || rec.service || rec.product, ""),
      protocol: rec.protocol != null ? String(rec.protocol) : null,
      product: rec.product != null ? String(rec.product) : null,
      version: rec.version != null ? String(rec.version) : null,
      url: typeof urlRaw === "string" && urlRaw.trim() ? urlRaw.trim() : null,
      note: typeof noteRaw === "string" && noteRaw.trim() ? noteRaw.trim() : null,
    });
  }
  return rows.sort((a, b) => Number(a.port) - Number(b.port));
}

/** Build a simple URL for common web ports when agent did not store one. */
function guessServiceUrl(
  host: string,
  port: string,
  serviceName: string,
  protocol: string | null,
): string | null {
  if (!host || !port) return null;
  const name = (serviceName || "").toLowerCase();
  const proto = (protocol || "").toLowerCase();
  const webish =
    ["http", "https", "http-proxy", "ssl/http", "ssl/https", "www"].includes(name) ||
    ["80", "443", "8080", "8443", "8000", "8888", "3000", "5000"].includes(port) ||
    proto === "http" ||
    proto === "https";
  if (!webish) return null;
  const scheme =
    port === "443" || port === "8443" || name === "https" || name === "ssl/https" || proto === "https"
      ? "https"
      : "http";
  if ((scheme === "http" && port === "80") || (scheme === "https" && port === "443")) {
    return `${scheme}://${host}`;
  }
  return `${scheme}://${host}:${port}`;
}
