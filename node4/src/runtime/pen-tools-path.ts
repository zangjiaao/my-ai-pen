/**
 * First-party L2 pen-tools discovery for Node4 shell PATH.
 * Wrappers under sandbox/pen-tools/bin docker-run scanners (nuclei, nmap, …).
 * See docs/pen-tools-sandbox.md.
 *
 * Env:
 * - NODE4_PEN_TOOLS=0|false → disable PATH injection
 * - NODE4_PEN_TOOLS_BIN / PEN_TOOLS_BIN → explicit bin directory
 * - PEN_TOOLS_IMAGE → image tag for wrappers (default pen-tools:dev)
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { node4Root } from "../config.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export function isPenToolsPathEnabled(): boolean {
  const raw = (process.env.NODE4_PEN_TOOLS ?? "1").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

/**
 * Resolve directory containing nuclei/nmap host shims, or null if unavailable.
 */
export function resolvePenToolsBinDir(): string | null {
  if (!isPenToolsPathEnabled()) return null;

  const explicit = (
    process.env.NODE4_PEN_TOOLS_BIN?.trim() ||
    process.env.PEN_TOOLS_BIN?.trim() ||
    ""
  );
  if (explicit) {
    const abs = resolve(explicit);
    return dirLooksLikePenToolsBin(abs) ? abs : null;
  }

  const candidates = [
    // repo layout: node4/ → ../sandbox/pen-tools/bin
    resolve(node4Root(), "../sandbox/pen-tools/bin"),
    // when running from dist/ under node4
    resolve(HERE, "../../../sandbox/pen-tools/bin"),
    resolve(HERE, "../../../../sandbox/pen-tools/bin"),
  ];
  for (const c of candidates) {
    if (dirLooksLikePenToolsBin(c)) return c;
  }
  return null;
}

function dirLooksLikePenToolsBin(dir: string): boolean {
  try {
    return existsSync(resolve(dir, "nuclei"));
  } catch {
    return false;
  }
}

/**
 * Env for shell children: prepend pen-tools bin; default PEN_TOOLS_IMAGE if unset.
 */
export function buildShellEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const bin = resolvePenToolsBinDir();
  if (bin) {
    const prev = env.PATH || "";
    // Avoid duplicating if already first
    if (!prev.split(":").includes(bin)) {
      env.PATH = prev ? `${bin}:${prev}` : bin;
    }
  }
  if (!env.PEN_TOOLS_IMAGE?.trim()) {
    env.PEN_TOOLS_IMAGE = "pen-tools:dev";
  }
  return env;
}
