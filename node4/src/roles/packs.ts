/**
 * Role pack registry — definitions live under repo `experts/`; this module loads them.
 * Node install root gates which packs may run (default effective: pentest only).
 */
import { join } from "node:path";
import {
  buildAliasMap,
  effectiveInstalledPackIds,
  expertsCatalogRoot,
  loadCatalogIndexSync,
  loadInstalledPack,
  loadPackFromDirSync,
  catalogPackDir,
  type LoadedPack,
} from "../experts/index.js";
import { dirHasPackSync } from "../experts/load-pack.js";
import type { RolePack } from "./types.js";

const extra = new Map<string, RolePack>();

function catalogPack(id: string): LoadedPack | undefined {
  try {
    return loadPackFromDirSync(catalogPackDir(id));
  } catch {
    return undefined;
  }
}

/** Named packs for tests/smokes (always from catalog content, not install gate). */
export const PENTEST_ROLE_PACK: RolePack = (() => {
  const p = catalogPack("pentest");
  if (!p) throw new Error("experts/pentest missing — catalog required");
  return p;
})();

export const CTF_ROLE_PACK: RolePack = (() => {
  const p = catalogPack("ctf");
  if (!p) throw new Error("experts/ctf missing — catalog required");
  return p;
})();

export const CONSULT_STUB_ROLE_PACK: RolePack = (() => {
  const p = catalogPack("consult");
  if (!p) throw new Error("experts/consult missing — catalog required");
  return p;
})();

export function registerRolePack(pack: RolePack): void {
  extra.set(pack.id.toLowerCase(), pack);
}

export function clearExtraRolePacks(): void {
  extra.clear();
}

export function listRolePackIds(): string[] {
  const fromCatalog = loadCatalogIndexSync(expertsCatalogRoot()).map((p) => p.id);
  return [...new Set([...fromCatalog, ...extra.keys()])];
}

/**
 * Get pack definition by id/alias.
 * Prefer installed copy; default empty-install loads pentest from catalog;
 * other packs require install (or extra registration).
 */
export function getRolePackById(id: string): RolePack | undefined {
  const key = id.toLowerCase().trim();
  if (!key) return undefined;
  if (extra.has(key)) return extra.get(key);

  const aliases = buildAliasMap();
  const canonical = aliases.get(key) || key;

  const installed = loadInstalledPack(canonical);
  if (installed) return installed;

  // Not in effective install — still allow catalog load only for listing extras
  // Resolve gate uses isPackInstalled / resolveRolePack.
  return undefined;
}

/** True if pack may be selected for a task on this node. */
export function isPackInstalled(idOrAlias: string): boolean {
  const key = idOrAlias.toLowerCase().trim();
  if (extra.has(key)) return true;
  const aliases = buildAliasMap();
  const canonical = aliases.get(key) || key;
  return effectiveInstalledPackIds().includes(canonical);
}

/** Load pack for resolve: installed (or default pentest) only. */
export function getRunnablePack(idOrAlias: string): RolePack | undefined {
  const key = idOrAlias.toLowerCase().trim();
  if (extra.has(key)) return extra.get(key);
  const aliases = buildAliasMap();
  const canonical = aliases.get(key) || key;
  if (!effectiveInstalledPackIds().includes(canonical)) return undefined;
  return loadInstalledPack(canonical) || undefined;
}

export function skillsRootForPack(pack: RolePack): string | undefined {
  const loaded = pack as LoadedPack;
  if (loaded.skillsRoot) return loaded.skillsRoot;
  // Fallback: catalog path
  const dir = catalogPackDir(pack.id);
  if (dirHasPackSync(dir)) return join(dir, "skills");
  return undefined;
}
