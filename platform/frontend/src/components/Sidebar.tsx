import { useEffect, useState } from "react";
import {
  Bot,
  Check,
  ClipboardList,
  LayoutDashboard,
  Network,
  Pencil,
  Server,
  ShieldAlert,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";
import { useConversationStore } from "../stores/conversationStore";
import { authFetch } from "../lib/api";
import ConfirmDialog from "./ConfirmDialog";

interface Props {
  activeId: string | null;
  onSelect: (id: string) => void;
}

const ACTIVE_CONVERSATION_KEY = "active_conversation_id";

const NAV_ITEMS: { label: string; path: string; icon: LucideIcon }[] = [
  // Status board only — not product home (Agent conversation stays primary).
  { label: "状态看板", path: "/dashboard", icon: LayoutDashboard },
  { label: "资产管理", path: "/assets", icon: Server },
  { label: "漏洞管理", path: "/vulnerabilities", icon: ShieldAlert },
  { label: "节点管理", path: "/nodes", icon: Network },
  { label: "专家管理", path: "/experts", icon: Bot },
  { label: "操作审计", path: "/audit", icon: ClipboardList },
];

export default function Sidebar({ activeId, onSelect }: Props) {
  const { user, logout } = useAuthStore();
  const { conversations, fetchAll, removeLocal } = useConversationStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const startRename = (conversation: { id: string; title: string }) => {
    setRenameTarget(conversation);
    setRenameValue(conversation.title);
  };

  const submitRename = async () => {
    if (!renameTarget) return;
    const title = renameValue.trim();
    if (!title || title === renameTarget.title) {
      setRenameTarget(null);
      return;
    }
    await authFetch(`/api/conversations/${renameTarget.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    setRenameTarget(null);
    await fetchAll();
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const targetId = deleteTarget.id;
    setDeleteError(null);
    try {
      await authFetch(`/api/conversations/${targetId}`, { method: "DELETE" });
      removeLocal(targetId);
      if (activeId === targetId) {
        localStorage.removeItem(ACTIVE_CONVERSATION_KEY);
        onSelect("");
        navigate("/");
      }
      setDeleteTarget(null);
      await fetchAll();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "??????");
    }
  };

  return (
    <aside className="flex w-[280px] flex-shrink-0 flex-col border-r border-hairline bg-surface-sidebar">
      <div className="p-3">
        <button onClick={() => { localStorage.removeItem(ACTIVE_CONVERSATION_KEY); navigate("/"); onSelect(""); }} className="w-full rounded-pill bg-ink px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90">
          + 新建会话
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2">
        <p className="px-3 py-2 font-mono text-[11px] font-medium uppercase tracking-wider text-ink-muted">会话</p>
        {conversations.length === 0 ? (
          <p className="px-3 py-4 text-center text-sm text-ink-muted">暂无会话</p>
        ) : (
          conversations.map((c) => (
            <div key={c.id} className="group flex min-h-[40px] items-center gap-1 rounded-md">
              {renameTarget?.id === c.id ? (
                <div className="flex flex-1 items-center gap-1 px-1 py-1">
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void submitRename();
                      if (e.key === "Escape") setRenameTarget(null);
                    }}
                    className="min-w-0 flex-1 rounded-md border border-hairline bg-canvas px-2 py-1.5 text-sm text-ink focus:border-ink focus:outline-none"
                  />
                  <button onMouseDown={(e) => e.preventDefault()} onClick={() => { void submitRename(); }} className="rounded-md p-1.5 text-ink-secondary hover:bg-surface-default hover:text-ink" title="保存名称">
                    <Check size={14} />
                  </button>
                  <button onMouseDown={(e) => e.preventDefault()} onClick={() => setRenameTarget(null)} className="rounded-md p-1.5 text-ink-secondary hover:bg-surface-default hover:text-ink" title="取消重命名">
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <>
                  <button onClick={() => { localStorage.setItem(ACTIVE_CONVERSATION_KEY, c.id); navigate("/"); onSelect(c.id); }}
                    className={`min-w-0 flex-1 rounded-md px-3 py-2.5 text-left text-sm transition-colors ${c.id === activeId ? "bg-accent-subtle font-medium text-ink" : "text-ink-secondary hover:bg-surface-default hover:text-ink"}`}>
                    <div className="flex items-center gap-2">
                      <span className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${statusDotClass(c.status)}`} />
                      <span className="truncate">{c.title}</span>
                    </div>
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); startRename(c); }}
                    className="rounded-md p-1.5 text-ink-muted opacity-0 transition-opacity hover:bg-surface-default hover:text-ink group-hover:opacity-100" title="重命名会话">
                    <Pencil size={14} />
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); setDeleteError(null); setDeleteTarget({ id: c.id, title: c.title }); }}
                    className="mr-1 rounded-md p-1.5 text-ink-muted opacity-0 transition-opacity hover:bg-surface-default hover:text-severity-critical group-hover:opacity-100" title="删除会话">
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </div>
          ))
        )}
      </div>

      <div className="border-t border-hairline-soft px-2 py-2">
        <nav className="space-y-0.5">
          {NAV_ITEMS.map(({ label, path, icon: Icon }) => {
            const active = location.pathname === path || location.pathname.startsWith(`${path}/`);
            return (
              <button
                key={path}
                type="button"
                onClick={() => navigate(path)}
                className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  active
                    ? "bg-accent-subtle font-medium text-ink"
                    : "text-ink-secondary hover:bg-surface-default hover:text-ink"
                }`}
              >
                <Icon size={15} strokeWidth={1.75} className={`flex-shrink-0 ${active ? "text-ink" : "text-ink-muted"}`} />
                <span>{label}</span>
              </button>
            );
          })}
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
        onConfirm={() => { void confirmDelete(); }}
        onCancel={() => { setDeleteTarget(null); setDeleteError(null); }}
        error={deleteError}
      />
    </aside>
  );
}

function statusDotClass(status: string) {
  if (status === "running") return "bg-status-running";
  if (status === "completed") return "bg-status-success";
  if (status === "incomplete") return "bg-severity-medium";
  if (status === "failed" || status === "canceled") return "bg-severity-critical";
  if (status === "paused") return "bg-ink-secondary";
  return "bg-ink-muted";
}
