import { useState } from "react";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";

export default function KnowledgePage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<Record<string, unknown>>>([]);

  const search = async () => {
    if (!query.trim()) return;
    const res = await fetch(`/api/knowledge/search?q=${encodeURIComponent(query)}&limit=5`);
    setResults(await res.json());
  };

  return (
    <div className="flex h-screen bg-canvas">
      <Sidebar conversations={[]} activeId={null} onSelect={() => {}} />
      <div className="flex-1 flex-col flex">
        <TopBar title="知识库" />
        <div className="flex-1 overflow-y-auto p-6">
          <h1 className="mb-4 text-2xl font-semibold">知识库</h1>
          <div className="mb-6 flex gap-2">
            <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && search()}
              placeholder="搜索 CVE、OWASP、PortSwigger 研究..." className="flex-1 rounded-md border border-hairline px-4 py-2.5 text-sm focus:border-ink focus:outline-none" />
            <button onClick={search} className="rounded-pill bg-ink px-6 py-2.5 text-sm font-medium text-white">搜索</button>
          </div>
          <div className="space-y-3">
            {results.map((r, i) => (
              <div key={i} className="rounded-md border border-hairline p-4">
                <div className="flex items-center gap-2 mb-1"><span className="text-xs text-ink-muted">{r.source as string}</span></div>
                <p className="text-sm">{r.summary as string}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
