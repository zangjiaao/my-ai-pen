/**
 * Track worker packages that timed out or failed so the main agent cannot
 * finish_scan(completed) while discovery packages remain unfinished.
 *
 * Timeout policy: main agent may re-dispatch (narrower package / main-session probes).
 * After maxTimeoutRetries additional timeouts on the same lineage, the package is
 * escalated to failed with stage-specific adjustment advice.
 */
import type { OpenWorkerPackage, RuntimeLifecycle, WorkerOutcome } from "../types.js";

export function ensureOpenWorkerPackages(lifecycle: RuntimeLifecycle): OpenWorkerPackage[] {
  if (!lifecycle.openWorkerPackages) lifecycle.openWorkerPackages = [];
  return lifecycle.openWorkerPackages;
}

export function unresolvedWorkerPackages(lifecycle: RuntimeLifecycle | undefined): OpenWorkerPackage[] {
  if (!lifecycle?.openWorkerPackages?.length) return [];
  return lifecycle.openWorkerPackages.filter(
    (pkg) => !pkg.resolved && (pkg.outcome === "timeout" || pkg.outcome === "failed" || pkg.outcome === "aborted"),
  );
}

/** Stable fingerprint so retries map to the same open package row. */
export function packageLineageKey(role: string, task: string): string {
  const r = String(role || "general").toLowerCase().trim();
  const t = String(task || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 120);
  // Prefer path-ish tokens so rewritten retry tasks still match.
  const paths = [...t.matchAll(/\/[a-z0-9._~%+\-{}[\]/]+/gi)].map((m) => m[0]).slice(0, 6);
  const pathPart = paths.join("|") || t.slice(0, 60);
  return `${r}::${pathPart}`;
}

export function buildTimeoutFailureAdvice(input: {
  role: string;
  task: string;
  attempts: number;
  maxTimeoutRetries: number;
}): string {
  const role = String(input.role || "general");
  const task = String(input.task || "").slice(0, 200);
  const stageHints: string[] = [];
  if (/access-control|idor|authz|越权|login|登录/i.test(`${role} ${task}`)) {
    stageHints.push("先建立有效会话/凭据（注册/登录 + actor capture），再拆成单 endpoint 的 access-control 包。");
  }
  if (/xss|stored|反射|存储/i.test(`${role} ${task}`)) {
    stageHints.push("XSS 包按 endpoint 拆分；存储型若依赖 bot/外带回调，无环境时记 environment blocker（blocked/incomplete），勿当完整 impact。");
  }
  if (/injection|sqli|sql|rce|反序列/i.test(`${role} ${task}`)) {
    stageHints.push("注入/RCE 包限制为 1–2 个路径；避免一包多关卡。");
  }
  if (/captcha|验证码|mfa|2fa/i.test(task)) {
    stageHints.push("验证码/二次校验关若仍需登录态，先完成凭据发现再爆破/重放；勿仅因验证码弱点就整关 blocked。");
  }
  if (!stageHints.length) {
    stageHints.push("将 package 收窄为「单 role + 1–2 endpoint」，或在主会话用 http/browser 补探测。");
  }
  stageHints.push("可在「节点管理」提高该 Node 的 Worker 超时（秒）或最大轮次。");
  stageHints.push("若目标本身阻塞（缺凭据/缺 bot/超出 scope），用 finish_scan(incomplete) 并写清 blocker。");

  return [
    `Worker package failed after ${input.attempts} timeout(s) (max retries ${input.maxTimeoutRetries}).`,
    `Role: ${role}`,
    `Task: ${task}`,
    "Adjustment suggestions:",
    ...stageHints.map((h, i) => `${i + 1}. ${h}`),
  ].join("\n");
}

export type RecordOpenPackageResult = {
  pkg: OpenWorkerPackage;
  /** Escalated from timeout → failed because retries exhausted. */
  escalatedToFailed: boolean;
  advice?: string;
};

