import { useState } from "react";

type Tab = "discoveries" | "progress" | "pending";

interface Props {
  phase?: string;
  iteration?: number;
  maxIteration?: number;
  activeTool?: string;
  findings?: Array<Record<string, unknown>>;
}

export default function RightPanel({ phase, iteration, maxIteration, activeTool, findings = [] }: Props) {
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
        {tab === "discoveries" && (
          findings.length === 0 ? (
            <p className="text-sm text-ink-muted">暂无发现</p>
          ) : (
            <div className="space-y-2">
              {findings.map((f, i) => (
                <div key={i} className="rounded-md border border-hairline-soft p-2">
                  <div className="flex items-center gap-1 mb-1">
                    <span className={`inline-block rounded-pill px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider bg-severity-${f.severity}-subtle text-severity-${f.severity}`}>{f.severity as string}</span>
                    <span className="text-sm font-medium truncate">{f.title as string}</span>
                  </div>
                  <p className="text-xs text-ink-muted">{f.location as string}</p>
                </div>
              ))}
            </div>
          )
        )}
        {tab === "progress" && (
          <div className="space-y-3">
            <div>
              <p className="text-xs text-ink-muted mb-1">当前阶段</p>
              <p className="text-sm font-medium">{phase || "等待中..."}</p>
            </div>
            {iteration != null && maxIteration != null && (
              <div>
                <p className="text-xs text-ink-muted mb-1">迭代 {iteration}/{maxIteration}</p>
                <div className="h-1.5 rounded-full bg-hairline">
                  <div className="h-1.5 rounded-full bg-ink" style={{ width: `${Math.min(100, (iteration / maxIteration) * 100)}%` }} />
                </div>
              </div>
            )}
            {activeTool && (
              <div>
                <p className="text-xs text-ink-muted mb-1">活跃工具</p>
                <p className="text-sm font-mono">{activeTool}</p>
              </div>
            )}
            {!phase && <p className="text-sm text-ink-muted">等待 Agent 开始...</p>}
          </div>
        )}
        {tab === "pending" && <p className="text-sm text-ink-muted">无待处理项</p>}
      </div>
    </aside>
  );
}
