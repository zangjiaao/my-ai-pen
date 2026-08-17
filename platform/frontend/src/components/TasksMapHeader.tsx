/**
 * Spec #321 Tasks header + Spec #354: operator revision selector retired.
 * Incomplete progress value path = Session handoff, not museum browse.
 * Sealed badge / done counts remain for live map chrome only.
 */

import type { TaskMapRevision } from "../lib/taskMapHistory";
import { isLiveRevision } from "../lib/taskMapHistory";

type Props = {
  revisions: TaskMapRevision[];
  liveRevisionId: string | null;
  /** @deprecated Spec #354 — history view retired; kept for call-site compat. */
  viewedRevisionId?: string | null;
  /** done/total for the live map */
  doneCount: number;
  totalCount: number;
  hiddenCount?: number;
  /** @deprecated Spec #354 — no-op; revision select removed from workbench. */
  onSelectRevision?: (revisionId: string) => void;
  /** @deprecated Spec #354 — no-op. */
  onReturnToLive?: () => void;
};

const TASKS_MAP_HEADER_CLASS = "mb-2 space-y-1";

export function TasksMapHeaderSkeleton() {
  return (
    <div aria-hidden="true" className={TASKS_MAP_HEADER_CLASS}>
      <div className="flex h-4 items-center justify-between gap-2">
        <div className="h-3 w-12 rounded-full bg-canvas-inset" />
        <div className="h-2.5 w-8 rounded-full bg-canvas-inset" />
      </div>
    </div>
  );
}

export default function TasksMapHeader({
  revisions,
  liveRevisionId,
  doneCount,
  totalCount,
  hiddenCount = 0,
}: Props) {
  const liveSealed =
    Boolean(liveRevisionId) &&
    revisions.some((r) => r.sealed && isLiveRevision(r, liveRevisionId));

  return (
    <div className={TASKS_MAP_HEADER_CLASS} data-testid="tasks-map-header">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <p className="text-xs text-ink-muted">Tasks</p>
          {liveSealed && (
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
      {/* Spec #354 L11: no task-map-revision-select in operator workbench. */}
    </div>
  );
}
