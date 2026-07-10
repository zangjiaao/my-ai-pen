import { useEffect, useMemo, useState } from "react";
import { authDownload, authFetch } from "../lib/api";
import { asString, shortId, type SecurityAsset } from "../lib/securityTypes";

const ASSET_TYPES = [
  { value: "host", label: "主机" },
  { value: "web", label: "Web" },
  { value: "web_app", label: "Web 应用" },
  { value: "cloud_service", label: "云服务" },
  { value: "code_repo", label: "代码仓库" },
];

type AssetDetail = SecurityAsset & {
  type_label?: string;
  source_label?: string;
  system?: string | null;
  ports_summary?: string;
  tech_summary?: string;
  risk?: {
    open_total: number;
    by_severity?: Record<string, number>;
    highest?: string;
    label?: string;
  };
};

interface Props {
  open: boolean;
  assetId?: string | null;
  initial?: Partial<AssetDetail> | null;
  systems?: string[];
  onClose: () => void;
  onSaved?: (asset: AssetDetail) => void;
  onDeleted?: (id: string) => void;
  onExported?: () => void;
}

export default function AssetDetailDialog({
  open,
  assetId,
  initial,
  systems = [],
  onClose,
  onSaved,
  onDeleted,
  onExported,
}: Props) {
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    name: "",
    address: "",
    type: "host",
    system: "",
    tags: "",
  });
  const id = assetId || initial?.id || initial?.asset_id || null;

  useEffect(() => {
    if (!open) {
      setEditing(false);
      return;
    }
    setError("");
    setEditing(false);
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
  const openPorts = useMemo(
    () => normalizePorts(asset?.open_ports || properties.open_ports),
    [asset?.open_ports, properties.open_ports],
  );
  const services = useMemo(
    () => normalizeServices(asset?.services || properties.services),
    [asset?.services, properties.services],
  );
  const riskLabel = asset?.risk?.label || "";
  const systemValue = asset?.system || systemFromProps(properties) || "";

  function applyForm(data: AssetDetail) {
    setForm({
      name: asString(data.name),
      address: asString(data.address),
      type: asString(data.type || data.asset_type, "host"),
      system: asString(data.system || systemFromProps(data.properties || {})),
      tags: (data.tags || []).join(", "),
    });
  }

  const saveEdit = async () => {
    if (!id) return;
    if (!form.address.trim()) {
      setError("请填写地址");
      return;
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
          type: form.type,
          system: form.system.trim(),
          tags: form.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        }),
      });
      setDetail(updated);
      applyForm(updated);
      setEditing(false);
      onSaved?.(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const deleteAsset = async () => {
    if (!id) return;
    if (!window.confirm("确定删除该资产？删除后不可恢复（关联漏洞不会自动删除）。")) return;
    setDeleting(true);
    setError("");
    try {
      await authFetch(`/api/assets/${id}`, { method: "DELETE" });
      onDeleted?.(id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  };

  const exportRemediation = async () => {
    if (!id) return;
    setExporting(true);
    setError("");
    try {
      const { blob, filename } = await authDownload(`/api/assets/${id}/export?format=markdown`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename || "asset-remediation.md";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      onExported?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "导出失败");
    } finally {
      setExporting(false);
    }
  };

  if (!open) return null;

  const systemOptions = Array.from(new Set([...systems, form.system].filter(Boolean)));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-6" onClick={onClose}>
      <div
        className="flex max-h-[min(88vh,900px)] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-hairline-soft bg-canvas shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="shrink-0 border-b border-hairline-soft px-6 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="break-words text-xl font-semibold">
                {asString(asset?.name || asset?.address, "资产详情")}
              </h2>
              <p className="mt-1 break-all font-mono text-xs text-ink-muted">{asString(asset?.address)}</p>
              {loading && <p className="mt-1 text-xs text-ink-muted">加载中…</p>}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {!editing ? (
                <>
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className="rounded-md border border-hairline px-3 py-1.5 text-xs hover:bg-surface-default"
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    disabled={exporting || !id}
                    onClick={() => void exportRemediation()}
                    className="rounded-md border border-hairline px-3 py-1.5 text-xs hover:bg-surface-default disabled:opacity-50"
                  >
                    {exporting ? "导出中…" : "导出整改包"}
                  </button>
                  <button
                    type="button"
                    disabled={deleting || !id}
                    onClick={() => void deleteAsset()}
                    className="rounded-md border border-severity-critical/40 px-3 py-1.5 text-xs text-severity-critical hover:bg-severity-critical-subtle disabled:opacity-50"
                  >
                    {deleting ? "删除中…" : "删除"}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void saveEdit()}
                    className="rounded-md bg-ink px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                  >
                    {saving ? "保存中…" : "保存"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(false);
                      if (asset) applyForm(asset);
                      setError("");
                    }}
                    className="rounded-md border border-hairline px-3 py-1.5 text-xs hover:bg-surface-default"
                  >
                    取消编辑
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-hairline px-3 py-1.5 text-xs hover:bg-surface-default"
              >
                关闭
              </button>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {error && (
            <div className="mb-4 rounded-md border border-severity-critical/30 bg-severity-critical-subtle px-3 py-2 text-sm text-severity-critical">
              {error}
            </div>
          )}

          {editing ? (
            <section className="mb-5 space-y-3 rounded-md border border-hairline-soft p-4">
              <h3 className="text-xs font-semibold text-ink-secondary">基本信息</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block space-y-1">
                  <span className="text-[11px] text-ink-muted">名称</span>
                  <input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full rounded-md border px-2.5 py-2 text-sm"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-[11px] text-ink-muted">地址</span>
                  <input
                    value={form.address}
                    onChange={(e) => setForm({ ...form, address: e.target.value })}
                    className="w-full rounded-md border px-2.5 py-2 font-mono text-sm"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-[11px] text-ink-muted">类型</span>
                  <select
                    value={form.type}
                    onChange={(e) => setForm({ ...form, type: e.target.value })}
                    className="w-full rounded-md border bg-canvas px-2.5 py-2 text-sm"
                  >
                    {ASSET_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-1">
                  <span className="text-[11px] text-ink-muted">所属系统</span>
                  <input
                    list="asset-system-options"
                    value={form.system}
                    onChange={(e) => setForm({ ...form, system: e.target.value })}
                    placeholder="例如：支付系统 / 门户官网"
                    className="w-full rounded-md border px-2.5 py-2 text-sm"
                  />
                  <datalist id="asset-system-options">
                    {systemOptions.map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                </label>
                <label className="block space-y-1 sm:col-span-2">
                  <span className="text-[11px] text-ink-muted">标签（逗号分隔）</span>
                  <input
                    value={form.tags}
                    onChange={(e) => setForm({ ...form, tags: e.target.value })}
                    className="w-full rounded-md border px-2.5 py-2 text-sm"
                  />
                </label>
              </div>
              <p className="text-[11px] text-ink-muted">
                「所属系统」用于按业务归类资产（如核心支付、办公门户），可输入已有系统或新建名称。
              </p>
            </section>
          ) : (
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Info label="类型" value={asString(asset?.type_label || asset?.type || asset?.asset_type)} />
              <Info label="所属系统" value={systemValue || "未分配"} />
              <Info label="来源" value={asString(asset?.source_label || asset?.source)} />
              <Info
                label="风险"
                value={
                  riskLabel ||
                  (asset?.related_vulnerabilities?.length
                    ? `${asset.related_vulnerabilities.length} 关联`
                    : "无开放漏洞")
                }
              />
              <Info label="标签" value={(asset?.tags || []).join(", ") || "—"} />
              <Info label="最近更新" value={formatTs(asset?.updated_at)} />
              <Info label="会话" value={shortId(asset?.conversation_id)} />
              <Info label="节点" value={shortId(asset?.node_id)} />
            </section>
          )}

          <section className="mt-5">
            <h3 className="mb-2 text-xs font-semibold text-ink-secondary">开放端口</h3>
            {openPorts.length ? (
              <div className="flex flex-wrap gap-2">
                {openPorts.map((port) => (
                  <span key={port} className="rounded-md border border-hairline bg-canvas-inset px-2.5 py-1 font-mono text-xs">
                    {port}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-ink-muted">暂无端口记录</p>
            )}
          </section>

          <section className="mt-5">
            <h3 className="mb-2 text-xs font-semibold text-ink-secondary">服务 / 指纹</h3>
            {services.length ? (
              <div className="overflow-hidden rounded-md border border-hairline-soft">
                <table className="w-full table-fixed text-sm">
                  <thead className="bg-surface-default text-left text-xs text-ink-secondary">
                    <tr>
                      <th className="px-3 py-2">端口</th>
                      <th className="px-3 py-2">名称</th>
                      <th className="px-3 py-2">版本 / 产品</th>
                    </tr>
                  </thead>
                  <tbody>
                    {services.map((service, index) => (
                      <tr key={`${service.port}-${index}`} className="border-t border-hairline-soft">
                        <td className="px-3 py-2 font-mono text-xs">{asString(service.port)}</td>
                        <td className="break-words px-3 py-2">{asString(service.name || service.service)}</td>
                        <td className="break-words px-3 py-2 text-ink-secondary">
                          {asString(service.version || service.product)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-ink-muted">暂无指纹记录</p>
            )}
          </section>

          <section className="mt-5">
            <h3 className="mb-2 text-xs font-semibold text-ink-secondary">关联漏洞</h3>
            <div className="space-y-2">
              {asset?.related_vulnerabilities?.map((vuln) => (
                <div key={vuln.id} className="rounded-md border border-hairline-soft p-3">
                  <div className="break-words text-sm font-medium">{vuln.title}</div>
                  <div className="mt-1 flex flex-wrap gap-2 text-xs text-ink-muted">
                    <span>{vuln.severity}</span>
                    <span>{vuln.status}</span>
                    <span>{vuln.confidence}</span>
                  </div>
                </div>
              ))}
              {!asset?.related_vulnerabilities?.length && (
                <p className="text-sm text-ink-muted">暂无关联漏洞</p>
              )}
            </div>
          </section>

          {Object.keys(properties).length > 0 && (
            <details className="mt-5">
              <summary className="cursor-pointer text-xs font-semibold text-ink-muted hover:text-ink">
                原始属性（高级）
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-canvas-inset p-3 font-mono text-[11px]">
                {JSON.stringify(properties, null, 2)}
              </pre>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

function systemFromProps(props: Record<string, unknown>): string {
  for (const key of ["system", "business_system", "app_system"]) {
    const v = props[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function normalizeInitial(initial?: Props["initial"]): AssetDetail | null {
  if (!initial) return null;
  return {
    id: String(initial.id || initial.asset_id || ""),
    asset_id: initial.asset_id,
    conversation_id: initial.conversation_id,
    node_id: initial.node_id,
    name: asString(initial.name || initial.address, "未知资产"),
    address: asString(initial.address),
    type: asString(initial.type || initial.asset_type, "host"),
    asset_type: initial.asset_type,
    type_label: initial.type_label,
    source_label: initial.source_label,
    system: initial.system ?? systemFromProps(initial.properties || {}) || null,
    tags: initial.tags || [],
    properties: initial.properties || {},
    open_ports: initial.open_ports,
    services: initial.services,
    source: initial.source,
    risk: initial.risk,
    related_vulnerabilities: initial.related_vulnerabilities || [],
    created_at: initial.created_at,
    updated_at: initial.updated_at,
  };
}

function normalizePorts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item)).filter(Boolean))].sort(
    (a, b) => Number(a) - Number(b),
  );
}

function normalizeServices(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-canvas-inset p-2">
      <div className="text-[11px] text-ink-muted">{label}</div>
      <div className="mt-1 truncate text-xs text-ink">{value || "—"}</div>
    </div>
  );
}

function formatTs(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value.slice(0, 19) : d.toLocaleString();
}
