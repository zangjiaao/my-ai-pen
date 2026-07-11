import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";
import { authFetch } from "../lib/api";
import AssetDetailDialog from "../components/AssetDetailDialog";
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
  ports_summary?: string;
  tech_summary?: string;
  risk?: RiskSummary;
  related_vulnerabilities: RelatedVuln[];
  created_at?: string | null;
  updated_at?: string | null;
};

type Conversation = { id: string; title?: string };

/** Sentinel: asset selected as host-only (no port inventory yet). */
const HOST_ONLY = "__host__";

const EMPTY_FORM = { address: "", tags: "" };
const ACTIVE_CONVERSATION_KEY = "active_conversation_id";
/** Consumed by ConversationPage to auto-start a pentest with target/scope. */
export const PENDING_ASSET_TASK_KEY = "pending_asset_task";

export type PendingAssetTask = {
  text: string;
  target: { type: string; value: string };
  scope: { allow: string[]; deny: string[] };
};

export default function AssetPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedPorts, setSelectedPorts] = useState<string[]>([]);
  const [selectedServices, setSelectedServices] = useState<string[]>([]);
  const [openMenu, setOpenMenu] = useState<"tag" | "port" | "service" | null>(null);
  const filterBarRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Asset | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [allPorts, setAllPorts] = useState<string[]>([]);
  const [allServices, setAllServices] = useState<string[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [launching, setLaunching] = useState(false);

  /** assetId → selected ports (or HOST_ONLY). */
  const [checkedPorts, setCheckedPorts] = useState<Record<string, string[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (search.trim()) p.set("search", search.trim());
    for (const t of selectedTags) p.append("tag", t);
    for (const port of selectedPorts) p.append("port", port);
    for (const svc of selectedServices) p.append("service", svc);
    p.set("limit", "100");
    return p;
  }, [search, selectedTags, selectedPorts, selectedServices]);

  const load = async () => {
    setError("");
    try {
      const res = await authFetch<Asset[]>(`/api/assets?${params}`);
      setAssets(res);
      if (selected) {
        const fresh = res.find((item) => item.id === selected.id);
        if (fresh) setSelected(fresh);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "资产加载失败");
    }
  };

  const loadFilterOptions = async () => {
    try {
      const [tags, ports, services] = await Promise.all([
        authFetch<string[]>("/api/assets/tags").catch(() => [] as string[]),
        authFetch<string[]>("/api/assets/ports").catch(() => [] as string[]),
        authFetch<string[]>("/api/assets/services").catch(() => [] as string[]),
      ]);
      setAllTags(tags);
      setAllPorts(ports);
      setAllServices(services);
    } catch {
      /* optional filter source */
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
    for (const [assetId, ports] of Object.entries(checkedPorts)) {
      if (!ports.length) continue;
      assetsCount += 1;
      if (ports.includes(HOST_ONLY)) {
        // host-only counts as one target, not a port
      } else {
        portsCount += ports.length;
      }
    }
    return { assetsCount, portsCount };
  }, [checkedPorts]);

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

  const allFullySelected =
    assets.length > 0 && assets.every((a) => isAssetFullySelected(a));
  const someSelected = assets.some(
    (a) => (checkedPorts[a.id] || []).length > 0,
  );

  const toggleAllAssets = () => {
    if (allFullySelected) {
      setCheckedPorts({});
      return;
    }
    const next: Record<string, string[]> = {};
    for (const a of assets) {
      next[a.id] = selectAllPortsForAsset(a);
    }
    setCheckedPorts(next);
  };

  const clearSelection = () => setCheckedPorts({});

  const buildTaskPayload = (): PendingAssetTask | null => {
    const allow: string[] = [];
    const lines: string[] = [];
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
        // Whole host
        allow.push(host);
        if (ports.length) {
          for (const p of ports) {
            const url = serviceUrl(asset, p);
            if (url && !allow.includes(url)) allow.push(url);
            const note = notesByPort[p];
            lines.push(
              note
                ? `- ${url || `${host}:${p}`}（备注：${note}）`
                : `- ${url || `${host}:${p}`}`,
            );
          }
        } else {
          lines.push(`- ${host}（全部端口/服务，以资产台账为准）`);
        }
      } else {
        for (const p of sel) {
          const url = serviceUrl(asset, p);
          const target = url || `${host}:${p}`;
          if (!allow.includes(target)) allow.push(target);
          const note = notesByPort[p];
          const svc = services.find((s) => s.port === p);
          const svcLabel = svc?.name ? `${p}/${svc.name}` : p;
          lines.push(note ? `- ${host} · ${svcLabel} · ${target}（备注：${note}）` : `- ${host} · ${svcLabel} · ${target}`);
        }
      }
    }
    if (!allow.length) return null;
    const primary = allow[0];
    const text =
      "请对以下授权目标进行安全测试。范围以 scope.allow 为准，不要超出。\n\n" +
      "目标清单：\n" +
      lines.join("\n") +
      "\n\n若目标含端口备注，请优先参考备注理解服务与测试重点。";
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
      localStorage.setItem(ACTIVE_CONVERSATION_KEY, conv.id);
      sessionStorage.setItem(PENDING_ASSET_TASK_KEY, JSON.stringify(payload));
      setNotice("正在打开会话并创建任务…");
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建任务失败");
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div className="flex h-screen bg-canvas">
      <Sidebar activeId={null} onSelect={() => {}} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar title="资产管理" />
        <div className="flex flex-1 overflow-hidden">
          <main className="flex-1 overflow-y-auto p-6">
            <div className="mb-4 flex flex-wrap items-center gap-3" ref={filterBarRef}>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索 IP / 域名 / 名称"
                className="min-w-[12rem] rounded-md border border-hairline px-3 py-2 text-sm focus:border-ink focus:outline-none"
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

              <MultiFilter
                label="端口"
                buttonText={multiLabel(
                  selectedPorts,
                  "全部端口",
                  allPorts.map((p) => ({ value: p, label: p })),
                )}
                open={openMenu === "port"}
                onToggle={() => setOpenMenu((m) => (m === "port" ? null : "port"))}
                onClear={() => setSelectedPorts([])}
                options={allPorts.map((p) => ({ value: p, label: p, mono: true }))}
                selected={selectedPorts}
                onToggleValue={(v) => toggleInList(selectedPorts, v, setSelectedPorts)}
                emptyText="暂无端口"
              />

              <MultiFilter
                label="服务"
                buttonText={multiLabel(
                  selectedServices,
                  "全部服务",
                  allServices.map((s) => ({ value: s, label: s })),
                )}
                open={openMenu === "service"}
                onToggle={() => setOpenMenu((m) => (m === "service" ? null : "service"))}
                onClear={() => setSelectedServices([])}
                options={allServices.map((s) => ({ value: s, label: s, mono: true }))}
                selected={selectedServices}
                onToggleValue={(v) => toggleInList(selectedServices, v, setSelectedServices)}
                emptyText="暂无服务"
              />

              <button
                type="button"
                onClick={openCreateDialog}
                className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-white hover:opacity-90"
              >
                添加资产
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
                  disabled={launching}
                  onClick={() => void launchTask()}
                  className="rounded-md bg-ink px-3 py-1 text-[11px] font-medium text-white disabled:opacity-50"
                >
                  {launching ? "创建中…" : "创建任务"}
                </button>
                <button
                  type="button"
                  onClick={clearSelection}
                  className="rounded-md border px-2.5 py-1 text-[11px] text-ink-secondary hover:bg-canvas"
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

            <div className="overflow-x-auto rounded-md border border-hairline-soft bg-surface-raised">
              <table className="w-full min-w-[880px] table-fixed">
                <thead>
                  <tr className="border-b border-hairline bg-surface-default text-left text-xs font-medium text-ink-secondary">
                    <th className="w-10 px-2 py-2.5">
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
                    </th>
                    <th className="w-8 px-1 py-2.5" />
                    <th className="min-w-0 px-3 py-2.5">IP / 域名</th>
                    <th className="w-36 px-3 py-2.5">标签</th>
                    <th className="w-44 px-3 py-2.5">端口 / 服务</th>
                    <th className="w-48 px-3 py-2.5">风险</th>
                    <th className="w-20 px-3 py-2.5">来源</th>
                    <th className="w-24 px-3 py-2.5">更新</th>
                  </tr>
                </thead>
                <tbody>
                  {assets.map((a) => {
                    const ports = listPorts(a);
                    const isOpen = Boolean(expanded[a.id]);
                    const full = isAssetFullySelected(a);
                    const partial = isAssetPartiallySelected(a);
                    const sel = checkedPorts[a.id] || [];
                    return (
                      <Fragment key={a.id}>
                        <tr
                          onClick={() => void openAsset(a.id)}
                          className="cursor-pointer border-b border-hairline-soft text-sm hover:bg-surface-default"
                        >
                          <td
                            className="px-2 py-2.5"
                            onClick={(e) => {
                              e.stopPropagation();
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={full}
                              ref={(el) => {
                                if (el) el.indeterminate = partial;
                              }}
                              onChange={() => toggleAsset(a)}
                              onClick={(e) => e.stopPropagation()}
                              className="rounded border-hairline"
                              aria-label={`选择 ${a.address}`}
                            />
                          </td>
                          <td className="px-1 py-2.5" onClick={(e) => toggleExpand(a.id, e)}>
                            <button
                              type="button"
                              className="w-6 text-center text-xs text-ink-muted hover:text-ink"
                              aria-label={isOpen ? "收起端口" : "展开端口"}
                            >
                              {isOpen ? "▾" : "▸"}
                            </button>
                          </td>
                          <td className="min-w-0 px-3 py-2.5">
                            <div className="truncate font-mono text-sm font-medium text-ink">{a.address}</div>
                            {a.name && a.name !== a.address ? (
                              <div className="mt-0.5 truncate text-[11px] text-ink-muted">{a.name}</div>
                            ) : null}
                          </td>
                          <td className="px-3 py-2.5">
                            <TagList tags={a.tags || []} />
                          </td>
                          <td
                            className="truncate px-3 py-2.5 font-mono text-xs text-ink-secondary"
                            title={a.ports_summary || ""}
                          >
                            {a.ports_summary || "—"}
                          </td>
                          <td className="px-3 py-2.5">
                            <RiskChips findings={a.related_vulnerabilities || []} fallback={a.risk} />
                          </td>
                          <td className="px-3 py-2.5 text-xs text-ink-muted">{a.source_label || a.source}</td>
                          <td className="px-3 py-2.5 text-xs text-ink-muted">{formatDate(a.updated_at)}</td>
                        </tr>
                        {isOpen && (
                          <tr className="border-b border-hairline-soft bg-canvas-inset/40">
                            <td colSpan={8} className="px-4 py-2">
                              {ports.length ? (
                                <div className="ml-8 flex flex-wrap gap-2">
                                  {ports.map((port) => {
                                    const svc = (a.services || []).find((s) => s.port === port);
                                    const label = svc?.name ? `${port}/${svc.name}` : port;
                                    const checked = sel.includes(port);
                                    return (
                                      <label
                                        key={port}
                                        className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
                                          checked
                                            ? "border-ink bg-canvas text-ink"
                                            : "border-hairline bg-canvas text-ink-secondary hover:border-ink/40"
                                        }`}
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        <input
                                          type="checkbox"
                                          checked={checked}
                                          onChange={() => togglePort(a, port)}
                                          className="rounded border-hairline"
                                        />
                                        <span className="font-mono">{label}</span>
                                        {svc?.note ? (
                                          <span
                                            className="max-w-[8rem] truncate text-[10px] text-ink-muted"
                                            title={svc.note}
                                          >
                                            · {svc.note}
                                          </span>
                                        ) : null}
                                      </label>
                                    );
                                  })}
                                </div>
                              ) : (
                                <p className="ml-8 text-xs text-ink-muted">
                                  暂无端口清单；勾选主机将按整机目标创建任务（后续 Agent 发现端口会写入台账）。
                                </p>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                  {!assets.length && (
                    <tr>
                      <td colSpan={8} className="px-4 py-10 text-center text-sm text-ink-muted">
                        暂无资产。会话测试中 Agent 会按主机自动登记；也可点击「添加资产」录入 IP/域名。
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </main>

          <AssetDetailDialog
            open={Boolean(selected)}
            assetId={selected?.id}
            initial={selected}
            knownTags={allTags}
            onClose={() => setSelected(null)}
            onSaved={() => {
              void load();
              void loadFilterOptions();
            }}
            onDeleted={() => {
              setSelected(null);
              void load();
              void loadFilterOptions();
            }}
          />

          {showForm && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
              onClick={closeCreateDialog}
            >
              <div
                className="w-full max-w-md rounded-lg border border-hairline-soft bg-canvas p-6 shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <h2 className="text-lg font-semibold">添加资产</h2>
                <p className="mt-1 text-xs text-ink-muted">
                  一个资产对应一个 IP 或域名。端口与漏洞由 Agent 在测试中挂接；标签用于分组。
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
                    className="rounded-md bg-ink px-4 py-1.5 text-xs font-medium text-white disabled:opacity-60"
                  >
                    {saving ? "保存中…" : "保存"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
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

function serviceUrl(asset: Asset, port: string): string | null {
  const svc = (asset.services || []).find((s) => s.port === port);
  if (svc?.url) return svc.url;
  const host = asset.address;
  const name = (svc?.name || "").toLowerCase();
  if (port === "443" || name === "https") return `https://${host}`;
  if (port === "80" || name === "http") return `http://${host}`;
  // High ports / unknown: prefer http URL form for web tasks
  if (/^\d+$/.test(port) && Number(port) > 0) {
    if (name === "https" || port === "8443") return `https://${host}:${port}`;
    return `http://${host}:${port}`;
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

function RiskChips({
  findings,
  fallback,
}: {
  findings: RelatedVuln[];
  fallback?: RiskSummary;
}) {
  const chips = buildRiskChips(
    findings.map((v) => ({
      id: v.id,
      title: v.title,
      severity: v.severity,
      status: v.status,
      confidence: v.confidence,
      port: v.port,
      description: v.description,
    })),
  );
  if (!chips.length) {
    if (fallback && fallback.open_total > 0) {
      return (
        <span className="rounded-md bg-canvas-inset px-1.5 py-0.5 font-mono text-[10px] text-ink-secondary">
          {fallback.label}
        </span>
      );
    }
    return <span className="text-xs text-ink-muted">—</span>;
  }
  const fullTitle = chips.map((c) => `${c.label} ${c.count}`).join(" · ");
  // Cap visible chips so the cell stays within ~2 lines; rest in title tooltip.
  const maxVisible = 4;
  const visible = chips.slice(0, maxVisible);
  const extra = chips.length - visible.length;
  return (
    <div
      className="flex max-h-[2.5rem] flex-wrap content-start gap-1 overflow-hidden"
      title={fullTitle}
    >
      {visible.map((c) => (
        <span
          key={c.key}
          className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase leading-tight ${c.badgeClass}`}
        >
          <span>{c.label}</span>
          <span className="opacity-80">{c.count}</span>
        </span>
      ))}
      {extra > 0 ? (
        <span className="inline-flex shrink-0 items-center rounded-md bg-canvas-inset px-1.5 py-0.5 font-mono text-[10px] text-ink-muted">
          +{extra}
        </span>
      ) : null}
    </div>
  );
}

function formatDate(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value.slice(0, 10);
  return d.toLocaleDateString();
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