/**
 * Record a timeout/failed package as open backlog.
 * Timeouts on the same lineage increment attempt count; after budget, escalate to failed.
 */
export function recordOpenWorkerPackage(
  lifecycle: RuntimeLifecycle,
  input: {
    workerId: string;
    role: string;
    task: string;
    outcome: WorkerOutcome;
    maxTimeoutRetries?: number;
  },
): RecordOpenPackageResult {
  const packages = ensureOpenWorkerPackages(lifecycle);
  const lineageKey = packageLineageKey(input.role, input.task);
  const maxRetries = Number.isFinite(Number(input.maxTimeoutRetries))
    ? Math.max(0, Math.min(5, Math.floor(Number(input.maxTimeoutRetries))))
    : 2;

  // Prefer same lineage (retries rewrite workerId).
  let existing =
    packages.find((pkg) => !pkg.resolved && pkg.lineageKey && pkg.lineageKey === lineageKey) ||
    packages.find((pkg) => pkg.packageId === `open-${input.workerId}`);

  if (existing) {
    existing.workerId = input.workerId;
    existing.role = input.role;
    existing.task = input.task;
    existing.lineageKey = lineageKey;
    existing.at = new Date().toISOString();
    existing.resolved = false;
    existing.resolvedAt = undefined;
    existing.resolveNote = undefined;

    if (input.outcome === "timeout") {
      existing.timeoutAttempts = (existing.timeoutAttempts || 0) + 1;
      // attempts after first failure: retriesExhausted when attempts > 1 + maxRetries? 
      // Policy: first timeout counts as attempt 1; each timeout increments.
      // Exhausted when timeoutAttempts > maxRetries + 1 (initial + N retries).
      // Simpler: exhausted when timeoutAttempts > maxRetries (if maxRetries=2, fail on 3rd timeout)
      // User: "多次重试都不行" → allow maxRetries re-dispatches after first timeout.
      // So total timeouts allowed before fail = 1 + maxRetries.
      const limit = 1 + maxRetries;
      if (existing.timeoutAttempts >= limit) {
        existing.outcome = "failed";
        existing.retriesExhausted = true;
        existing.advice = buildTimeoutFailureAdvice({
          role: input.role,
          task: input.task,
          attempts: existing.timeoutAttempts,
          maxTimeoutRetries: maxRetries,
        });
        return { pkg: existing, escalatedToFailed: true, advice: existing.advice };
      }
      existing.outcome = "timeout";
      existing.retriesExhausted = false;
      return { pkg: existing, escalatedToFailed: false };
    }

    existing.outcome = input.outcome;
    if (input.outcome === "failed" || input.outcome === "aborted") {
      existing.retriesExhausted = true;
      existing.advice =
        existing.advice ||
        buildTimeoutFailureAdvice({
          role: input.role,
          task: input.task,
          attempts: existing.timeoutAttempts || 1,
          maxTimeoutRetries: maxRetries,
        });
    }
    return { pkg: existing, escalatedToFailed: false, advice: existing.advice };
  }

  const timeoutAttempts = input.outcome === "timeout" ? 1 : 0;
  const limit = 1 + maxRetries;
  const escalateNow = input.outcome === "timeout" && timeoutAttempts >= limit && maxRetries === 0;
  const outcome: WorkerOutcome = escalateNow ? "failed" : input.outcome;
  const advice = escalateNow
    ? buildTimeoutFailureAdvice({
        role: input.role,
        task: input.task,
        attempts: timeoutAttempts,
        maxTimeoutRetries: maxRetries,
      })
    : undefined;

  const row: OpenWorkerPackage = {
    packageId: `open-${input.workerId}`,
    workerId: input.workerId,
    role: input.role,
    task: input.task,
    outcome,
    at: new Date().toISOString(),
    resolved: false,
    timeoutAttempts,
    retriesExhausted: escalateNow || input.outcome === "failed" || input.outcome === "aborted",
    advice,
    lineageKey,
  };
  packages.push(row);
  return { pkg: row, escalatedToFailed: escalateNow, advice };
}

