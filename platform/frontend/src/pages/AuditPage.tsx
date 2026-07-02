import { useEffect, useMemo, useState } from "react";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";
import { authFetch } from "../lib/api";
import type { Conversation } from "../lib/types";

const ALL = "all";

type AuditLog = {
  id: string;
  timestamp: string;
  actor_type: string;
  actor_id: string;
  actor_name?: string | null;
  action: string;
  resource_type?: string | null;
  resource_id?: string | null;
  conversation_id?: string | null;
  status: string;
  node_id?: string | null;
  node_name?: string | null;
  activity: string;
  result: string;
  detail: Record<string, unknown>;
};

export default function AuditPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState(ALL);
  const [action, setAction] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const params = useMemo(() => {
    const p = new URLSearchParams();
    p.set("limit", "100");
    if (conversationId !== ALL) p.set("conversation_id", conversationId);
    if (action.trim()) p.set("action", action.trim());
    return p;
  }, [conversationId, action]);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [auditRows, conversationRows] = await Promise.all([
        authFetch<AuditLog[]>(`/api/audit?${params}`),
        authFetch<Conversation[]>("/api/conversations"),
      ]);
      setLogs(auditRows);
      setConversations(conversationRows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "审计日志加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [params.toString()]);

  return (
    <div className="flex h-screen bg-canvas">
      <Sidebar activeId={null} onSelect={() => {}} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar title="审计日志" />
        <main className="flex-1 overflow-y-auto p-6">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold">审计日志</h1>
            <select value={conversationId} onChange={(event) => setConversationId(event.target.value)} className="max-w-sm rounded-md border border-hairline bg-canvas px-3 py-2 text-sm">
              <option value={ALL}>全部会话</option>
              {conversations.map((conversation) => (
                <option key={conversation.id} value={conversation.id}>{conversation.title}</option>
              ))}
            </select>
            <input value={action} onChange={(event) => setAction(event.target.value)} placeholder="按 action 过滤" className="rounded-md border border-hairline bg-canvas px-3 py-2 text-sm focus:border-ink focus:outline-none" />
            <button type="button" onClick={() => { void load(); }} className="rounded-md border border-hairline px-3 py-2 text-sm text-ink-secondary hover:bg-surface-default hover:text-ink">刷新</button>
          </div>

          {error && <div className="mb-4 rounded-md border border-severity-critical/30 bg-severity-critical-subtle px-4 py-3 text-sm text-severity-critical">{error}</div>}

          <div className="overflow-hidden rounded-md border border-hairline-soft bg-surface-raised">
            <table className="w-full table-fixed">
              <thead>
                <tr className="border-b border-hairline bg-surface-default text-left text-xs font-medium uppercase text-ink-secondary">
                  <th className="w-44 px-4 py-2">Time</th>
                  <th className="w-40 px-4 py-2">Node</th>
                  <th className="px-4 py-2">Activity</th>
                  <th className="w-64 px-4 py-2">Result</th>
                  <th className="w-40 px-4 py-2">Conversation</th>
                  <th className="w-[28rem] px-4 py-2">Detail</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id} className="border-b border-hairline-soft align-top text-sm hover:bg-surface-default">
                    <td className="px-4 py-2.5 text-xs text-ink-muted">{formatDate(log.timestamp)}</td>
                    <td className="px-4 py-2.5 text-xs text-ink-secondary">
                      <div className="truncate font-medium text-ink-secondary" title={log.node_id || log.actor_id}>{log.node_name || actorLabel(log)}</div>
                      <div className="truncate font-mono text-[11px] text-ink-muted">{shortId(log.node_id || log.actor_id)}</div>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="break-words text-sm text-ink">{log.activity}</div>
                      <div className="mt-1 font-mono text-[11px] text-ink-muted">{log.action}</div>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`mb-1 inline-block rounded-md px-2 py-0.5 text-xs ${statusClass(log.status)}`}>{log.status}</span>
                      <div className="break-words text-xs text-ink-secondary">{log.result}</div>
                    </td>
                    <td className="truncate px-4 py-2.5 font-mono text-xs text-ink-muted" title={log.conversation_id || ""}>{shortId(log.conversation_id)}</td>
                    <td className="px-4 py-2.5"><pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-md bg-canvas-inset p-2 font-mono text-xs text-ink-secondary">{JSON.stringify(log.detail || {}, null, 2)}</pre></td>
                  </tr>
                ))}
                {!logs.length && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-ink-muted">{loading ? "加载中..." : "暂无审计事件"}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </main>
      </div>
    </div>
  );
}

function actorLabel(log: AuditLog): string {
  if (log.actor_type === "agent") return "Agent";
  if (log.actor_type === "node") return "Node";
  if (log.actor_type === "user") return "User";
  if (log.actor_type === "system") return "System";
  return log.actor_type || "—";
}

function shortId(value?: string | null): string {
  return value ? value.slice(0, 8) : "—";
}

function formatDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function statusClass(status: string): string {
  if (status === "success") return "bg-severity-low-subtle text-severity-low";
  if (status === "failed" || status === "error") return "bg-severity-critical-subtle text-severity-critical";
  if (status === "blocked") return "bg-severity-medium-subtle text-severity-medium";
  return "bg-canvas-inset text-ink-secondary";
}