/**
 * Spec #311 — 「下一步」 Case Workset list (separate from Tasks).
 *
 * Reorder: POST /workset/reorder exists (API-only this wave). FE drag/reorder
 * controls deferred as post-wave polish (Spec US7) — discovery/sort_order only in UI.
 */
import {
  worksetFamilyLabel,
  worksetInProgressLabel,
  worksetStatusLabel,
  type WorksetItem,
  type WorksetProjection,
} from "../lib/workset";

export type WorksetNextListProps = {
  workset: WorksetProjection;
  /** Optional user actions (host-gated). */
  onAdopt?: (id: string) => void;
  onReject?: (id: string) => void;
  onDone?: (id: string) => void;
  busyId?: string | null;
};

export function WorksetNextList({
  workset,
  onAdopt,
  onReject,
  onDone,
  busyId,
}: WorksetNextListProps) {
  const items = workset.items || [];
  const goal = workset.goal;
  const residual = goal?.residual;

  if (items.length === 0 && !residual && !goal?.terminal) {
    return (
      <p className="px-2 py-1 text-[12px] text-ink-muted" data-testid="workset-empty">
        暂无下一步
      </p>
    );
  }

  return (
    <div className="space-y-1" data-testid="workset-next-list">
      {goal?.terminal ? (
        <p
          className="mb-1 px-2 text-[11px] text-ink-muted"
          data-testid="workset-goal-terminal"
        >
          Goal: {String(goal.terminal)}
          {residual?.class === "awaiting_scope_confirm"
            ? ` · 待确认主机 ${residual.pending_host_count ?? ""}`.trim()
            : ""}
        </p>
      ) : null}
      {items.map((item) => (
        <WorksetRow
          key={item.id}
          item={item}
          busy={busyId === item.id}
          onAdopt={onAdopt}
          onReject={onReject}
          onDone={onDone}
        />
      ))}
    </div>
  );
}

function WorksetRow({
  item,
  busy,
  onAdopt,
  onReject,
  onDone,
}: {
  item: WorksetItem;
  busy?: boolean;
  onAdopt?: (id: string) => void;
  onReject?: (id: string) => void;
  onDone?: (id: string) => void;
}) {
  const status = String(item.status || "proposed");
  const title = String(item.title || item.summary || item.id);
  const family = worksetFamilyLabel(String(item.family || ""));
  const annotation = item.in_progress ? worksetInProgressLabel(item) : null;

  return (
    <div
      className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-surface-muted/60"
      data-testid="workset-item"
      data-item-id={item.id}
      data-family={item.family}
      data-status={status}
      data-in-progress={item.in_progress ? "true" : "false"}
    >
      <span
        className={`mt-0.5 shrink-0 rounded px-1 py-0.5 text-[10px] font-medium ${
          item.family === "t_host"
            ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
            : "bg-sky-500/15 text-sky-700 dark:text-sky-300"
        }`}
      >
        {family}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-ink" title={title}>
          {title}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-ink-muted">
          <span>{worksetStatusLabel(status)}</span>
          {item.auto_eligible && status === "proposed" ? (
            <span className="text-status-running">可自动采纳</span>
          ) : null}
          {annotation ? (
            <span className="font-medium text-ink-secondary" data-testid="workset-in-progress-label">
              {annotation}
            </span>
          ) : null}
          {item.suggested_expert && !annotation ? (
            <span>建议 @{item.suggested_expert}</span>
          ) : null}
        </p>
      </div>
      <div className="flex shrink-0 gap-1">
        {status === "proposed" && onAdopt ? (
          <button
            type="button"
            disabled={busy}
            className="rounded px-1.5 py-0.5 text-[11px] text-ink-secondary hover:bg-surface-muted hover:text-ink disabled:opacity-50"
            onClick={() => onAdopt(item.id)}
          >
            采纳
          </button>
        ) : null}
        {status === "proposed" && onReject ? (
          <button
            type="button"
            disabled={busy}
            className="rounded px-1.5 py-0.5 text-[11px] text-ink-muted hover:bg-surface-muted hover:text-ink disabled:opacity-50"
            onClick={() => onReject(item.id)}
          >
            拒绝
          </button>
        ) : null}
        {status === "adopted" && onDone ? (
          <button
            type="button"
            disabled={busy}
            className="rounded px-1.5 py-0.5 text-[11px] text-ink-muted hover:bg-surface-muted hover:text-ink disabled:opacity-50"
            onClick={() => onDone(item.id)}
          >
            完成
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default WorksetNextList;
