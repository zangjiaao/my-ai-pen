import { useState } from "react";
import { Brain } from "lucide-react";

/**
 * Thinking row — same shell language as ToolCallCard (light bar, no heavy border box)
 * so the timeline stays visually aligned. Collapsed by default; open to read full reasoning.
 */
export default function ThinkingCard({ content }: { content: Record<string, unknown> }) {
  const reasoning = String(content.reasoning || content.text || content.summary || "").trim();
  const [expanded, setExpanded] = useState(false);

  const preview = reasoning.replace(/\s+/g, " ").trim();
  const previewLine = preview.length > 96 ? `${preview.slice(0, 96)}…` : preview;

  return (
    <div data-testid="thinking-card" className="my-2 min-w-0 max-w-full rounded-md bg-surface-default/70">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full min-w-0 items-center gap-1.5 py-1.5 text-left transition-colors hover:bg-canvas-inset"
      >
        <div className="flex flex-shrink-0 items-center gap-1">
          <span title="Thinking" className="inline-flex h-5 w-5 items-center justify-center text-ink-muted">
            <Brain size={15} />
          </span>
        </div>
        <span className="min-w-0 max-w-[34%] flex-shrink truncate font-sans text-sm text-ink-secondary">
          思考
        </span>
        {previewLine ? (
          <span className="min-w-0 truncate text-xs text-ink-muted">{previewLine}</span>
        ) : (
          <span className="min-w-0 truncate text-xs text-ink-muted">…</span>
        )}
        <span className="min-w-6 flex-1" aria-hidden="true" />
      </button>
      {expanded && (
        <div className="space-y-0.5 pb-1 pl-2">
          <div className="py-1 text-xs leading-relaxed text-ink-muted whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            {reasoning || "暂无思考内容"}
          </div>
        </div>
      )}
    </div>
  );
}
