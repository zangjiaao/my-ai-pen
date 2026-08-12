/**
 * Mid-run user_steer delivery chrome (optimistic FE only — not protocol ack).
 *
 * When Case is running, FE sends user_steer; pi injects after the current tool
 * batch. Mark optimistic user rows so the timeline is honest that the message
 * is queued, not ignored. Cleared when Agent emits non-empty progressive body.
 *
 * Not persisted: reload mid-steer drops the hint (text remains in Case after
 * platform user_steer save). Coarse clear on any progressive body is intentional
 * UX soft-signal, not delivery confirmation.
 */

/** Optimistic content.delivery value while Node has not yet consumed the steer. */
export const STEER_DELIVERY_QUEUED = "queued" as const;

/**
 * Approved product copy for mid-run queue hint (MessageRenderer).
 * Keep single-sourced — do not inline in JSX.
 */
export const STEER_QUEUED_HINT =
  "已加入队列，Agent 完成当前步骤后会处理";

export type SteerDeliveryMessageRecord = {
  role?: unknown;
  msg_type?: unknown;
  content?: unknown;
  [key: string]: unknown;
};

export type SteerDeliveryPages = {
  pages: SteerDeliveryMessageRecord[][];
  pageParams?: unknown[];
};

/** True when content.delivery is the mid-run queue marker. */
export function isSteerDeliveryQueued(content: Record<string, unknown> | null | undefined): boolean {
  return String(content?.delivery || "").trim() === STEER_DELIVERY_QUEUED;
}

/**
 * Strip delivery=queued from all user text rows (immutable pages map).
 * Pure — safe for RQ setQueryData updaters.
 */
export function clearQueuedSteerDeliveryPages<T extends SteerDeliveryPages>(data: T): T {
  if (!data?.pages?.length) return data;
  let changed = false;
  const pages = data.pages.map((page) =>
    page.map((record) => {
      if (String(record.role || "") !== "user") return record;
      if (String(record.msg_type || "text") !== "text") return record;
      const content =
        record.content && typeof record.content === "object" && !Array.isArray(record.content)
          ? (record.content as Record<string, unknown>)
          : null;
      if (!content || !isSteerDeliveryQueued(content)) return record;
      changed = true;
      const next = { ...content };
      delete next.delivery;
      return { ...record, content: next };
    }),
  );
  return changed ? { ...data, pages } : data;
}
