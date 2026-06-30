import { useState } from "react";
import { Copy, Check } from "lucide-react";

interface Props {
  title?: string;
  conversationId?: string | null;
}

export default function TopBar({ title, conversationId }: Props) {
  const [copied, setCopied] = useState(false);
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
      <span className="text-xs text-ink-muted">v0.1.0</span>
    </header>
  );
}
