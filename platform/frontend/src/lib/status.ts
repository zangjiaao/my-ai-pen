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
 * When the Case/session is not actively working, durable thinking left as
 * `status=running` (node restart mid-llm_waiting, incomplete settle) must not
 * keep showing 「思考中…」 forever.
 */
export function resolveThinkingUiStatusForSession(
  value: unknown,
  options?: { sessionActive?: boolean },
): UiExecutionStatus {
  const base = resolveThinkingUiStatus(value);
  if (options?.sessionActive === false && base === "running") return "done";
  return base;
}

/**
 * Presentational projection for ThinkingCard (Spec #305 S3 / Issue 13).
 * defaultExpanded is always true; empty body yields no fake placeholder.
 * @param options.sessionActive when false, orphan running thinking → 思考完成
 */
export function thinkingCardProjection(
  content: Record<string, unknown>,
  options?: { sessionActive?: boolean },
): {
  title: string;
  body: string;
  defaultExpanded: boolean;
  showBodyWhenExpanded: boolean;
} {
  const body = String(content.reasoning || content.text || content.summary || "").trim();
  const ui = resolveThinkingUiStatusForSession(content.status, options);
  return {
    title: ui === "running" ? "思考中…" : "思考完成",
    body,
    defaultExpanded: true,
    showBodyWhenExpanded: Boolean(body),
  };
}

/**
 * Merge thinking content.status — prefer terminal done over stale running;
 * never drop done when a late partial arrives.
 * Uses normalizeExecutionStatus so synonym lists stay single-sourced (Issue 8).
 */
export function mergeThinkingStatus(existing: unknown, incoming: unknown): string | undefined {
  const eRaw = String(existing ?? "").trim();
  const iRaw = String(incoming ?? "").trim();
  if (!eRaw && !iRaw) return undefined;
  if (eRaw && normalizeExecutionStatus(eRaw) === "done") return "done";
  if (iRaw && normalizeExecutionStatus(iRaw) === "done") return "done";
  if (iRaw) return normalizeExecutionStatus(iRaw);
  if (eRaw) return normalizeExecutionStatus(eRaw);
  return undefined;
}

/**
 * Merge tool lifecycle status for RQ / grouped tool cards (Spec #305 R2).
 * Prefer fail, then done over running; keep empty when both missing so result-hint
 * success can still apply in MessageRenderer (do not invent "running").
 */
export function mergeToolLifecycleStatus(existing: unknown, incoming: unknown): string {
  const eRaw = String(existing ?? "").trim();
  const iRaw = String(incoming ?? "").trim();
  if (!eRaw && !iRaw) return "";
  const eN = eRaw ? normalizeExecutionStatus(eRaw) : null;
  const iN = iRaw ? normalizeExecutionStatus(iRaw) : null;
  if (eN === "fail" || iN === "fail") return "fail";
  if (eN === "done" || iN === "done") return "done";
  if (iRaw) return iN === "running" ? "running" : iRaw;
  if (eRaw) return eN === "running" ? "running" : eRaw;
  return "";
}

/**
 * Tool item success for activity summary (Spec #305 S+).
 * Explicit running is never "successful" even if result payload has HTTP 200 / ok.
 * Empty/missing status may use result hints (legacy stdout rows).
 */
export function isSuccessfulToolExecution(
  status: unknown,
  resultHints?: { status?: unknown; status_code?: unknown },
): boolean {
  const primary = String(status ?? "").trim().toLowerCase();
  if (primary) {
    // HTTP codes in status field are not lifecycle status — fall through to hints.
    if (/^\d{3}$/.test(primary)) {
      // treat as non-lifecycle; use hints including this code
      if (Number(primary) < 400) return true;
      return false;
    }
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

/**
 * Pure tool activity summary kind for S5 tests / ToolCallCard (Issue 3 / 5).
 * - success family when any item is successful
 * - 执行中 when none successful and at least one is running or missing-without-success
 * - 失败 otherwise
 */
export function toolActivitySummaryKind(
  items: Array<{
    status?: unknown;
    result?: { status?: unknown; status_code?: unknown } | null;
  }>,
): "running" | "done" | "fail" {
  if (!items.length) return "running";
  const successful = items.filter((item) =>
    isSuccessfulToolExecution(item.status, {
      status: item.result?.status,
      status_code: item.result?.status_code,
    }),
  );
  if (successful.length) return "done";
  const anyRunningLike = items.some((item) => {
    const primary = String(item.status ?? "").trim();
    if (!primary) return true; // missing → still working unless success hints (already filtered)
    if (/^\d{3}$/.test(primary)) return Number(primary) >= 400; // failed codes → not running
    return normalizeExecutionStatus(primary) === "running";
  });
  return anyRunningLike ? "running" : "fail";
}

/** Chinese summary label matching ToolCallCard shell language for the aggregate kind. */
export function toolActivitySummaryLabel(
  items: Array<{
    status?: unknown;
    toolName?: string;
    result?: { status?: unknown; status_code?: unknown } | null;
  }>,
  fallbackTool = "tool",
): string {
  const kind = toolActivitySummaryKind(items);
  if (kind === "running") return "执行中";
  if (kind === "fail") return "失败";
  const successful = items.filter((item) =>
    isSuccessfulToolExecution(item.status, {
      status: item.result?.status,
      status_code: item.result?.status_code,
    }),
  );
  const toolName = successful[successful.length - 1]?.toolName || fallbackTool;
  const lower = String(toolName).toLowerCase();
  const count = successful.length || 1;
  if (/browser|explore|crawl/.test(lower)) return `已浏览${count}个网页`;
  if (/http|request|replay|fetch|curl/.test(lower)) return `已请求${count}次`;
  if (/stdin|command input|\binput\b/.test(lower)) return `已发送${count}次输入`;
  if (/execute|command|shell|docker|process/.test(lower)) return `已执行${count}条命令`;
  if (/finding|vuln|verify|evidence|confirm/.test(lower)) return `已处理${count}条结果`;
  if (/search|scan|dir|wordlist|enumerate/.test(lower)) return `已枚举${count}次`;
  return `已完成${count}次`;
}

/**
 * Resolve tool item lifecycle status string for rows (Issue 3).
 * Keep raw empty when missing so isSuccessfulToolExecution can use result hints.
 * Do not invent "done"; do not force "running" when success hints exist.
 */
export function resolveToolItemStatus(
  explicitStatus: unknown,
  resultHints?: { status?: unknown; status_code?: unknown },
): string {
  const explicit = String(explicitStatus ?? "").trim();
  if (explicit) return explicit;
  // Missing: leave empty (success via hints, or running-like via toolActivitySummaryKind).
  void resultHints;
  return "";
}
