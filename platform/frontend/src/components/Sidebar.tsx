import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";
import { useConversationStore } from "../stores/conversationStore";
import { authFetch } from "../lib/api";
import ConfirmDialog from "./ConfirmDialog";

interface Props {
  activeId: string | null;
  onSelect: (id: string) => void;
}

const NAV_ITEMS = [
  { label: "资产管理", path: "/assets" },
  { label: "漏洞管理", path: "/vulnerabilities" },
  { label: "节点管理", path: "/nodes" },
  { label: "Skill 管理", path: "/skills" },
  { label: "知识库", path: "/knowledge" },
  { label: "记忆管理", path: "/memories" },
];

export default function Sidebar({ activeId, onSelect }: Props) {
  const { user, logout } = useAuthStore();
  const { conversations, fetchAll } = useConversationStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);

  useEffect(() => { fetchAll(); }, []);

  return (
    <aside className="flex w-[280px] flex-shrink-0 flex-col border-r border-hairline bg-surface-sidebar">
      <div className="p-3">
        <button onClick={() => { navigate("/"); onSelect(""); }} className="w-full rounded-pill bg-ink px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90">
          + 新建会话
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2">
        <p className="px-3 py-2 font-mono text-[11px] font-medium uppercase tracking-wider text-ink-muted">会话</p>
        {conversations.length === 0 ? (
          <p className="px-3 py-4 text-center text-sm text-ink-muted">暂无会话</p>
        ) : (
          conversations.map((c) => (
            <div key={c.id} className="group flex items-center">
              <button onClick={() => { navigate("/"); onSelect(c.id); }}
                className={`flex-1 rounded-md px-3 py-2.5 text-left text-sm transition-colors ${c.id === activeId ? "bg-accent-subtle font-medium text-ink" : "text-ink-secondary hover:bg-surface-default hover:text-ink"}`}>
                <div className="flex items-center gap-2">
                  <span className={`inline-block h-2 w-2 rounded-full ${c.status === "running" ? "bg-status-running" : c.status === "completed" ? "bg-status-success" : "bg-ink-muted"}`} />
                  <span className="truncate">{c.title}</span>
                </div>
              </button>
              <button onClick={(e) => { e.stopPropagation(); setDeleteTarget({ id: c.id, title: c.title }); }}
                className="mr-1 rounded-full p-1 text-ink-muted opacity-0 transition-opacity hover:bg-surface-default hover:text-severity-critical group-hover:opacity-100" title="删除会话">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          ))
        )}
      </div>

      <div className="border-t border-hairline-soft px-2 py-2">
        <nav className="space-y-0.5">
          {NAV_ITEMS.map(({ label, path }) => (
            <button key={label} onClick={() => navigate(path)}
              className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${location.pathname === path ? "font-medium text-ink" : "text-ink-secondary hover:bg-surface-default hover:text-ink"}`}>
              {label}
            </button>
          ))}
        </nav>
      </div>

      <div className="border-t border-hairline-soft p-3">
        <p className="text-xs text-ink-muted">{user?.email}</p>
        <button onClick={logout} className="mt-1 text-xs text-ink-secondary hover:text-ink">退出</button>
      </div>
      <ConfirmDialog
        open={!!deleteTarget}
        title="删除会话"
        description={`确定删除会话 "${deleteTarget?.title}"? 此操作不可撤销。`}
        onConfirm={() => { authFetch(`/api/conversations/${deleteTarget!.id}`, { method: "DELETE" }).then(fetchAll); setDeleteTarget(null); }}
        onCancel={() => setDeleteTarget(null)}
      />
    </aside>
  );
}
