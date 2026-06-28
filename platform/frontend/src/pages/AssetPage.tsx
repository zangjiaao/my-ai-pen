import { useState } from "react";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

export default function AssetPage() {
  const [search, setSearch] = useState("");
  const { data: assets } = useQuery({ queryKey: ["assets", search], queryFn: () => fetch(`/api/assets?search=${search}&limit=100`).then(r => r.json()) });

  return (
    <div className="flex h-screen bg-canvas">
      <Sidebar conversations={[]} activeId={null} onSelect={() => {}} />
      <div className="flex flex-1 flex-col">
        <TopBar title="资产管理" />
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mb-4 flex items-center gap-4">
            <h1 className="text-2xl font-semibold">资产管理</h1>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索资产..." className="rounded-md border border-hairline px-3 py-2 text-sm focus:border-ink focus:outline-none" />
            <button className="rounded-pill bg-ink px-4 py-2 text-sm font-medium text-white">+ 添加资产</button>
          </div>
          <table className="w-full border border-hairline-soft rounded-md">
            <thead><tr className="border-b border-hairline bg-surface-default text-left text-xs font-medium uppercase tracking-wider text-ink-secondary">
              <th className="px-4 py-2">名称</th><th className="px-4 py-2">地址</th><th className="px-4 py-2">类型</th><th className="px-4 py-2">来源</th><th className="px-4 py-2">更新时间</th>
            </tr></thead>
            <tbody>
              {(assets || []).map((a: Record<string, unknown>) => (
                <tr key={a.id as string} className="border-b border-hairline-soft text-sm hover:bg-surface-default">
                  <td className="px-4 py-2.5 font-medium">{a.name as string}</td>
                  <td className="px-4 py-2.5 text-ink-secondary">{a.address as string}</td>
                  <td className="px-4 py-2.5"><span className="rounded-pill bg-surface-default px-2 py-0.5 text-xs">{a.type as string}</span></td>
                  <td className="px-4 py-2.5 text-xs text-ink-muted">{a.source as string}</td>
                  <td className="px-4 py-2.5 text-xs text-ink-muted">{a.updated_at as string}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
