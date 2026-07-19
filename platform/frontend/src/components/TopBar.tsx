import { useState, type ReactNode } from "react";
import { Check, Copy, Moon, Sun } from "lucide-react";
import ReportDrawer from "./ReportDrawer";
import { BRAND_NAME } from "../lib/brand";
import { useThemeStore } from "../stores/themeStore";

interface Props {
  title?: string;
  conversationId?: string | null;
  /** Extra controls on the right, before theme toggle (e.g. 注册节点). */
  actions?: ReactNode;
}

export default function TopBar({ title, conversationId, actions }: Props) {
  const [copied, setCopied] = useState(false);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const shortId = conversationId ? conversationId.slice(0, 8) : "";
  const isDark = theme === "dark";

  const copyConversationId = async () => {
    if (!conversationId) return;
    try {
      await navigator.clipboard.writeText(conversationId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <header className="flex h-14 flex-shrink-0 items-center justify-between border-b border-hairline bg-canvas px-6">
      <div className="flex min-w-0 items-center gap-3">
        <span className="truncate text-sm font-medium text-ink">{title || BRAND_NAME}</span>
        {conversationId && (
          <button
            type="button"
            data-testid="copy-conversation-id"
            onClick={copyConversationId}
            title={conversationId}
            className="inline-flex max-w-[220px] items-center gap-1.5 rounded-md border border-hairline bg-canvas-inset px-2 py-1 font-mono text-[11px] text-ink-secondary transition-colors hover:text-ink"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            <span className="truncate">session {shortId}</span>
          </button>
        )}
      </div>
      <div className="flex items-center gap-2">
        {actions}
        {conversationId ? <ReportDrawer conversationId={conversationId} /> : null}
        <button
          type="button"
          onClick={toggleTheme}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-canvas-inset hover:text-ink"
          title={isDark ? "切换日间模式" : "切换夜间模式"}
          aria-label={isDark ? "切换日间模式" : "切换夜间模式"}
          aria-pressed={isDark}
        >
          {isDark ? <Sun size={16} strokeWidth={1.75} /> : <Moon size={16} strokeWidth={1.75} />}
        </button>
        <span className="text-xs text-ink-muted">v0.1.0</span>
      </div>
    </header>
  );
}
