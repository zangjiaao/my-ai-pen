import { authFetch } from "../lib/api";
import { useState, useEffect } from "react";
import { Check, Copy, Eye, EyeOff, RefreshCw } from "lucide-react";
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
  registered_at?: string | null;
  token_required?: boolean;
  token?: string | null;
};

export default function NodePage() {
  const [nodes, setNodes] = useState<NodeRecord[]>([]);
  const [showRegister, setShowRegister] = useState(false);
  const [regName, setRegName] = useState("");
  const [newToken, setNewToken] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [selectedNode, setSelectedNode] = useState<NodeRecord | null>(null);
  const [detailToken, setDetailToken] = useState("");
  const [detailTokenVisible, setDetailTokenVisible] = useState(false);

  const load = async () => {
    const data = await authFetch<NodeRecord[]>("/api/nodes");
    setNodes(data);
    setSelectedNode(current => current ? data.find(node => node.id === current.id) || null : null);
  };
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
    if (selectedNode?.id === id) setSelectedNode(null);
    void load();
  };

  const regenerateToken = async (id: string) => {
    const data = await authFetch(`/api/nodes/${id}/regenerate-token`, { method: "POST" }) as Record<string,unknown>;
    setDetailToken(data.token as string);
    setDetailTokenVisible(false);
    window.dispatchEvent(new CustomEvent("nodes:changed"));
    void load();
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

  const openDetail = async (node: NodeRecord) => {
    setSelectedNode(node);
    setDetailToken("");
    setDetailTokenVisible(false);
    try {
      setSelectedNode(await authFetch<NodeRecord>(`/api/nodes/${node.id}`));
    } catch {
      // Keep the list snapshot if detail refresh fails.
    }
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
                  <button key={n.id} type="button" onClick={() => { void openDetail(n); }} className="rounded-md border border-hairline p-4 text-left transition-colors hover:bg-surface-default">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      {editingId === n.id ? (
                        <input onClick={event => event.stopPropagation()} value={editingName} onChange={e => setEditingName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void saveEdit(); if (e.key === "Escape") setEditingId(null); }} className="min-w-0 flex-1 rounded border border-hairline px-2 py-1 text-sm" />
                      ) : (
                        <span className="min-w-0 truncate font-medium">{n.name}</span>
                      )}
                      <div className="flex shrink-0 items-center gap-2">
                        <span className={`inline-block h-2 w-2 rounded-full ${n.status === "online" ? "bg-status-success" : "bg-ink-muted"}`} />
                        {editingId === n.id ? (
                          <span onClick={(event) => { event.stopPropagation(); void saveEdit(); }} className="cursor-pointer text-xs text-ink-muted hover:text-ink">保存</span>
                        ) : (
                          <span onClick={(event) => { event.stopPropagation(); startEdit(n); }} className="cursor-pointer text-xs text-ink-muted hover:text-ink">改名</span>
                        )}
                        {!isPlatform && <span onClick={(event) => { event.stopPropagation(); void deleteNode(n.id, n.name); }} className="cursor-pointer text-xs text-ink-muted hover:text-severity-critical">删除</span>}
                      </div>
                    </div>
                    <div className="space-y-1 text-sm text-ink-secondary">
                      <p>类型: {isPlatform ? "平台 Agent" : n.type}</p>
                      <p>IP: {n.ip || "—"}</p>
                      <p>活跃会话: {n.current_sessions || 0}</p>
                      {isPlatform && <p>Token: 内置节点，无需配置</p>}
                      {n.cpu_usage != null && <p>CPU: {n.cpu_usage}%</p>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {selectedNode && (
        <NodeDetailDialog
          node={selectedNode}
          token={detailToken || selectedNode.token || ""}
          tokenVisible={detailTokenVisible}
          onToggleToken={() => setDetailTokenVisible(value => !value)}
          onClose={() => setSelectedNode(null)}
          onRegenerateToken={() => { void regenerateToken(selectedNode.id); }}
        />
      )}
    </div>
  );
}

function NodeDetailDialog({ node, token, tokenVisible, onToggleToken, onClose, onRegenerateToken }: { node: NodeRecord; token: string; tokenVisible: boolean; onToggleToken: () => void; onClose: () => void; onRegenerateToken: () => void }) {
  const isPlatform = node.type === "platform";
  const [copied, setCopied] = useState(false);

  const copyToken = async () => {
    if (!token) return;
    await navigator.clipboard?.writeText(token);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 px-4" onClick={onClose}>
      <div className="w-full max-w-xl rounded-md border border-hairline bg-canvas shadow-xl" onClick={event => event.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-hairline px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold">{node.name}</h2>
            <p className="mt-1 text-xs text-ink-muted">{node.id}</p>
          </div>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-sm text-ink-muted hover:bg-surface-default hover:text-ink">关闭</button>
        </div>
        <div className="space-y-4 px-5 py-4 text-sm">
          <Info label="类型" value={isPlatform ? "平台 Agent" : node.type} />
          <Info label="状态" value={node.status === "online" ? "在线" : "离线"} />
          <Info label="IP" value={node.ip || "—"} />
          <Info label="活跃会话" value={String(node.current_sessions || 0)} />
          <Info label="注册时间" value={formatDate(node.registered_at)} />
          <div>
            <div className="mb-1 text-xs font-medium uppercase text-ink-muted">Token</div>
            {isPlatform ? (
              <p className="text-ink-secondary">内置平台节点，无需 Token。</p>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3">
                  <button type="button" title={token ? "复制 Token" : "当前 Token 明文不可用"} onClick={() => { void copyToken(); }} className="group flex min-w-0 items-center gap-2 text-left font-mono text-xs text-ink-secondary hover:text-ink">
                    <span className="min-w-0 break-all">{token ? (tokenVisible ? token : maskToken(token)) : maskTokenPlaceholder()}</span>
                    {token && (copied ? <Check size={14} className="shrink-0 text-status-success" /> : <Copy size={14} className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />)}
                    {copied && <span className="shrink-0 font-sans text-xs text-status-success">已复制</span>}
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    {token && (
                      <button type="button" title={tokenVisible ? "隐藏 Token" : "显示 Token"} onClick={onToggleToken} className="rounded-md p-1.5 text-ink-muted hover:bg-canvas hover:text-ink">
                        {tokenVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    )}
                    <button type="button" title="刷新 Token" onClick={onRegenerateToken} className="rounded-md p-1.5 text-ink-muted hover:bg-canvas hover:text-ink">
                      <RefreshCw size={16} />
                    </button>
                  </div>
                </div>
                {token && <p className="mt-2 text-xs text-ink-muted">刷新后旧连接会被断开，需要用新 Token 重启节点。</p>}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function maskTokenPlaceholder(): string {
  return "*".repeat(32);
}

function maskToken(value: string): string {
  if (value.length <= 12) return "*".repeat(value.length);
  return `${value.slice(0, 6)}${"*".repeat(Math.min(24, Math.max(8, value.length - 12)))}${value.slice(-6)}`;
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase text-ink-muted">{label}</div>
      <div className="break-words text-ink-secondary">{value}</div>
    </div>
  );
}

function formatDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}