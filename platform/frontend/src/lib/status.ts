export type UiExecutionStatus = "running" | "done" | "fail";

export function normalizeExecutionStatus(value: unknown): UiExecutionStatus {
  const status = String(value || "").trim().toLowerCase();
  if (["done", "ok", "success", "completed", "complete"].includes(status)) return "done";
  if (["fail", "failed", "error", "blocked", "canceled", "cancelled"].includes(status)) return "fail";
  return "running";
}