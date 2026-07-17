import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export default function ThinkingCard({ content }: { content: Record<string, unknown> }) {
  const reasoning = String(content.reasoning || content.text || content.summary || "").trim();
  // Auto-expand while content is still growing so streaming is visible.
  const [collapsed, setCollapsed] = useState(false);
  const [lastLen, setLastLen] = useState(0);

  useEffect(() => {
    if (reasoning.length > lastLen) {
      setCollapsed(false);
      setLastLen(reasoning.length);
    }
  }, [reasoning, lastLen]);

  const ToggleIcon = collapsed ? ChevronRight : ChevronDown;
  const preview = reasoning.replace(/\s+/g, " ").trim();
  const previewLine = preview.length > 72 ? `${preview.slice(0, 72)}…` : preview;

  return (
    <div className="my-2 min-w-0 max-w-full rounded-md border border-hairline bg-surface-default">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(value => !value)}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-sm text-ink-secondary transition-colors hover:bg-canvas-inset"
      >
        <ToggleIcon size={16} className="shrink-0 text-ink-muted" />
        <span className="inline-flex h-2 w-2 shrink-0 animate-pulse rounded-full bg-status-running" />
        <span className="shrink-0 font-medium">Thinking</span>
        {previewLine && (
          <span className="min-w-0 flex-1 truncate text-xs text-ink-muted">{previewLine}</span>
        )}
      </button>
      {!collapsed && (
        <div className="border-t border-hairline px-3 py-2 text-sm leading-relaxed text-ink-secondary whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          {reasoning || "No reasoning content provided."}
        </div>
      )}
    </div>
  );
}
