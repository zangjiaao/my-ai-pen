/**
 * Spec #354 S2 / L7 — Task package status light (display only).
 *
 * Sidebar Case row and collab AgentRow Main share this palette so lights stay in sync.
 * red = latest package error, not Case death.
 *
 * green idle · blue running · yellow wait/pause · red latest error
 */

export function packageStatusDotClass(
  status: string | undefined | null,
  working?: boolean,
): string {
  const s = String(status || "")
    .trim()
    .toLowerCase();
  // Live work-burst wins (platform workers / status=running).
  if (working === true || s === "running") {
    return "animate-pulse bg-status-running";
  }
  // In-agent phases still mean package is in flight.
  if (
    s === "tool_running" ||
    s === "llm_waiting" ||
    s === "llm_stalled" ||
    s === "working" ||
    s === "chat" ||
    s === "starting"
  ) {
    return "animate-pulse bg-status-running";
  }
  // yellow: authorize wait / Task pause / incomplete package
  if (
    s === "incomplete" ||
    s === "paused" ||
    s === "pending" ||
    s === "waiting"
  ) {
    return "bg-severity-medium";
  }
  // red: latest package error / cancel / abort
  if (
    s === "failed" ||
    s === "canceled" ||
    s === "cancelled" ||
    s === "stopped" ||
    s === "aborted" ||
    s === "interrupted" ||
    s === "timeout" ||
    s === "timed_out" ||
    s === "crashed"
  ) {
    return "bg-severity-critical";
  }
  // green: idle / completed / fresh Case
  if (
    s === "completed" ||
    s === "created" ||
    s === "done" ||
    s === "idle" ||
    s === "finished" ||
    s === "success" ||
    !s
  ) {
    return "bg-status-success";
  }
  return "bg-status-success";
}

export function packageStatusTitle(
  status: string | undefined | null,
  working?: boolean,
): string {
  const s = String(status || "")
    .trim()
    .toLowerCase();
  if (working === true || s === "running") return "运行中";
  if (
    s === "tool_running" ||
    s === "llm_waiting" ||
    s === "llm_stalled" ||
    s === "working" ||
    s === "chat" ||
    s === "starting"
  ) {
    return "运行中";
  }
  if (s === "incomplete" || s === "paused") return "等待/暂停";
  if (s === "pending" || s === "waiting") return "等待";
  if (s === "failed") return "错误";
  if (s === "canceled" || s === "cancelled" || s === "stopped" || s === "aborted") {
    return "已中止";
  }
  if (s === "completed" || s === "done" || s === "finished" || s === "success" || s === "idle") {
    return "空闲";
  }
  if (s === "created" || !s) return "空闲";
  return s || "空闲";
}

/**
 * Collapse agent/panel status strings onto package statuses for the shared light.
 * Main rows should prefer conversation package status when provided.
 */
export function resolvePackageLightStatus(input: {
  /** Conversation / Task package status (Case SOT for Sidebar + Main). */
  packageStatus?: string | null;
  /** Live agent/panel status when packageStatus not authoritative. */
  agentStatus?: string | null;
  working?: boolean;
}): string {
  if (input.working === true) return "running";
  const pkg = String(input.packageStatus || "")
    .trim()
    .toLowerCase();
  // Authoritative package terminals / running always win for Main sync.
  if (
    pkg === "running" ||
    pkg === "incomplete" ||
    pkg === "paused" ||
    pkg === "failed" ||
    pkg === "canceled" ||
    pkg === "cancelled" ||
    pkg === "completed" ||
    pkg === "created"
  ) {
    return pkg === "cancelled" ? "canceled" : pkg;
  }
  const a = String(input.agentStatus || "")
    .trim()
    .toLowerCase();
  if (
    a === "running" ||
    a === "tool_running" ||
    a === "llm_waiting" ||
    a === "llm_stalled" ||
    a === "working" ||
    a === "chat" ||
    a === "starting"
  ) {
    return "running";
  }
  if (a === "incomplete" || a === "paused" || a === "pending" || a === "waiting") {
    return a === "pending" || a === "waiting" ? "incomplete" : a;
  }
  if (
    a === "failed" ||
    a === "canceled" ||
    a === "cancelled" ||
    a === "stopped" ||
    a === "aborted" ||
    a === "interrupted" ||
    a === "timeout" ||
    a === "timed_out" ||
    a === "crashed"
  ) {
    return a === "cancelled" ? "canceled" : a === "stopped" || a === "aborted" || a === "interrupted" ? "failed" : a;
  }
  if (a === "completed" || a === "done" || a === "finished" || a === "success" || a === "idle" || !a) {
    return "completed";
  }
  return a || "completed";
}
