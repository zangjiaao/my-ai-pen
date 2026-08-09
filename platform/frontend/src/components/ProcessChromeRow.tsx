import type { ReactNode } from "react";
import type { UiExecutionStatus } from "../lib/status";

/**
 * Shared process chrome shell for Pending / Tool / Thinking main rows.
 * Layout only — lifecycle identity stays in each projector (Spec grill: shell unified, semantics tripartite).
 */
export type ProcessChromeRowProps = {
  /** Leading slot: status light, Brain icon, etc. */
  leading: ReactNode;
  title: ReactNode;
  /** Secondary text (e.g. tool 执行中 / 已完成摘要). */
  summary?: ReactNode;
  /** When set, main row is a button for expand/collapse. */
  expanded?: boolean;
  onToggle?: () => void;
  /** test id for the outer card. */
  testId?: string;
  /** test id for the title span. */
  titleTestId?: string;
  children?: ReactNode;
};

export function ProcessChromeRow({
  leading,
  title,
  summary,
  expanded,
  onToggle,
  testId,
  titleTestId,
  children,
}: ProcessChromeRowProps) {
  const interactive = typeof onToggle === "function";
  const rowClass =
    "flex w-full min-w-0 items-center gap-1.5 py-1.5 text-left" +
    (interactive ? " transition-colors hover:bg-canvas-inset" : "");

  const rowInner = (
    <>
      <div className="flex flex-shrink-0 items-center gap-1">{leading}</div>
      <span
        data-testid={titleTestId}
        className={
          summary != null && summary !== ""
            ? "min-w-0 max-w-[34%] flex-shrink truncate font-sans text-sm text-ink-secondary"
            : "min-w-0 flex-shrink truncate font-sans text-sm text-ink-secondary"
        }
      >
        {title}
      </span>
      {summary != null && summary !== "" ? (
        <span className="min-w-0 truncate text-xs text-ink-secondary">{summary}</span>
      ) : null}
      <span className="min-w-6 flex-1" aria-hidden="true" />
    </>
  );

  return (
    <div data-testid={testId} className="my-2 min-w-0 max-w-full rounded-md bg-surface-default/70">
      {interactive ? (
        <button
          type="button"
          data-testid={testId ? `${testId}-toggle` : undefined}
          aria-expanded={Boolean(expanded)}
          onClick={onToggle}
          className={rowClass}
        >
          {rowInner}
        </button>
      ) : (
        <div className={rowClass}>{rowInner}</div>
      )}
      {children}
    </div>
  );
}

/** Status light in the leading slot (Pending / Tool main row). */
export function ProcessStatusLight({
  status,
  pulse,
  testId = "process-status-light",
}: {
  status: UiExecutionStatus;
  /** Pulse only while actively running (not orphan-projected done). */
  pulse?: boolean;
  testId?: string;
}) {
  const color =
    status === "running"
      ? "bg-status-running"
      : status === "fail"
        ? "bg-status-error"
        : "bg-status-success";
  const pulseClass = pulse && status === "running" ? " animate-pulse" : "";
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center text-ink-muted">
      <span
        data-testid={testId}
        data-status={status}
        data-pulse={pulse && status === "running" ? "true" : "false"}
        className={`inline-flex h-2 w-2 rounded-full ${color}${pulseClass}`}
      />
    </span>
  );
}
