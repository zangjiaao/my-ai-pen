/**
 * Spec #321 — RightPanel Tasks header: revision selector + history chrome.
 * Selecting history is display-only; 返回当前 restores live view.
 */

import type { TaskMapRevision } from "../lib/taskMapHistory";
import {
  isLiveRevision,
  isViewingHistory,
  revisionDisplayLabel,
} from "../lib/taskMapHistory";

type Props = {
  revisions: TaskMapRevision[];
  liveRevisionId: string | null;
  viewedRevisionId: string | null;
  /** done/total for the currently viewed map */
  doneCount: number;
  totalCount: number;
  hiddenCount?: number;
  onSelectRevision: (revisionId: string) => void;
  onReturnToLive: () => void;
};

export default function TasksMapHeader({
  revisions,
  liveRevisionId,
  viewedRevisionId,
  doneCount,
  totalCount,
  hiddenCount = 0,
  onSelectRevision,
  onReturnToLive,
}: Props) {
  const viewingHistory = isViewingHistory(viewedRevisionId, liveRevisionId);
  const showSelector = revisions.length > 1;

  return (
    <div className="mb-2 space-y-1" data-testid="tasks-map-header">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <p className="text-xs text-ink-muted">Tasks</p>
          {viewingHistory && (
            <span
              className="shrink-0 rounded-pill bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium text-ink-muted"
              data-testid="tasks-history-badge"
            >
              历史 · 只读
            </span>
          )}
          {!viewingHistory && liveRevisionId && revisions.some((r) => r.sealed && isLiveRevision(r, liveRevisionId)) && (
            <span
              className="shrink-0 rounded-pill bg-surface-muted px-1.5 py-0.5 text-[10px] text-ink-muted"
              data-testid="tasks-sealed-badge"
            >
              已完成
            </span>
          )}
        </div>
        {totalCount > 0 && (
          <p className="font-mono text-[11px] text-ink-muted" data-testid="tasks-done-total">
            {doneCount}/{totalCount + hiddenCount}
            {hiddenCount > 0 ? ` · +${hiddenCount} more` : ""}
          </p>
        )}
      </div>

      {showSelector && (
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="task-map-revision-select">
            Task map revision
          </label>
          <select
            id="task-map-revision-select"
            data-testid="task-map-revision-select"
            className="min-w-0 flex-1 rounded border border-hairline bg-canvas px-1.5 py-1 text-[11px] text-ink"
            value={viewedRevisionId || liveRevisionId || revisions[revisions.length - 1]?.id || ""}
            onChange={(e) => onSelectRevision(e.target.value)}
          >
            {revisions.map((rev) => {
              const live = isLiveRevision(rev, liveRevisionId);
              return (
                <option key={rev.id} value={rev.id}>
                  {live ? "● " : "○ "}
                  {revisionDisplayLabel(rev)}
                </option>
              );
            })}
          </select>
          {viewingHistory && (
            <button
              type="button"
              data-testid="tasks-return-live"
              className="shrink-0 rounded border border-hairline px-2 py-1 text-[11px] text-ink hover:bg-surface-muted"
              onClick={onReturnToLive}
            >
              返回当前
            </button>
          )}
        </div>
      )}
    </div>
  );
}
