import { useState } from "react";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";

export default function MemoryPage() {
  const [memories] = useState<Array<Record<string, unknown>>>([]);

  return (
    <div className="flex h-screen bg-canvas">
      <Sidebar activeId={null} onSelect={() => {}} />
      <div className="flex-1 flex-col flex">
        <TopBar title="记忆管理" />
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mb-4 flex items-center gap-4">
            <h1 className="text-2xl font-semibold">记忆管理</h1>
            <button className="rounded-pill bg-ink px-4 py-2 text-sm font-medium text-white">+ 添加记忆</button>
          </div>
          {memories.length === 0 ? (
            <p className="text-sm text-ink-muted">暂无记忆。Agent 会在会话中自动学习，你也可以手动添加。</p>
          ) : (
            memories.map((m, i) => (
              <div key={i} className="border-b border-hairline-soft py-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="rounded-pill bg-surface-default px-2 py-0.5 text-xs">{m.type as string}</span>
                  <span className="text-xs text-ink-muted">来源: {m.source as string}</span>
                </div>
                <p className="text-sm">{m.content as string}</p>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
