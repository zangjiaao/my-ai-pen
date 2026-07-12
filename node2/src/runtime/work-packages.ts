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

export type WorkerTaskNarrowness = {
  ok: boolean;
  endpointCount: number;
  challengeCount: number;
  surfaceGroupCount: number;
  reason?: string;
  guidance?: string;
};

/**
 * Keep worker packages narrow so wall-clock budgets are not burned on mega-packages.
 * Pure heuristic on free-text task — no target-specific challenge lists.
 *
 * Allowed: about 1–2 concrete endpoints/paths, or a single focused surface.
 * Rejected: multi-surface bundles (many paths, many "challenges", multi-level packs).
 */
export function assessWorkerTaskNarrowness(task: string): WorkerTaskNarrowness {
  const text = String(task || "").trim();
  if (!text) {
    return { ok: false, endpointCount: 0, challengeCount: 0, surfaceGroupCount: 0, reason: "empty task" };
  }

  const pathMatches = [
    ...text.matchAll(/https?:\/\/[^\s)'"<>]+/gi),
    ...text.matchAll(/\/[\w.~%+\-]+(?:\/[\w.~%+\-{}[\]]+)*/g),
  ].map((m) => normalizeEndpointToken(m[0]));
  const endpoints = uniqueStrings(pathMatches).filter((item) => item.length > 1);
  // Challenge-like unit counts (generic bilingual markers, not fixed vuln names).
  const challengeHits = [
    ...text.matchAll(/\bchallenges?\b/gi),
    ...text.matchAll(/挑战/g),
    ...text.matchAll(/\bL\d+\s*[-–—]\s*\d+\b/gi),
    ...text.matchAll(/\bflag\s*\d+\b/gi),
  ];
  const challengeCount = challengeHits.length;
  // Distinct surface groups: levelN / stageN / moduleN style prefixes in paths or free text.
  const groups = new Set<string>();
  for (const ep of endpoints) {
    const g = surfaceGroupFromEndpoint(ep);
    if (g) groups.add(g);
  }
  for (const m of text.matchAll(/\b(?:level|stage|module|round)\s*[-_]?\s*(\d+)\b/gi)) {
    groups.add(`g${m[1]}`);
  }
  for (const m of text.matchAll(/\bL(\d+)\b/g)) {
    groups.add(`g${m[1]}`);
  }
  const surfaceGroupCount = groups.size;

  const multiSurface = surfaceGroupCount >= 2 && endpoints.length >= 2;
  const tooManyEndpoints = endpoints.length > 2;
  const tooManyChallenges = challengeCount >= 3 && endpoints.length !== 1;
  const bulkWords = /全部|所有|整个|整层|全量|all\s+challenges|every\s+challenge|entire\s+level|full\s+level/i.test(text);
  const bulkWithCount = bulkWords && (endpoints.length > 1 || challengeCount >= 2 || surfaceGroupCount >= 2);

  if (tooManyEndpoints || multiSurface || tooManyChallenges || bulkWithCount) {
    return {
      ok: false,
      endpointCount: endpoints.length,
      challengeCount,
      surfaceGroupCount,
      reason:
        tooManyEndpoints
          ? `worker task references ${endpoints.length} endpoints (max 2)`
          : multiSurface
            ? `worker task spans ${surfaceGroupCount} surface groups with ${endpoints.length} endpoints`
            : tooManyChallenges
              ? `worker task packs ~${challengeCount} challenges into one package`
              : "worker task is a bulk multi-surface package",
      guidance:
        "Split into narrow packages: one role + 1–2 endpoints (or one challenge path) per worker(). " +
        "Example: separate access-control(login) from access-control(profile IDOR) and xss(stored endpoint). " +
        "On timeout, re-dispatch even narrower or finish remaining probes in the main session.",
    };
  }

  return {
    ok: true,
    endpointCount: endpoints.length,
    challengeCount,
    surfaceGroupCount,
  };
}

function normalizeEndpointToken(raw: string): string {
  let s = raw.trim();
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      s = u.pathname || s;
    }
  } catch {
    // keep raw
  }
  return s.replace(/[?#].*$/, "").replace(/\/+$/, "") || s;
}

function surfaceGroupFromEndpoint(endpoint: string): string | undefined {
  const m =
    endpoint.match(/\/(?:level|stage|module|round)[-_]?(\d+)\b/i) ||
    endpoint.match(/\/l(\d+)\b/i);
  return m ? `g${m[1]}` : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}
