import { useState } from "react";
import { Brain } from "lucide-react";
import { thinkingCardProjection } from "../../lib/status";
import MarkdownText from "../MarkdownText";
import { ProcessChromeRow } from "../ProcessChromeRow";

/** Thinking body density: secondary chrome + soft-break for streamed short lines (Spec #327 / #329). */
const THINKING_MARKDOWN_CLASS =
  "min-w-0 max-w-full space-y-1 py-1 text-xs leading-relaxed text-ink-muted [overflow-wrap:anywhere]";

/**
 * Thinking row — ProcessChromeRow shell; Brain leading (not status light — grill A).
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
    <ProcessChromeRow
      testId="thinking-card"
      titleTestId="thinking-card-title"
      leading={
        <span title="Thinking" className="inline-flex h-5 w-5 items-center justify-center text-ink-muted">
          <Brain size={15} />
        </span>
      }
      title={projection.title}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
    >
      {expanded && projection.showBodyWhenExpanded ? (
        <div className="space-y-0.5" data-testid="thinking-card-body">
          <MarkdownText text={projection.body} breaks className={THINKING_MARKDOWN_CLASS} />
        </div>
      ) : null}
    </ProcessChromeRow>
  );
}