/**
 * Successful worker (or main-session completion of same work) clears open packages.
 * Match by role OR task/path overlap so general re-dispatch can clear access-control debt.
 */
export function resolveOpenWorkerPackagesForSuccess(
  lifecycle: RuntimeLifecycle,
  input: { role: string; task?: string; note?: string },
): { count: number; packageIds: string[] } {
  const packages = ensureOpenWorkerPackages(lifecycle);
  const role = String(input.role || "").toLowerCase();
  const taskNorm = String(input.task || "")
    .toLowerCase()
    .replace(/\s+/g, " ");
  const successLineage = packageLineageKey(input.role, input.task || "");
  const successPaths = new Set(
    [...taskNorm.matchAll(/\/[a-z0-9._~%+\-{}[\]/]+/gi)].map((m) => m[0].toLowerCase()),
  );
  const packageIds: string[] = [];
  const now = new Date().toISOString();
  for (const pkg of packages) {
    if (pkg.resolved) continue;
    const sameRole = String(pkg.role || "").toLowerCase() === role;
    const sameLineage = Boolean(pkg.lineageKey && pkg.lineageKey === successLineage);
    let pathOverlap = false;
    if (successPaths.size && pkg.task) {
      const prevPaths = [...String(pkg.task).toLowerCase().matchAll(/\/[a-z0-9._~%+\-{}[\]/]+/gi)].map(
        (m) => m[0],
      );
      pathOverlap = prevPaths.some((p) => successPaths.has(p) || [...successPaths].some((s) => s.includes(p) || p.includes(s)));
    }
    const taskOverlap =
      Boolean(taskNorm) &&
      Boolean(pkg.task) &&
      (taskNorm.includes(String(pkg.task).toLowerCase().slice(0, 24)) ||
        String(pkg.task).toLowerCase().includes(taskNorm.slice(0, 24)));

    // Resolve if same lineage, same role, or substantial path/task overlap (cross-role retry).
    if (!sameRole && !sameLineage && !pathOverlap && !taskOverlap) continue;

    pkg.resolved = true;
    pkg.resolvedAt = now;
    pkg.resolveNote = input.note || "resolved by successful worker re-dispatch";
    packageIds.push(pkg.packageId);
  }
  return { count: packageIds.length, packageIds };
}

export function assessOpenWorkerPackageGate(options: {
  engagement?: string;
  status?: string;
  openPackages: OpenWorkerPackage[];
}): { allowed: boolean; reason: string; required: boolean } {
  const engagement = String(options.engagement || "assess").toLowerCase();
  const status = String(options.status || "completed").toLowerCase();
  if (status !== "completed") {
    return { allowed: true, reason: "non-completed finish does not require open worker packages to be cleared", required: false };
  }
  if (engagement !== "assess") {
    return { allowed: true, reason: "open worker package gate applies only to assess engagement", required: false };
  }
  if (!options.openPackages.length) {
    return { allowed: true, reason: "no unresolved timeout/failed worker packages", required: false };
  }
  const sample = options.openPackages
    .slice(0, 4)
    .map((pkg) => {
      const attempts = pkg.timeoutAttempts ? ` x${pkg.timeoutAttempts}` : "";
      return `${pkg.role}/${pkg.outcome}${attempts}: ${pkg.task.slice(0, 60)}`;
    })
    .join("; ");
  const exhausted = options.openPackages.filter((p) => p.retriesExhausted);
  const adviceHint =
    exhausted.length > 0
      ? ` ${exhausted.length} package(s) exhausted retries — see plan notes for adjustment advice.`
      : " Re-dispatch narrower packages or finish probes in the main session.";
  return {
    allowed: false,
    required: true,
    reason:
      `${options.openPackages.length} worker package(s) timed out or failed and were not re-dispatched/completed: ${sample}.${adviceHint} ` +
      `Or use finish_scan(status='incomplete') if those packages cannot be finished.`,
  };
}
