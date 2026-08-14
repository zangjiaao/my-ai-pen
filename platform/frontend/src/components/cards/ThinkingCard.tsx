import { useEffect, useRef, useState } from "react";
import { Brain, ChevronDown } from "lucide-react";
import {
  PROCESS_LEADING_ICON_SIZE,
  PROCESS_LEADING_ICON_STROKE,
  PROCESS_LEADING_SLOT_CLASS,
} from "../../lib/processChromeIcon";
import {
  resolveThinkingUiStatusForSession,
  thinkingCardProjection,
  thinkingLifecycleTitle,
} from "../../lib/status";
import MarkdownText from "../MarkdownText";
import { ProcessStatusLight } from "../ProcessStatusLight";

/** Thinking body density: secondary chrome + soft-break for streamed short lines (Spec #327 / #329).
 * Width fills the rail column (min-w-0) — do not force w-full next to the left border rail.
 */
const THINKING_MARKDOWN_CLASS =
  "min-w-0 max-w-full space-y-1 py-1 text-xs leading-relaxed text-ink-muted [overflow-wrap:anywhere]";

/**
 * Thinking process chrome — sibling group to 「工具调用」:
 *
 *   【Brain|状态灯】思考中… / 思考 N 秒 ⌄
 *   -- reasoning body (left rail)
 *
 * No card bg/border; width follows content. Duration from content fields or live clock.
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
  const uiStatus = resolveThinkingUiStatusForSession(content.status, { sessionActive });
  const [expanded, setExpanded] = useState<boolean>(projection.defaultExpanded);
  const working = uiStatus === "running";

  // Live elapsed while thinking; settle to final seconds for 「思考 N 秒」.
  const startedAtRef = useRef<number | null>(null);
  const [liveSeconds, setLiveSeconds] = useState<number | null>(null);
  const stampedSeconds = readThinkingDurationSeconds(content);

  useEffect(() => {
    if (working) {
      if (startedAtRef.current == null) startedAtRef.current = Date.now();
      const tick = () => {
        const start = startedAtRef.current;
        if (start == null) return;
        setLiveSeconds(Math.max(0, Math.floor((Date.now() - start) / 1000)));
      };
      tick();
      const id = window.setInterval(tick, 1000);
      return () => window.clearInterval(id);
    }
    // Capture final duration when status settles (if not stamped on content).
    if (startedAtRef.current != null && stampedSeconds == null) {
      setLiveSeconds(Math.max(0, Math.floor((Date.now() - startedAtRef.current) / 1000)));
    }
    return undefined;
  }, [working, stampedSeconds]);

  // Empty done / orphan empty: hide (no empty thinking chrome).
  if (!projection.visible) return null;

  const durationSeconds = stampedSeconds ?? (!working ? liveSeconds : null);
  const title = thinkingLifecycleTitle(content.status, {
    sessionActive,
    durationSeconds: working ? null : durationSeconds,
  });
  // While running, title is 思考中… (shimmer); optional live seconds stay off header
  // to match reference active label.
  const showBody = expanded && projection.showBodyWhenExpanded;
  const leading = working ? (
    <ProcessStatusLight status="running" pulse testId="thinking-status-light" />
  ) : (
    <span title="Thinking" className={PROCESS_LEADING_SLOT_CLASS}>
      <Brain size={PROCESS_LEADING_ICON_SIZE} strokeWidth={PROCESS_LEADING_ICON_STROKE} />
    </span>
  );

  return (
    <div data-testid="thinking-card" className="my-1.5 w-full min-w-0 max-w-full">
      <button
        type="button"
        data-testid="thinking-card-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="-mx-1 flex h-7 w-fit max-w-full min-w-0 items-center gap-1.5 rounded-md px-1 text-left transition-colors hover:bg-canvas-inset"
      >
        <div className="flex flex-shrink-0 items-center gap-1">{leading}</div>
        <span
          data-testid="thinking-card-title"
          className={
            working
              ? "shimmer-label shrink-0 font-sans text-[13px] font-medium"
              : "shrink-0 font-sans text-[13px] font-medium text-ink-secondary"
          }
        >
          {title}
        </span>
        <ChevronDown
          size={14}
          strokeWidth={2.2}
          aria-hidden
          className={`shrink-0 text-ink-muted transition-transform duration-300 ${
            expanded ? "rotate-180" : "rotate-0"
          }`}
        />
      </button>

      <div
        className="grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]"
        style={{
          gridTemplateRows: showBody ? "1fr" : "0fr",
          opacity: showBody ? 1 : 0,
        }}
      >
        <div className="min-h-0 min-w-0 overflow-hidden">
          {projection.showBodyWhenExpanded ? (
            // Indent with padding (not margin + w-full): left rail must not push content past parent.
            <div
              className="flex min-w-0 max-w-full pl-2.5"
              data-testid="thinking-card-body"
            >
              <div
                className="w-px shrink-0 self-stretch bg-hairline"
                aria-hidden
              />
              <div className="min-w-0 flex-1 overflow-x-hidden pl-3">
                <MarkdownText text={projection.body} breaks className={THINKING_MARKDOWN_CLASS} />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Prefer stamped duration fields on thinking content when present. */
function readThinkingDurationSeconds(content: Record<string, unknown>): number | null {
  for (const key of ["thinking_seconds", "duration_seconds", "duration_s"]) {
    const n = Number(content[key]);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  const ms = Number(content.duration_ms ?? content.thinking_ms);
  if (Number.isFinite(ms) && ms >= 0) return Math.floor(ms / 1000);
  const start = Date.parse(String(content.started_at || content.startedAt || ""));
  const end = Date.parse(String(content.ended_at || content.endedAt || content.completed_at || ""));
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    return Math.floor((end - start) / 1000);
  }
  return null;
}
