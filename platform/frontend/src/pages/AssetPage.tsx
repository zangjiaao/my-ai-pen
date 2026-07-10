import { useEffect, useMemo, useState } from "react";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";
import { authDownload, authFetch } from "../lib/api";
import AssetDetailDialog from "../components/AssetDetailDialog";

type RelatedVuln = {
  id: string;
  title: string;
  severity: string;
  status: string;
  confidence: string;
};

type RiskSummary = {
  open_total: number;
  by_severity: Record<string, number>;
  highest: string;
  label: string;
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
  services?: Array<Record<string, unknown>>;
  ports_summary?: string;
  tech_summary?: string;
  risk?: RiskSummary;
  related_vulnerabilities: RelatedVuln[];
  created_at?: string | null;
  updated_at?: string | null;
};

type ChangesSummary = {
  window_days: number;
  window_start: string;
  window_end: string;
  counts: {
    new_assets: number;
    updated_assets: number;
    new_findings: number;
    updated_findings: number;
  };
  new_assets: Array<{ id?: string; name?: string; address?: string; type?: string }>;
  updated_assets: Array<{ id?: string; name?: string; address?: string }>;
  new_findings: Array<{ title?: string; severity?: string; status?: string }>;
  updated_findings: Array<{ title?: string; severity?: string; status?: string }>;
};

const ALL = "全部";
const TYPES = [
  { value: ALL, label: "全部类型" },
  { value: "host", label: "主机" },
  { value: "web", label: "Web" },
  { value: "web_app", label: "Web 应用" },
  { value: "cloud_service", label: "云服务" },
  { value: "code_repo", label: "代码仓库" },
];

