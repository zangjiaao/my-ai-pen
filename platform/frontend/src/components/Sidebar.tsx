import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  CalendarClock,
  Check,
  ClipboardList,
  LayoutDashboard,
  LogOut,
  MessageSquarePlus,
  Network,
  PanelLeft,
  PanelLeftClose,
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
import { BRAND_NAME } from "../lib/brand";

interface Props {
  activeId: string | null;
  onSelect: (id: string) => void;
}

const ACTIVE_CONVERSATION_KEY = "active_conversation_id";
const SIDEBAR_COLLAPSED_KEY = "sidebar_collapsed";

const FEATURE_ITEMS: { label: string; path: string; icon: LucideIcon }[] = [
  { label: "资产管理", path: "/assets", icon: Server },
  { label: "漏洞管理", path: "/vulnerabilities", icon: ShieldAlert },
  { label: "任务计划", path: "/schedules", icon: CalendarClock },
  { label: "节点管理", path: "/nodes", icon: Network },
  { label: "专家管理", path: "/experts", icon: Bot },
  { label: "操作审计", path: "/audit", icon: ClipboardList },
];

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function userInitials(email?: string | null, displayName?: string | null): string {
  const name = (displayName || "").trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }
  const local = (email || "?").split("@")[0] || "?";
  return local.slice(0, 2).toUpperCase();
}

