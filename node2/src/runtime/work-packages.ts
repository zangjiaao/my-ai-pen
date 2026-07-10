/**
 * Structured work packages from workflow briefs and assess worker-dispatch gates.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type WorkPackage = {
  id: string;
  role: string;
  task: string;
  priority?: number;
};

export type WorkerRunRecord = {
  workerId: string;
  role: string;
  task: string;
  ok: boolean;
  at: string;
};

/**
 * Parse workPackages from a control object (workflow stage control.json).
 */
export function parseWorkPackagesFromControl(control: unknown): WorkPackage[] {
  if (!control || typeof control !== "object" || Array.isArray(control)) return [];
  const raw = (control as Record<string, unknown>).workPackages;
  if (!Array.isArray(raw)) return [];
  const out: WorkPackage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const task = String(row.task || row.prompt || row.description || "").trim();
    if (!task) continue;
    const id = String(row.id || row.packageId || `wp-${out.length + 1}`).trim();
    const role = String(row.role || row.workerRole || "general").trim() || "general";
    const priority = Number(row.priority);
    out.push({
      id,
      role,
      task,
      priority: Number.isFinite(priority) ? priority : undefined,
    });
  }
  return out;
}

/** Load workPackages from any control.json under taskDir/.pi/workflows. */
export async function loadWorkPackagesFromTaskDir(taskDir: string): Promise<WorkPackage[]> {
  const workflowsRoot = join(taskDir, ".pi", "workflows");
  const packages: WorkPackage[] = [];
  const seen = new Set<string>();
  await walkFiles(workflowsRoot, async (path) => {
    if (!path.endsWith(`${sep}control.json`) && !path.endsWith("/control.json") && !path.endsWith("\\control.json")) {
      if (!/control\.json$/i.test(path)) return;
    }
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw);
      for (const pkg of parseWorkPackagesFromControl(parsed)) {
        const key = `${pkg.role}|${pkg.id}|${pkg.task.slice(0, 80)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        packages.push(pkg);
      }
    } catch {
      // ignore
    }
  });
  return packages;
}

const sep = "/";

async function walkFiles(root: string, visit: (path: string) => Promise<void>): Promise<void> {
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(root, name);
    // readdir without withFileTypes for simplicity - try as dir then file
    try {
      await walkFiles(path, visit);
    } catch {
      // not a dir
    }
    if (name === "control.json") await visit(path);
  }
}

/**
 * Assess completion gate: packages from brief must not be ignored (zero workers).
 * Incomplete/blocked finish always allowed.
 */
export function assessWorkerDispatchGate(options: {
  engagement?: string;
  packages: WorkPackage[];
  workerRunCount: number;
  status?: string;
}): { allowed: boolean; reason: string; required: boolean } {
  const engagement = String(options.engagement || "assess").toLowerCase();
  const status = String(options.status || "completed").toLowerCase();
  if (status !== "completed") {
    return { allowed: true, reason: "non-completed finish does not require worker dispatch", required: false };
  }
  if (engagement !== "assess") {
    return { allowed: true, reason: "worker package gate applies only to assess engagement", required: false };
  }
  if (!options.packages.length) {
    return { allowed: true, reason: "no structured workPackages on the runtime path", required: false };
  }
  if (options.workerRunCount > 0) {
    return {
      allowed: true,
      reason: `${options.workerRunCount} worker run(s) recorded for ${options.packages.length} package(s)`,
      required: true,
    };
  }
  return {
    allowed: false,
    required: true,
    reason:
      `${options.packages.length} workPackage(s) were produced by the workflow brief but zero worker runs were recorded. ` +
      `Dispatch worker(role, task) for packages such as ${options.packages
        .slice(0, 3)
        .map((pkg) => `${pkg.id}/${pkg.role}`)
        .join(", ")} before finish_scan(completed), or use status=incomplete.`,
  };
}

/** Pure auto-dispatch plan: map packages to worker(role,task) calls (caller executes). */
export function planWorkerAutoDispatch(packages: WorkPackage[]): Array<{ role: string; task: string; packageId: string }> {
  return packages
    .slice()
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.id.localeCompare(b.id))
    .map((pkg) => ({
      packageId: pkg.id,
      role: pkg.role || "general",
      task: `[${pkg.id}] ${pkg.task}`,
    }));
}
