import { useState } from "react";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";

export default function NodePage() {
  const [nodes, setNodes] = useState<Array<Record<string, unknown>>>([]);
  useState(() => { fetch("/api/nodes").then(r => r.json()).then(setNodes); });

  return (
    <div className="flex h-screen bg-canvas">
      <Sidebar conversations={[]} activeId={null} onSelect={() => {}} />
      <div className="flex flex-1 flex-col">
        <TopBar title="节点管理" />
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mb-4 flex items-center gap-4">
            <h1 className="text-2xl font-semibold">节点管理</h1>
            <button className="rounded-pill bg-ink px-4 py-2 text-sm font-medium text-white">+ 注册节点</button>
          </div>
          <div className="grid grid-cols-2 gap-4">
            {(nodes || []).map((n: Record<string, unknown>) => (
              <div key={n.id as string} className="rounded-md border border-hairline p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium">{n.name as string}</span>
                  <span className={`inline-block h-2 w-2 rounded-full ${n.status === "online" ? "bg-status-success" : "bg-ink-muted"}`} />
                </div>
                <div className="space-y-1 text-sm text-ink-secondary">
                  <p>类型: {n.type as string}</p>
                  <p>IP: {(n.ip as string) || "—"}</p>
                  <p>活跃会话: {n.current_sessions as number || 0}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
