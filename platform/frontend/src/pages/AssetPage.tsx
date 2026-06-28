import { authFetch } from "../lib/api";
import { useState, useEffect } from "react";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";

const TYPES = ["全部", "host", "web_app", "cloud_service", "code_repo"];

export default function AssetPage() {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("全部");
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const [assets, setAssets] = useState<Array<Record<string, unknown>>>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", address: "", type: "host", tags: "" });

  const load = async () => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (typeFilter !== "全部") params.set("type", typeFilter);
    const res = await authFetch(`/api/assets?${params}`);
    setAssets(res);
  };
  useEffect(() => { load(); }, []);

  const createAsset = async () => {
    await authFetch("/api/assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, tags: form.tags.split(",").map(t => t.trim()).filter(Boolean) }) });
    setShowForm(false); load();
  };

  return (
    <div className="flex h-screen bg-canvas">
      <Sidebar activeId={null} onSelect={() => {}} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar title="资产管理" />
        <div className="flex flex-1 overflow-hidden">
          <div className="flex-1 overflow-y-auto p-6">
            <div className="mb-4 flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-semibold">资产管理</h1>
              <input value={search} onChange={e => { setSearch(e.target.value); load(); }} placeholder="搜索名称/地址..." className="rounded-md border border-hairline px-3 py-2 text-sm focus:border-ink focus:outline-none" />
              <select value={typeFilter} onChange={e => { setTypeFilter(e.target.value); load(); }} className="rounded-md border border-hairline px-3 py-2 text-sm">
                {TYPES.map(t => <option key={t}>{t}</option>)}
              </select>
              <button onClick={() => setShowForm(true)} className="rounded-pill bg-ink px-4 py-2 text-sm font-medium text-white">+ 添加资产</button>
            </div>
            {showForm && (
              <div className="mb-4 rounded-md border border-hairline p-4">
                <input placeholder="名称" value={form.name} onChange={e => setForm({...form, name: e.target.value})} className="mb-2 w-full rounded border px-3 py-2 text-sm" />
                <input placeholder="地址" value={form.address} onChange={e => setForm({...form, address: e.target.value})} className="mb-2 w-full rounded border px-3 py-2 text-sm" />
                <input placeholder="标签(逗号分隔)" value={form.tags} onChange={e => setForm({...form, tags: e.target.value})} className="mb-2 w-full rounded border px-3 py-2 text-sm" />
                <div className="flex gap-2">
                  <button onClick={createAsset} className="rounded-pill bg-ink px-4 py-2 text-sm text-white">保存</button>
                  <button onClick={() => setShowForm(false)} className="rounded-pill border px-4 py-2 text-sm">取消</button>
                </div>
              </div>
            )}
            <table className="w-full border border-hairline-soft rounded-md">
              <thead><tr className="border-b border-hairline bg-surface-default text-left text-xs font-medium uppercase tracking-wider text-ink-secondary">
                <th className="px-4 py-2">名称</th><th className="px-4 py-2">地址</th><th className="px-4 py-2">类型</th><th className="px-4 py-2">标签</th><th className="px-4 py-2">来源</th><th className="px-4 py-2">更新时间</th>
              </tr></thead>
              <tbody>
                {assets.map((a: Record<string, unknown>) => (
                  <tr key={a.id as string} onClick={() => setSelected(a)} className="cursor-pointer border-b border-hairline-soft text-sm hover:bg-surface-default">
                    <td className="px-4 py-2.5 font-medium">{a.name as string}</td>
                    <td className="px-4 py-2.5 text-ink-secondary">{a.address as string}</td>
                    <td className="px-4 py-2.5"><span className="rounded-pill bg-surface-default px-2 py-0.5 text-xs">{a.type as string}</span></td>
                    <td className="px-4 py-2.5 text-xs text-ink-muted">{(a.tags as string[])?.join(", ")}</td>
                    <td className="px-4 py-2.5 text-xs text-ink-muted">{a.source as string}</td>
                    <td className="px-4 py-2.5 text-xs text-ink-muted">{(a.updated_at as string)?.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {selected && (
            <aside className="w-[360px] flex-shrink-0 overflow-y-auto border-l border-hairline p-4">
              <h2 className="mb-3 text-lg font-semibold">{selected.name as string}</h2>
              <div className="space-y-2 text-sm">
                <p><span className="text-ink-secondary">地址:</span> {selected.address as string}</p>
                <p><span className="text-ink-secondary">类型:</span> {selected.type as string}</p>
                <p><span className="text-ink-secondary">标签:</span> {(selected.tags as string[])?.join(", ") || "—"}</p>
                <p><span className="text-ink-secondary">来源:</span> {selected.source as string}</p>
                <p><span className="text-ink-secondary">属性:</span> {JSON.stringify(selected.properties) || "—"}</p>
                <p><span className="text-ink-secondary">创建时间:</span> {selected.created_at as string}</p>
              </div>
              <button onClick={() => setSelected(null)} className="mt-4 rounded-pill border px-4 py-2 text-sm">关闭</button>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
