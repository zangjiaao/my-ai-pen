import { authFetch } from "../lib/api";
import { useState, useEffect } from "react";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";

export default function NodePage() {
  const [nodes, setNodes] = useState<Array<Record<string, unknown>>>([]);
  const [showRegister, setShowRegister] = useState(false);
  const [regName, setRegName] = useState("");
  const [newToken, setNewToken] = useState("");

  const load = async () => { const data = await authFetch("/api/nodes"); setNodes(data); };
  useEffect(() => { load(); }, []);

  const register = async () => {
    const res = await authFetch("/api/nodes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: regName || undefined }) });
    const data = res as Record<string,unknown>;
    setNewToken(data.token as string);
    setShowRegister(false);
    load();
  };

  const deleteNode = async (id: string, name: string) => {
    if (!window.confirm(`确定删除节点 "${name}"？`)) return;
    await authFetch(`/api/nodes/${id}`, { method: "DELETE" });
    load();
  };

  const regenerateToken = async (id: string) => {
    const data = await authFetch(`/api/nodes/${id}/regenerate-token`, { method: "POST" }) as Record<string,unknown>;
    setNewToken(data.token as string);
  };

  return (
    <div className="flex h-screen bg-canvas">
      <Sidebar activeId={null} onSelect={() => {}} />
      <div className="flex flex-1 flex-col">
        <TopBar title="节点管理" />
        <div className="flex-1 overflow-y-auto p-6">
          <h1 className="mb-4 text-2xl font-semibold">节点管理</h1>
          <button onClick={() => setShowRegister(true)} className="mb-4 rounded-pill bg-ink px-4 py-2 text-sm font-medium text-white">+ 注册节点</button>

          {showRegister && (
            <div className="mb-4 rounded-md border border-hairline p-4">
              <input value={regName} onChange={e => setRegName(e.target.value)} placeholder="节点名称 (留空自动生成)" className="mb-2 w-full rounded border px-3 py-2 text-sm" />
              <div className="flex gap-2">
                <button onClick={register} className="rounded-pill bg-ink px-4 py-2 text-sm text-white">注册</button>
                <button onClick={() => setShowRegister(false)} className="rounded-pill border px-4 py-2 text-sm">取消</button>
              </div>
            </div>
          )}

          {newToken && (
            <div className="mb-4 rounded-md border border-hairline bg-surface-default p-4">
              <p className="mb-1 text-sm font-medium">节点注册成功</p>
              <p className="mb-2 font-mono text-xs break-all text-ink-secondary">Token: {newToken}</p>
              <p className="text-xs text-ink-muted">启动 Node 时设置环境变量 NODE_TOKEN={newToken}</p>
              <button onClick={() => setNewToken("")} className="mt-2 text-xs text-ink-secondary hover:text-ink">关闭</button>
            </div>
          )}

          {nodes.length === 0 ? (
            <p className="text-sm text-ink-muted">暂无注册节点。点击上方按钮注册第一个渗透 Node。</p>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              {nodes.map((n: Record<string, unknown>) => (
                <div key={n.id as string} className="rounded-md border border-hairline p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="font-medium">{n.name as string}</span>
                    <div className="flex items-center gap-2">
                      <span className={`inline-block h-2 w-2 rounded-full ${n.status === "online" ? "bg-status-success" : "bg-ink-muted"}`} />
                      <button onClick={() => regenerateToken(n.id as string)} className="text-xs text-ink-muted hover:text-ink">Token</button>
                      <button onClick={() => deleteNode(n.id as string, n.name as string)} className="text-xs text-ink-muted hover:text-severity-critical">删除</button>
                    </div>
                  </div>
                  <div className="space-y-1 text-sm text-ink-secondary">
                    <p>类型: {n.type as string}</p>
                    <p>IP: {(n.ip as string) || "—"}</p>
                    <p>活跃会话: {n.current_sessions as number || 0}</p>
                    {n.cpu_usage != null && <p>CPU: {n.cpu_usage as number}%</p>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
