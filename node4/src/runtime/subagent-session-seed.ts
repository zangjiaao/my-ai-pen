/**
 * Copy parent session cookie jars into child workDir so packages need not re-login.
 */

import { access, cp, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Best-effort seed of parent `session/` into child workDir.
 * Returns true if anything was copied.
 */
export async function seedChildSessionFromParent(
  parentTaskDir: string,
  childWorkDir: string,
): Promise<{ seeded: boolean; detail: string }> {
  const src = join(parentTaskDir, "session");
  const dest = join(childWorkDir, "session");
  try {
    await access(src);
  } catch {
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
