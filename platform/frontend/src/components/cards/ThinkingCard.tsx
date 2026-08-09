import { useState } from "react";
import { Brain } from "lucide-react";
import {
  PROCESS_LEADING_ICON_SIZE,
  PROCESS_LEADING_ICON_STROKE,
  PROCESS_LEADING_SLOT_CLASS,
} from "../../lib/processChromeIcon";
import { thinkingCardProjection } from "../../lib/status";
import MarkdownText from "../MarkdownText";

/** Thinking body density: secondary chrome + soft-break for streamed short lines (Spec #327 / #329). */
const THINKING_MARKDOWN_CLASS =
  "min-w-0 max-w-full space-y-1 py-1 text-xs leading-relaxed text-ink-muted [overflow-wrap:anywhere]";

/**
 * Thinking row — same shell language as ToolCallCard (light bar, no heavy border box).
 * Spec #305: lifecycle title (思考中… / 思考完成), default expanded, no header truncation,
 * empty body allowed while running (no fake placeholder copy).
 * Spec #329: body uses shared dialog Markdown renderer with soft-break + muted density.
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
          <span title="Thinking" className={PROCESS_LEADING_SLOT_CLASS}>
            <Brain size={PROCESS_LEADING_ICON_SIZE} strokeWidth={PROCESS_LEADING_ICON_STROKE} />
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
        <div className="space-y-0.5" data-testid="thinking-card-body">
          <MarkdownText text={projection.body} breaks className={THINKING_MARKDOWN_CLASS} />
        </div>
      ) : null}
    </div>
  );
}
