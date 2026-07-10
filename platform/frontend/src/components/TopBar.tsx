import { useState, type ReactNode } from "react";
import { Check, Copy, Download } from "lucide-react";
import { authDownload } from "../lib/api";

interface Props {
  title?: string;
  conversationId?: string | null;
  /** Extra controls on the right, before version (e.g. 注册节点). */
  actions?: ReactNode;
}

export default function TopBar({ title, conversationId, actions }: Props) {
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const shortId = conversationId ? conversationId.slice(0, 8) : "";

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

  const exportReport = async (format: "markdown" | "html") => {
    if (!conversationId) return;
    try {
      setExporting(format);
      const { blob, filename } = await authDownload(`/api/reports/conversations/${conversationId}?format=${format}`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(null);
    }
  };

  return (
    <header className="flex h-14 flex-shrink-0 items-center justify-between border-b border-hairline bg-canvas px-6">
      <div className="flex min-w-0 items-center gap-3">
        <span className="truncate text-sm font-medium">{title || "AI 安全运营平台"}</span>
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
        {conversationId && (
          <>
            <button
              type="button"
              onClick={() => void exportReport("markdown")}
              disabled={Boolean(exporting)}
              className="inline-flex items-center gap-1.5 rounded-md border border-hairline px-2.5 py-1.5 text-xs text-ink-secondary transition-colors hover:bg-surface-default hover:text-ink disabled:opacity-60"
            >
              <Download size={13} /> MD
            </button>
            <button
              type="button"
              onClick={() => void exportReport("html")}
              disabled={Boolean(exporting)}
              className="inline-flex items-center gap-1.5 rounded-md border border-hairline px-2.5 py-1.5 text-xs text-ink-secondary transition-colors hover:bg-surface-default hover:text-ink disabled:opacity-60"
            >
              <Download size={13} /> HTML
            </button>
          </>
        )}
        <span className="text-xs text-ink-muted">v0.1.0</span>
      </div>
    </header>
  );
}
