export type UiExecutionStatus = "running" | "done" | "fail";

export function normalizeExecutionStatus(value: unknown): UiExecutionStatus {
  const status = String(value || "").trim().toLowerCase();
  if (["done", "ok", "success", "completed", "complete", "saved", "loaded"].includes(status)) return "done";
  if (["fail", "failed", "error", "blocked", "canceled", "cancelled"].includes(status)) return "fail";
  return "running";
}

/**
 * Thinking lifecycle for ThinkingCard (Spec #305).
 * Missing / historical status → treat as done (reload-safe).
 * Explicit protocol values go through normalizeExecutionStatus.
 */
export function resolveThinkingUiStatus(value: unknown): UiExecutionStatus {
  if (value == null || String(value).trim() === "") return "done";
  return normalizeExecutionStatus(value);
}

/** Title copy B: lifecycle string only — 思考中… / 思考完成. */
export function thinkingLifecycleTitle(value: unknown): string {
  return resolveThinkingUiStatus(value) === "running" ? "思考中…" : "思考完成";
}

/**
 * Merge thinking content.status — prefer terminal done over stale running;
 * never drop done when a late partial arrives.
 */
export function mergeThinkingStatus(existing: unknown, incoming: unknown): string | undefined {
  const e = String(existing ?? "").trim().toLowerCase();
  const i = String(incoming ?? "").trim().toLowerCase();
  const isDone = (s: string) =>
    ["done", "ok", "success", "completed", "complete", "saved", "loaded"].includes(s);
  if (isDone(e) || isDone(i)) return "done";
  if (i) return normalizeExecutionStatus(i);
  if (e) return normalizeExecutionStatus(e);
  return undefined;
}

/**
 * Tool item success for activity summary (Spec #305 S+).
 * Explicit running is never "successful" even if result payload has HTTP 200 / ok.
 */
export function isSuccessfulToolExecution(
  status: unknown,
  resultHints?: { status?: unknown; status_code?: unknown },
): boolean {
  const primary = String(status ?? "").trim().toLowerCase();
  if (primary) {
    if (normalizeExecutionStatus(primary) === "running") return false;
    if (normalizeExecutionStatus(primary) === "done") return true;
    if (normalizeExecutionStatus(primary) === "fail") return false;
  }
  const hints = [resultHints?.status, resultHints?.status_code];
  for (const hint of hints) {
    const s = String(hint ?? "").trim().toLowerCase();
    if (!s) continue;
    if (["done", "ok", "success", "completed", "complete", "saved", "loaded"].includes(s)) return true;
    if (/^\d{3}$/.test(s) && Number(s) < 400) return true;
  }
  return false;
}