export default function AssetPage() {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState(ALL);
  const [selected, setSelected] = useState<Asset | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [showChanges, setShowChanges] = useState(false);
  const [changes, setChanges] = useState<ChangesSummary | null>(null);
  const [changesLoading, setChangesLoading] = useState(false);
  const [form, setForm] = useState({ name: "", address: "", type: "host", tags: "" });
  const [error, setError] = useState("");

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (search.trim()) p.set("search", search.trim());
    if (typeFilter !== ALL) p.set("type", typeFilter);
    p.set("limit", "100");
    return p;
  }, [search, typeFilter]);

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

  useEffect(() => {
    void load();
  }, [params.toString()]);

  const openAsset = async (id: string) => {
    const detail = await authFetch<Asset>(`/api/assets/${id}`);
    setSelected(detail);
  };

  const createAsset = async () => {
    if (!form.address.trim()) {
      setError("请填写地址");
      return;
    }
    await authFetch("/api/assets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name.trim() || form.address.trim(),
        address: form.address.trim(),
        type: form.type,
        tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
      }),
    });
    setShowForm(false);
    setForm({ name: "", address: "", type: "host", tags: "" });
    await load();
  };

  const loadChanges = async () => {
    setChangesLoading(true);
    try {
      const data = await authFetch<ChangesSummary>("/api/assets/changes?days=7");
      setChanges(data);
      setShowChanges(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "变化摘要加载失败");
    } finally {
      setChangesLoading(false);
    }
  };

  const downloadChanges = async () => {
    try {
      const { blob, filename } = await authDownload("/api/assets/changes?days=7&format=markdown");
      triggerDownload(blob, filename || "asset-security-changes-7d.md");
    } catch (err) {
      setError(err instanceof Error ? err.message : "导出失败");
    }
  };

  return (
    <div className="flex h-screen bg-canvas">
      <Sidebar activeId={null} onSelect={() => {}} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar title="资产管理" />
        <div className="flex flex-1 overflow-hidden">
          <main className="flex-1 overflow-y-auto p-6">
            <p className="mb-4 text-xs text-ink-muted">
              企业信息系统台账：录入主机/Web 应用，汇聚 Agent 发现的端口与指纹，查看风险并导出整改与周变化。
            </p>

            <div className="mb-4 flex flex-wrap items-center gap-3">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索名称或地址"
                className="rounded-md border border-hairline px-3 py-2 text-sm focus:border-ink focus:outline-none"
              />
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                className="rounded-md border border-hairline px-3 py-2 text-sm"
              >
                {TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setShowForm(true)}
                className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-white"
              >
                录入资产
              </button>
              <button
                type="button"
                onClick={() => void loadChanges()}
                className="rounded-md border border-hairline px-4 py-2 text-sm hover:bg-surface-default"
              >
                {changesLoading ? "加载中…" : "近 7 天变化"}
              </button>
              <button
                type="button"
                onClick={() => void downloadChanges()}
                className="rounded-md border border-hairline px-4 py-2 text-sm hover:bg-surface-default"
              >
                导出周变化
              </button>
              <button
                type="button"
                onClick={() => void load()}
                className="rounded-md border border-hairline px-4 py-2 text-sm hover:bg-surface-default"
              >
                刷新
              </button>
            </div>

            {error && (
              <div className="mb-4 rounded-md border border-severity-critical/30 bg-severity-critical-subtle px-4 py-3 text-sm text-severity-critical">
                {error}
              </div>
            )}

            {showChanges && changes && (
              <div className="mb-4 rounded-md border border-hairline-soft bg-surface-raised p-4">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">近 7 天资产安全变化</h3>
                  <button type="button" onClick={() => setShowChanges(false)} className="text-xs text-ink-muted hover:text-ink">
                    收起
                  </button>
                </div>
                <div className="grid gap-2 sm:grid-cols-4">
                  <Stat label="新增资产" value={changes.counts.new_assets} />
                  <Stat label="更新资产" value={changes.counts.updated_assets} />
                  <Stat label="新增漏洞" value={changes.counts.new_findings} />
                  <Stat label="状态变化漏洞" value={changes.counts.updated_findings} />
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <ChangeList
                    title="新增资产"
                    items={(changes.new_assets || []).map(
                      (a) => `${a.address || a.name || "—"} (${a.type || "—"})`,
                    )}
                  />
                  <ChangeList
                    title="新增漏洞"
                    items={(changes.new_findings || []).map(
                      (v) => `[${v.severity || "info"}] ${v.title || "—"} (${v.status || "—"})`,
                    )}
                  />
                </div>
              </div>
            )}

            {showForm && (
              <div className="mb-4 rounded-md border border-hairline bg-surface-default p-4">
                <div className="grid gap-3 md:grid-cols-4">
                  <input
                    placeholder="名称"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="rounded border border-hairline px-3 py-2 text-sm"
                  />
                  <input
                    placeholder="地址（IP / 域名 / URL）"
                    value={form.address}
                    onChange={(e) => setForm({ ...form, address: e.target.value })}
                    className="rounded border border-hairline px-3 py-2 text-sm"
                  />
                  <select
                    value={form.type}
                    onChange={(e) => setForm({ ...form, type: e.target.value })}
                    className="rounded border border-hairline px-3 py-2 text-sm"
                  >
                    {TYPES.filter((t) => t.value !== ALL).map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <input
                    placeholder="标签，逗号分隔"
                    value={form.tags}
                    onChange={(e) => setForm({ ...form, tags: e.target.value })}
                    className="rounded border border-hairline px-3 py-2 text-sm"
                  />
                </div>
                <div className="mt-3 flex gap-2">
                  <button type="button" onClick={() => void createAsset()} className="rounded-md bg-ink px-4 py-2 text-sm text-white">
                    保存
                  </button>
                  <button type="button" onClick={() => setShowForm(false)} className="rounded-md border border-hairline px-4 py-2 text-sm">
                    取消
                  </button>
                </div>
              </div>
            )}

            <div className="overflow-hidden rounded-md border border-hairline-soft bg-surface-raised">
              <table className="w-full table-fixed">
                <thead>
                  <tr className="border-b border-hairline bg-surface-default text-left text-xs font-medium text-ink-secondary">
                    <th className="px-4 py-2.5">名称 / 地址</th>
                    <th className="w-24 px-4 py-2.5">类型</th>
                    <th className="w-40 px-4 py-2.5">风险</th>
                    <th className="w-36 px-4 py-2.5">开放端口</th>
                    <th className="w-36 px-4 py-2.5">指纹 / 技术</th>
                    <th className="w-24 px-4 py-2.5">来源</th>
                    <th className="w-28 px-4 py-2.5">更新</th>
                  </tr>
                </thead>
                <tbody>
                  {assets.map((a) => (
                    <tr
                      key={a.id}
                      onClick={() => void openAsset(a.id)}
                      className="cursor-pointer border-b border-hairline-soft text-sm hover:bg-surface-default"
                    >
                      <td className="min-w-0 px-4 py-2.5">
                        <div className="truncate font-medium text-ink">{a.name}</div>
                        <div className="mt-0.5 truncate font-mono text-[11px] text-ink-muted">{a.address}</div>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="rounded-md bg-canvas-inset px-2 py-0.5 text-xs">{a.type_label || a.type}</span>
                      </td>
                      <td className="px-4 py-2.5">
                        <RiskBadge risk={a.risk} />
                      </td>
                      <td className="truncate px-4 py-2.5 font-mono text-xs text-ink-secondary" title={a.ports_summary || ""}>
                        {a.ports_summary || "—"}
                      </td>
                      <td className="truncate px-4 py-2.5 text-xs text-ink-secondary" title={a.tech_summary || ""}>
                        {a.tech_summary || "—"}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-ink-muted">{a.source_label || a.source}</td>
                      <td className="px-4 py-2.5 text-xs text-ink-muted">{formatDate(a.updated_at)}</td>
                    </tr>
                  ))}
                  {!assets.length && (
                    <tr>
                      <td colSpan={7} className="px-4 py-10 text-center text-sm text-ink-muted">
                        暂无资产，点击「录入资产」开始建账
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
            onClose={() => setSelected(null)}
            onExported={() => void load()}
          />
        </div>
      </div>
    </div>
  );
}

function RiskBadge({ risk }: { risk?: RiskSummary }) {
  if (!risk || risk.open_total <= 0) {
    return <span className="rounded-md bg-canvas-inset px-2 py-0.5 text-xs text-ink-muted">无开放漏洞</span>;
  }
  const highest = risk.highest || "info";
  const cls =
    highest === "critical" || highest === "high"
      ? "bg-severity-critical-subtle text-severity-critical"
      : highest === "medium"
        ? "bg-severity-medium-subtle text-severity-medium"
        : "bg-canvas-inset text-ink-secondary";
  return (
    <span className={`inline-block max-w-full truncate rounded-md px-2 py-0.5 text-xs ${cls}`} title={risk.label}>
      {risk.label}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-canvas-inset px-3 py-2">
      <div className="text-[11px] text-ink-muted">{label}</div>
      <div className="mt-0.5 font-mono text-lg font-semibold">{value}</div>
    </div>
  );
}

function ChangeList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium text-ink-muted">{title}</p>
      {items.length ? (
        <ul className="space-y-1 text-xs text-ink-secondary">
          {items.slice(0, 8).map((item, i) => (
            <li key={i} className="truncate" title={item}>
              {item}
            </li>
          ))}
          {items.length > 8 && <li className="text-ink-muted">…共 {items.length} 条</li>}
        </ul>
      ) : (
        <p className="text-xs text-ink-muted">（无）</p>
      )}
    </div>
  );
}

function formatDate(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value.slice(0, 10);
  return d.toLocaleDateString();
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
