import { useAuthStore } from "../stores/authStore";
import type { Conversation } from "../lib/types";

interface Props {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
}

export default function Sidebar({ conversations, activeId, onSelect }: Props) {
  const { user, logout } = useAuthStore();

  return (
    <aside className="flex w-[280px] flex-shrink-0 flex-col border-r border-hairline bg-surface-sidebar">
      <div className="p-3">
        <button onClick={() => onSelect(crypto.randomUUID())} className="w-full rounded-pill bg-ink px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90">
          + 创建会话
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2">
        <p className="px-3 py-2 font-mono text-[11px] font-medium uppercase tracking-wider text-ink-muted">会话</p>
        {conversations.length === 0 ? (
          <p className="px-3 py-4 text-center text-sm text-ink-muted">暂无会话</p>
        ) : (
          conversations.map((c) => (
            <button key={c.id} onClick={() => onSelect(c.id)}
              className={`w-full rounded-md px-3 py-2.5 text-left text-sm transition-colors ${c.id === activeId ? "bg-accent-subtle font-medium text-ink" : "text-ink-secondary hover:bg-surface-default hover:text-ink"}`}>
              <div className="flex items-center gap-2">
                <span className={`inline-block h-2 w-2 rounded-full ${c.status === "running" ? "bg-status-running" : c.status === "completed" ? "bg-status-success" : "bg-ink-muted"}`} />
                {c.title}
              </div>
            </button>
          ))
        )}
      </div>

      <div className="border-t border-hairline-soft px-2 py-2">
        <nav className="space-y-0.5">
          {["资产管理", "漏洞管理", "节点管理"].map((label) => (
            <button key={label} className="w-full rounded-md px-3 py-2 text-left text-sm text-ink-secondary transition-colors hover:bg-surface-default hover:text-ink">{label}</button>
          ))}
        </nav>
      </div>

      <div className="border-t border-hairline-soft p-3">
        <p className="text-xs text-ink-muted">{user?.email}</p>
        <button onClick={logout} className="mt-1 text-xs text-ink-secondary hover:text-ink">退出</button>
      </div>
    </aside>
  );
}