function NavRow(props: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick: () => void;
  collapsed: boolean;
}) {
  const Icon = props.icon;
  if (props.collapsed) {
    return (
      <button
        type="button"
        onClick={props.onClick}
        title={props.label}
        aria-label={props.label}
        className={`mx-auto flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
          props.active
            ? "bg-accent-subtle text-ink"
            : "text-ink-muted hover:bg-surface-default hover:text-ink"
        }`}
      >
        <Icon size={17} strokeWidth={1.75} />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
        props.active
          ? "bg-accent-subtle font-medium text-ink"
          : "text-ink-secondary hover:bg-surface-default hover:text-ink"
      }`}
    >
      <Icon
        size={16}
        strokeWidth={1.75}
        className={`flex-shrink-0 ${props.active ? "text-ink" : "text-ink-muted"}`}
      />
      <span className="truncate">{props.label}</span>
    </button>
  );
}

export default function Sidebar({ activeId, onSelect }: Props) {
  const { user, logout } = useAuthStore();
  const { conversations, fetchAll, removeLocal } = useConversationStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === SIDEBAR_COLLAPSED_KEY) setCollapsed(e.newValue === "1");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const goHomeNewChat = () => {
    localStorage.removeItem(ACTIVE_CONVERSATION_KEY);
    navigate("/");
    onSelect("");
  };

  const dashboardActive =
    location.pathname === "/dashboard" || location.pathname.startsWith("/dashboard/");
  const onConversationHome = location.pathname === "/" || location.pathname === "";

  const initials = useMemo(
    () => userInitials(user?.email, user?.display_name),
    [user?.email, user?.display_name],
  );
  const displayLabel = user?.display_name?.trim() || user?.email?.split("@")[0] || "用户";

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
      setDeleteError(error instanceof Error ? error.message : "删除失败");
    }
  };

  return (
    <aside
      className={`sidebar-shell flex flex-shrink-0 flex-col overflow-hidden border-r border-hairline bg-surface-sidebar ${
        collapsed ? "w-16" : "w-[280px]"
      }`}
    >
      {/* 1. Logo */}
      {collapsed ? (
        <div className="flex h-16 shrink-0 flex-col items-center justify-center gap-1">
          <button
            type="button"
            onClick={goHomeNewChat}
            className="sidebar-logo flex items-center justify-center rounded-lg hover:opacity-80"
            title="Cyber Security"
            aria-label={BRAND_NAME}
          >
            <span className="sidebar-logo-cyber">C</span>
          </button>
        </div>
      ) : (
        <div className="flex h-16 shrink-0 items-center justify-between gap-1 px-2">
          <button
            type="button"
            onClick={goHomeNewChat}
            className="sidebar-logo group min-w-0 px-3 text-left"
            title="回到会话"
            aria-label={BRAND_NAME}
          >
            <span className="sidebar-logo-cyber">Cyber</span>
            <span className="sidebar-logo-security">Security</span>
          </button>
          <button
            type="button"
            onClick={toggleCollapsed}
            className="mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-default hover:text-ink"
            title="折叠侧栏"
            aria-label="折叠侧栏"
            aria-expanded
          >
            <PanelLeftClose size={16} strokeWidth={1.75} />
          </button>
        </div>
      )}

      {/* 2. 快捷区 */}
      <div className={`shrink-0 space-y-0.5 pt-0.5 ${collapsed ? "px-1" : "px-2"}`}>
        {collapsed && (
          <button
            type="button"
            onClick={toggleCollapsed}
            title="展开侧栏"
            aria-label="展开侧栏"
            className="mx-auto flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-default hover:text-ink"
          >
            <PanelLeft size={16} strokeWidth={1.75} />
          </button>
        )}
        <NavRow
          icon={LayoutDashboard}
          label="状态看板"
          active={dashboardActive}
          collapsed={collapsed}
          onClick={() => navigate("/dashboard")}
        />
        <NavRow
          icon={MessageSquarePlus}
          label="新建会话"
          active={onConversationHome && !activeId}
          collapsed={collapsed}
          onClick={goHomeNewChat}
        />
      </div>

      {/* 3. 会话 */}
      <div className={`mt-3 flex min-h-0 flex-1 flex-col ${collapsed ? "px-1" : "px-2"}`}>
        {!collapsed && (
          <p className="shrink-0 px-3 pb-1.5 pt-1 font-mono text-[11px] font-medium uppercase tracking-wider text-ink-muted">
            会话
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {collapsed ? (
            <div className="flex flex-col items-center gap-1 py-1">
              {conversations.slice(0, 8).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  title={c.title}
                  onClick={() => {
                    localStorage.setItem(ACTIVE_CONVERSATION_KEY, c.id);
                    navigate("/");
                    onSelect(c.id);
                  }}
                  className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
                    c.id === activeId && onConversationHome
                      ? "bg-accent-subtle"
                      : "hover:bg-surface-default"
                  }`}
                >
                  <span className={`h-2 w-2 rounded-full ${statusDotClass(c.status)}`} />
                </button>
              ))}
            </div>
          ) : conversations.length === 0 ? (
            <p className="px-3 py-4 text-center text-sm text-ink-muted">暂无会话</p>
          ) : (
            conversations.map((c) => (
              <div key={c.id} className="group flex min-h-[36px] items-center gap-0.5 rounded-lg">
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
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        void submitRename();
                      }}
                      className="rounded-md p-1.5 text-ink-secondary hover:bg-surface-default hover:text-ink"
                      title="保存名称"
                    >
                      <Check size={14} />
                    </button>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setRenameTarget(null)}
                      className="rounded-md p-1.5 text-ink-secondary hover:bg-surface-default hover:text-ink"
                      title="取消重命名"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        localStorage.setItem(ACTIVE_CONVERSATION_KEY, c.id);
                        navigate("/");
                        onSelect(c.id);
                      }}
                      className={`min-w-0 flex-1 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                        c.id === activeId && onConversationHome
                          ? "bg-accent-subtle font-medium text-ink"
                          : "text-ink-secondary hover:bg-surface-default hover:text-ink"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${statusDotClass(c.status)}`}
                        />
                        <span className="truncate">{c.title}</span>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        startRename(c);
                      }}
                      className="rounded-md p-1.5 text-ink-muted opacity-0 transition-opacity hover:bg-surface-default hover:text-ink group-hover:opacity-100"
                      title="重命名会话"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteError(null);
                        setDeleteTarget({ id: c.id, title: c.title });
                      }}
                      className="mr-0.5 rounded-md p-1.5 text-ink-muted opacity-0 transition-opacity hover:bg-surface-default hover:text-severity-critical group-hover:opacity-100"
                      title="删除会话"
                    >
                      <Trash2 size={14} />
                    </button>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* 4. 功能区 */}
      <div className={`shrink-0 border-t border-hairline-soft py-2 ${collapsed ? "px-1" : "px-2"}`}>
        {!collapsed && (
          <p className="px-3 pb-1.5 pt-0.5 font-mono text-[11px] font-medium uppercase tracking-wider text-ink-muted">
            功能
          </p>
        )}
        <nav className={collapsed ? "flex flex-col items-center gap-0.5" : "space-y-0.5"}>
          {FEATURE_ITEMS.map(({ label, path, icon }) => {
            const active =
              location.pathname === path || location.pathname.startsWith(`${path}/`);
            return (
              <NavRow
                key={path}
                icon={icon}
                label={label}
                active={active}
                collapsed={collapsed}
                onClick={() => navigate(path)}
              />
            );
          })}
        </nav>
      </div>

      {/* 5. 用户 */}
      <div className={`shrink-0 border-t border-hairline-soft ${collapsed ? "p-1.5" : "p-2"}`}>
        {collapsed ? (
          <div className="flex flex-col items-center gap-1">
            <div
              className="flex h-9 w-9 items-center justify-center rounded-full bg-ink text-[11px] font-semibold tracking-wide text-white"
              title={`${displayLabel}\n${user?.email || ""}`}
            >
              {initials}
            </div>
            <button
              type="button"
              onClick={logout}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-default hover:text-ink"
              title="退出登录"
            >
              <LogOut size={15} strokeWidth={1.75} />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2.5 rounded-xl px-2 py-2 hover:bg-surface-default">
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-ink text-[11px] font-semibold tracking-wide text-white">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink" title={displayLabel}>
                {displayLabel}
              </p>
              <p className="truncate text-[11px] text-ink-muted" title={user?.email || ""}>
                {user?.email || "—"}
              </p>
            </div>
            <button
              type="button"
              onClick={logout}
              className="flex-shrink-0 rounded-md p-1.5 text-ink-muted hover:bg-canvas hover:text-ink"
              title="退出登录"
            >
              <LogOut size={15} strokeWidth={1.75} />
            </button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        title="删除会话"
        description={`确定删除会话 "${deleteTarget?.title}"? 此操作不可撤销。`}
        onConfirm={() => {
          void confirmDelete();
        }}
        onCancel={() => {
          setDeleteTarget(null);
          setDeleteError(null);
        }}
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
