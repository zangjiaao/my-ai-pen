import { useState } from "react";
import { Brain } from "lucide-react";
import { thinkingCardProjection } from "../../lib/status";

/**
 * Thinking row — same shell language as ToolCallCard (light bar, no heavy border box).
 * Spec #305: lifecycle title (思考中… / 思考完成), default expanded, no header truncation,
 * empty body allowed while running (no fake placeholder copy).
 */
export default function ThinkingCard({
  content,
  sessionActive,
}: {
  content: Record<string, unknown>;
  /** When false, orphan status=running projects as 思考完成 (idle/incomplete Case). */
  sessionActive?: boolean;
}) {
  const projection = thinkingCardProjection(content, { sessionActive });
  const [expanded, setExpanded] = useState<boolean>(projection.defaultExpanded);

  return (
    <div data-testid="thinking-card" className="my-2 min-w-0 max-w-full rounded-md bg-surface-default/70">
      <button
        type="button"
        data-testid="thinking-card-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full min-w-0 items-center gap-1.5 py-1.5 text-left transition-colors hover:bg-canvas-inset"
      >
        <div className="flex flex-shrink-0 items-center gap-1">
          <span title="Thinking" className="inline-flex h-5 w-5 items-center justify-center text-ink-muted">
            <Brain size={15} />
          </span>
        </div>
        <span
          data-testid="thinking-card-title"
          className="min-w-0 flex-shrink font-sans text-sm text-ink-secondary"
        >
          {projection.title}
        </span>
        <span className="min-w-6 flex-1" aria-hidden="true" />
      </button>
      {expanded && projection.showBodyWhenExpanded ? (
        <div className="space-y-0.5">
          <div
            data-testid="thinking-card-body"
            className="py-1 text-xs leading-relaxed text-ink-muted whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
          >
            {projection.body}
          </div>
        </div>
      ) : null}
    </div>
  );
}
