/**
 * Session jar sharing between parent task and child subagent workDirs.
 * - seed: parent → child (legacy sibling dirs; avoid re-login)
 * - promote: child → parent (legacy sibling dirs)
 * When the child pi-* sits under the expert jar root, session tools write
 * live jars there — seed/promote are no-ops so a start-of-package snapshot
 * cannot overwrite cookies written during the package.
 */

import { access, cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/** Child pi-* under the expert jar root writes live session/ there — do not snapshot-copy. */
export function childSharesParentSessionTree(parentJarRoot: string, childWorkDir: string): boolean {
  const parent = resolve(String(parentJarRoot || "").trim() || ".");
  const child = resolve(String(childWorkDir || "").trim() || ".");
  return parent === child || child.startsWith(parent + sep);
}

async function dirExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort seed of parent `session/` into child workDir.
 */
export async function seedChildSessionFromParent(
  parentTaskDir: string,
  childWorkDir: string,
): Promise<{ seeded: boolean; detail: string }> {
  if (childSharesParentSessionTree(parentTaskDir, childWorkDir)) {
    const live = join(parentTaskDir, "session");
    if (await dirExists(live) && (await sessionTreeHasCookies(live))) {
      return { seeded: true, detail: "shared live session dir" };
    }
    return { seeded: false, detail: "shared session dir; no cookies yet" };
  }
  const src = join(parentTaskDir, "session");
  const dest = join(childWorkDir, "session");
  if (!(await dirExists(src))) {
    return { seeded: false, detail: "parent has no session/ directory" };
  }
  try {
    await mkdir(childWorkDir, { recursive: true });
    await cp(src, dest, { recursive: true, force: true });
    return { seeded: true, detail: `copied ${src} → ${dest}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { seeded: false, detail: `seed failed: ${msg}` };
  }
}

/**
 * Promote child session jars back to parent after a package runs.
 * Useful always; required under lab Graph hard when Main has no session tools
 * (only children create cookies — without promote, every package re-logins).
 *
 * Merge strategy: copy child session tree onto parent (child cookies win on conflict).
 * No-op if child has no session/ or no cookie files.
 */
export async function promoteChildSessionToParent(
  childWorkDir: string,
  parentTaskDir: string,
): Promise<{ promoted: boolean; detail: string }> {
  if (childSharesParentSessionTree(parentTaskDir, childWorkDir)) {
    return { promoted: false, detail: "shared live session dir; no snapshot promote" };
  }
  const src = join(childWorkDir, "session");
  const dest = join(parentTaskDir, "session");
  if (!(await dirExists(src))) {
    return { promoted: false, detail: "child has no session/ directory" };
  }
  // Require at least one cookies.json somewhere under session/
  const hasCookies = await sessionTreeHasCookies(src);
  if (!hasCookies) {
    return { promoted: false, detail: "child session/ has no cookies.json" };
  }
  try {
    await mkdir(parentTaskDir, { recursive: true });
    await cp(src, dest, { recursive: true, force: true });
    return { promoted: true, detail: `promoted ${src} → ${dest}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { promoted: false, detail: `promote failed: ${msg}` };
  }
}

async function sessionTreeHasCookies(sessionDir: string): Promise<boolean> {
  try {
    const top = join(sessionDir, "cookies.json");
    await access(top);
    const raw = await readFile(top, "utf8");
    if (raw.trim().length > 2) return true;
  } catch {
    /* try actors */
  }
  try {
    const actors = join(sessionDir, "actors");
    const names = await readdir(actors);
    for (const name of names) {
      try {
        const raw = await readFile(join(actors, name, "cookies.json"), "utf8");
        if (raw.trim().length > 2) return true;
      } catch {
        /* next */
      }
    }
  } catch {
    /* no actors */
  }
  return false;
}

/** Test helper: write a minimal parent jar. */
export async function writeMinimalJar(taskDir: string, cookies: Record<string, string>): Promise<void> {
  const dir = join(taskDir, "session");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "cookies.json"), JSON.stringify(cookies), "utf8");
}
