import type { UiExecutionStatus } from "../lib/status";
import { PROCESS_LEADING_SLOT_CLASS } from "../lib/processChromeIcon";

/** Pulsing/solid status light for process chrome leading slot (running tools/thinking). */
export function ProcessStatusLight({
  status = "running",
  pulse = true,
  testId = "process-status-light",
}: {
  status?: UiExecutionStatus;
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
    <span className={PROCESS_LEADING_SLOT_CLASS}>
      <span
        data-testid={testId}
        data-status={status}
        data-pulse={pulse && status === "running" ? "true" : "false"}
        className={`inline-flex h-2 w-2 rounded-full ${color}${pulseClass}`}
      />
    </span>
  );
}
