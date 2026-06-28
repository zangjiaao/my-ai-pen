import { useState } from "react";

type Tab = "discoveries" | "progress" | "pending";

export default function RightPanel() {
  const [tab, setTab] = useState<Tab>("discoveries");

  const tabs: { key: Tab; label: string }[] = [
    { key: "discoveries", label: "发现" },
    { key: "progress", label: "进度" },
    { key: "pending", label: "待处理" },
  ];

  return (
    <aside className="w-[360px] flex-shrink-0 border-l border-hairline bg-canvas flex flex-col">
      <nav className="flex border-b border-hairline-soft">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex-1 py-2.5 text-sm font-medium transition-colors ${tab === t.key ? "text-ink border-b-2 border-ink" : "text-ink-secondary border-b-2 border-transparent hover:text-ink"}`}>
            {t.label}
          </button>
        ))}
      </nav>
      <div className="flex-1 overflow-y-auto p-4">
        {tab === "discoveries" && <p className="text-sm text-ink-muted">暂无发现</p>}
        {tab === "progress" && (
          <div className="space-y-2">
            <p className="text-sm text-ink-muted">等待 Agent 开始...</p>
          </div>
        )}
        {tab === "pending" && <p className="text-sm text-ink-muted">无待处理项</p>}
      </div>
    </aside>
  );
}
