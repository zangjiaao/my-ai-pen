import { useEffect, useMemo, useState } from "react";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";
import { authFetch } from "../lib/api";
import AssetDetailDialog from "../components/AssetDetailDialog";

type RelatedVuln = {
  id: string;
  title: string;
  severity: string;
  status: string;
  confidence: string;
};

type Asset = {
  id: string;
  conversation_id?: string | null;
  node_id?: string | null;
  name: string;
  address: string;
  type: string;
  tags: string[];
  properties: Record<string, unknown>;
  source: string;
  related_vulnerabilities: RelatedVuln[];
  created_at?: string | null;
  updated_at?: string | null;
};

const ALL = "All";
const TYPES = [ALL, "host", "web", "web_app", "cloud_service", "code_repo"];

function shortId(value?: string | null) {
  return value ? value.slice(0, 8) : "-";
}

export default function AssetPage() {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState(ALL);
  const [selected, setSelected] = useState<Asset | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", address: "", type: "host", tags: "" });

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (search.trim()) p.set("search", search.trim());
    if (typeFilter !== ALL) p.set("type", typeFilter);
    p.set("limit", "100");
    return p;
  }, [search, typeFilter]);

  const load = async () => {
    const res = await authFetch<Asset[]>(`/api/assets?${params}`);
    setAssets(res);
    if (selected) {
      const fresh = res.find((item) => item.id === selected.id);
      if (fresh) setSelected(fresh);
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
    await authFetch("/api/assets", {
      method: "POST",
      body: JSON.stringify({
        ...form,
        tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
      }),
    });
    setShowForm(false);
    setForm({ name: "", address: "", type: "host", tags: "" });
    await load();
  };

  return (
    <div className="flex h-screen bg-canvas">
      <Sidebar activeId={null} onSelect={() => {}} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar title="资产管理" />
        <div className="flex flex-1 overflow-hidden">
          <main className="flex-1 overflow-y-auto p-6">
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or address" className="rounded-md border border-hairline px-3 py-2 text-sm focus:border-ink focus:outline-none" />
              <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="rounded-md border border-hairline px-3 py-2 text-sm">
                {TYPES.map((t) => <option key={t}>{t}</option>)}
              </select>
              <button onClick={() => setShowForm(true)} className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-white">Add Asset</button>
            </div>

            {showForm && (
              <div className="mb-4 rounded-md border border-hairline bg-surface-default p-4">
                <div className="grid gap-3 md:grid-cols-4">
                  <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="rounded border border-hairline px-3 py-2 text-sm" />
                  <input placeholder="Address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className="rounded border border-hairline px-3 py-2 text-sm" />
                  <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="rounded border border-hairline px-3 py-2 text-sm">
                    {TYPES.filter((t) => t !== ALL).map((t) => <option key={t}>{t}</option>)}
                  </select>
                  <input placeholder="Tags, comma separated" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} className="rounded border border-hairline px-3 py-2 text-sm" />
                </div>
                <div className="mt-3 flex gap-2">
                  <button onClick={createAsset} className="rounded-md bg-ink px-4 py-2 text-sm text-white">Save</button>
                  <button onClick={() => setShowForm(false)} className="rounded-md border border-hairline px-4 py-2 text-sm">Cancel</button>
                </div>
              </div>
            )}

            <div className="overflow-hidden rounded-md border border-hairline-soft bg-surface-raised">
              <table className="w-full table-fixed">
                <thead>
                  <tr className="border-b border-hairline bg-surface-default text-left text-xs font-medium uppercase text-ink-secondary">
                    <th className="px-4 py-2">Name</th>
                    <th className="px-4 py-2">Address</th>
                    <th className="px-4 py-2">Type</th>
                    <th className="px-4 py-2">Source</th>
                    <th className="px-4 py-2">Vulns</th>
                    <th className="px-4 py-2">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {assets.map((a) => (
                    <tr key={a.id} onClick={() => void openAsset(a.id)} className="cursor-pointer border-b border-hairline-soft text-sm hover:bg-surface-default">
                      <td className="truncate px-4 py-2.5 font-medium">{a.name}</td>
                      <td className="truncate px-4 py-2.5 font-mono text-xs text-ink-secondary">{a.address}</td>
                      <td className="px-4 py-2.5"><span className="rounded-md bg-canvas-inset px-2 py-0.5 text-xs">{a.type}</span></td>
                      <td className="px-4 py-2.5 text-xs text-ink-muted">{a.source}</td>
                      <td className="px-4 py-2.5 text-xs text-ink-muted">{a.related_vulnerabilities?.length ?? 0}</td>
                      <td className="px-4 py-2.5 text-xs text-ink-muted">{a.updated_at?.slice(0, 10) || "-"}</td>
                    </tr>
                  ))}
                  {!assets.length && <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-ink-muted">No assets</td></tr>}
                </tbody>
              </table>
            </div>
          </main>

          <AssetDetailDialog
            open={Boolean(selected)}
            assetId={selected?.id}
            initial={selected}
            onClose={() => setSelected(null)}
          />
        </div>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-canvas-inset p-2">
      <div className="text-xs text-ink-muted">{label}</div>
      <div className="mt-1 truncate font-mono text-xs">{value || "-"}</div>
    </div>
  );
}
