import { authFetch } from "../lib/api";
import { useState, useEffect } from "react";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";

type NodeRecord = {
  id: string;
  name: string;
  type: string;
  status: string;
  ip?: string | null;
  cpu_usage?: number | null;
  memory_usage?: number | null;
  current_sessions?: number;
  token_required?: boolean;
};

export default function NodePage() {
  const [nodes, setNodes] = useState<NodeRecord[]>([]);
  const [showRegister, setShowRegister] = useState(false);
  const [regName, setRegName] = useState("");
  const [newToken, setNewToken] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const load = async () => { const data = await authFetch<NodeRecord[]>("/api/nodes"); setNodes(data); };
  useEffect(() => { void load(); }, []);

  const register = async () => {
    const res = await authFetch("/api/nodes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: regName || undefined }) });
    const data = res as Record<string,unknown>;
    setNewToken(data.token as string);
    setShowRegister(false);
    setRegName("");
    void load();
  };

  const deleteNode = async (id: string, name: string) => {
    if (!window.confirm(`确定删除节点 "${name}"？`)) return;
    await authFetch(`/api/nodes/${id}`, { method: "DELETE" });
    void load();
  };

  const regenerateToken = async (id: string) => {
    const data = await authFetch(`/api/nodes/${id}/regenerate-token`, { method: "POST" }) as Record<string,unknown>;
    setNewToken(data.token as string);
  };

  const startEdit = (node: NodeRecord) => {
    setEditingId(node.id);
    setEditingName(node.name);
  };

  const saveEdit = async () => {
    if (!editingId || !editingName.trim()) return;
    await authFetch(`/api/nodes/${editingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: editingName.trim() }) });
    setEditingId(null);
    setEditingName("");
    window.dispatchEvent(new CustomEvent("nodes:changed"));
    void load();
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
                <button onClick={() => { void register(); }} className="rounded-pill bg-ink px-4 py-2 text-sm text-white">注册</button>
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
              {nodes.map((n) => {
                const isPlatform = n.type === "platform";
                return (
                  <div key={n.id} className="rounded-md border border-hairline p-4">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      {editingId === n.id ? (
                        <input value={editingName} onChange={e => setEditingName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void saveEdit(); if (e.key === "Escape") setEditingId(null); }} className="min-w-0 flex-1 rounded border border-hairline px-2 py-1 text-sm" />
                      ) : (
                        <span className="min-w-0 truncate font-medium">{n.name}</span>
                      )}
                      <div className="flex shrink-0 items-center gap-2">
                        <span className={`inline-block h-2 w-2 rounded-full ${n.status === "online" ? "bg-status-success" : "bg-ink-muted"}`} />
                        {editingId === n.id ? (
                          <button onClick={() => { void saveEdit(); }} className="text-xs text-ink-muted hover:text-ink">保存</button>
                        ) : (
                          <button onClick={() => startEdit(n)} className="text-xs text-ink-muted hover:text-ink">改名</button>
                        )}
                        {!isPlatform && <button onClick={() => { void regenerateToken(n.id); }} className="text-xs text-ink-muted hover:text-ink">Token</button>}
                        {!isPlatform && <button onClick={() => { void deleteNode(n.id, n.name); }} className="text-xs text-ink-muted hover:text-severity-critical">删除</button>}
                      </div>
                    </div>
                    <div className="space-y-1 text-sm text-ink-secondary">
                      <p>类型: {isPlatform ? "平台 Agent" : n.type}</p>
                      <p>IP: {n.ip || "—"}</p>
                      <p>活跃会话: {n.current_sessions || 0}</p>
                      {isPlatform && <p>Token: 内置节点，无需配置</p>}
                      {n.cpu_usage != null && <p>CPU: {n.cpu_usage}%</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}