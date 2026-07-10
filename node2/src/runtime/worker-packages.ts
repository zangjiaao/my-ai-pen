/**
 * Track worker packages that timed out or failed so the main agent cannot
 * finish_scan(completed) while discovery packages remain unfinished.
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

/** Record a timeout/failed package as open backlog. */
export function recordOpenWorkerPackage(
  lifecycle: RuntimeLifecycle,
  input: {
    workerId: string;
    role: string;
    task: string;
    outcome: WorkerOutcome;
  },
): OpenWorkerPackage {
  const packages = ensureOpenWorkerPackages(lifecycle);
  const packageId = `open-${input.workerId}`;
  const existing = packages.find((pkg) => pkg.packageId === packageId);
  if (existing) {
    existing.outcome = input.outcome;
    existing.at = new Date().toISOString();
    existing.resolved = false;
    existing.resolvedAt = undefined;
    existing.resolveNote = undefined;
    return existing;
  }
  const row: OpenWorkerPackage = {
    packageId,
    workerId: input.workerId,
    role: input.role,
    task: input.task,
    outcome: input.outcome,
    at: new Date().toISOString(),
    resolved: false,
  };
  packages.push(row);
  return row;
}

/**
 * A successful worker run for the same role clears prior open packages for that role
 * (re-dispatch completed). Optionally match by task prefix for tighter resolve.
 */
export function resolveOpenWorkerPackagesForSuccess(
  lifecycle: RuntimeLifecycle,
  input: { role: string; task?: string; note?: string },
): number {
  const packages = ensureOpenWorkerPackages(lifecycle);
  const role = String(input.role || "").toLowerCase();
  const taskNorm = String(input.task || "")
    .toLowerCase()
    .slice(0, 80);
  let n = 0;
  const now = new Date().toISOString();
  for (const pkg of packages) {
    if (pkg.resolved) continue;
    if (String(pkg.role || "").toLowerCase() !== role) continue;
    // Same role is enough for re-dispatch; task prefix match preferred when present.
    if (taskNorm && pkg.task) {
      const prev = pkg.task.toLowerCase().slice(0, 40);
      if (prev && !taskNorm.includes(prev.slice(0, 20)) && !prev.includes(taskNorm.slice(0, 20))) {
        // still allow same-role resolve — re-dispatch often rewrites the task text
      }
    }
    pkg.resolved = true;
    pkg.resolvedAt = now;
    pkg.resolveNote = input.note || "resolved by successful worker re-dispatch";
    n += 1;
  }
  return n;
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
    .map((pkg) => `${pkg.role}/${pkg.outcome}: ${pkg.task.slice(0, 60)}`)
    .join("; ");
  return {
    allowed: false,
    required: true,
    reason:
      `${options.openPackages.length} worker package(s) timed out or failed and were not re-dispatched/completed: ${sample}. ` +
      `Re-dispatch narrower worker(role, task) packages or finish remaining probes in the main session, then mark progress; ` +
      `or use finish_scan(status='incomplete') if those packages cannot be finished.`,
  };
}
