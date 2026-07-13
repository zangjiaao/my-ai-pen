/**
 * Install / uninstall expert packs onto this Node from the shared catalog.
 * Install = copy catalog → install root. Uninstall = remove install copy only.
 */
import {
  cpSync,
  rmSync,
  mkdirSync,
  readdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
  accessSync,
} from "node:fs";
import { join } from "node:path";
import {
  catalogPackDir,
  expertsCatalogRoot,
  expertsInstallRoot,
  installPackDir,
} from "./paths.js";
import {
  dirHasPackSync,
  loadCatalogIndexSync,
  loadPackFromDirSync,
  type LoadedPack,
} from "./load-pack.js";

export const DEFAULT_OFFER = "pentest";

export type InstallResult = {
  ok: boolean;
  action: "install" | "uninstall" | "list";
  packId?: string;
  installed: string[];
  message?: string;
};

function ensureInstallRoot(): string {
  const root = expertsInstallRoot();
  mkdirSync(root, { recursive: true });
  return root;
}

/** Pack ids physically present under the install root. */
export function listInstalledPackIds(): string[] {
  const root = expertsInstallRoot();
  if (!existsSync(root)) return [];
  const ids: string[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    if (dirHasPackSync(join(root, e.name))) ids.push(e.name.toLowerCase());
  }
  return ids.sort();
}

/**
 * Effective installed set for resolve.
 * Empty install root → default [pentest] only (content loaded from catalog).
 */
export function effectiveInstalledPackIds(): string[] {
  const installed = listInstalledPackIds();
  if (installed.length === 0) return [DEFAULT_OFFER];
  return installed;
}

/** Prefer install copy; if nothing installed, default pentest from catalog. */
export function resolvePackDir(packId: string): string | null {
  const id = packId.toLowerCase().trim();
  const installDir = installPackDir(id);
  if (dirHasPackSync(installDir)) return installDir;

  const installed = listInstalledPackIds();
  if (installed.length === 0 && id === DEFAULT_OFFER) {
    const cat = catalogPackDir(id);
    if (dirHasPackSync(cat)) return cat;
  }
  return null;
}

export function loadInstalledPack(packId: string): LoadedPack | null {
  const dir = resolvePackDir(packId);
  if (!dir) return null;
  try {
    return loadPackFromDirSync(dir);
  } catch {
    return null;
  }
}

function copyPackFromCatalog(id: string, catalog: string): void {
  const src = catalogPackDir(id);
  const dest = installPackDir(id);
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
  writeFileSync(
    join(dest, ".installed.json"),
    JSON.stringify(
      {
        packId: id,
        installedAt: new Date().toISOString(),
        catalogRoot: catalog,
        source: src,
      },
      null,
      2,
    ),
    "utf8",
  );
}

/**
 * Install a catalog pack into the node install root.
 * Aligns with platform offers (additive): installing a non-default pack also
 * seeds **pentest** if it is not already installed, so blank engagement still works.
 */
export function installExpert(packId: string): InstallResult {
  const id = packId.toLowerCase().trim();
  const catalog = expertsCatalogRoot();
  const src = catalogPackDir(id);
  if (!dirHasPackSync(src)) {
    const known = loadCatalogIndexSync(catalog).map((p) => p.id);
    return {
      ok: false,
      action: "install",
      packId: id,
      installed: listInstalledPackIds(),
      message: `Unknown expert pack '${id}'. Catalog packs: ${known.join(", ") || "(empty)"}`,
    };
  }
  const root = ensureInstallRoot();
  copyPackFromCatalog(id, catalog);
  // Platform install_offer is additive and keeps default pentest; mirror that here.
  if (id !== DEFAULT_OFFER && !listInstalledPackIds().includes(DEFAULT_OFFER)) {
    if (dirHasPackSync(catalogPackDir(DEFAULT_OFFER))) {
      copyPackFromCatalog(DEFAULT_OFFER, catalog);
    }
  }
  return {
    ok: true,
    action: "install",
    packId: id,
    installed: listInstalledPackIds(),
    message: `Installed '${id}' into ${root}`,
  };
}

export function uninstallExpert(packId: string): InstallResult {
  const id = packId.toLowerCase().trim();
  const dest = installPackDir(id);
  if (!dirHasPackSync(dest)) {
    return {
      ok: true,
      action: "uninstall",
      packId: id,
      installed: listInstalledPackIds(),
      message: `Pack '${id}' was not installed`,
    };
  }
  rmSync(dest, { recursive: true, force: true });
  return {
    ok: true,
    action: "uninstall",
    packId: id,
    installed: listInstalledPackIds(),
    message: `Uninstalled '${id}' from node install root (catalog unchanged)`,
  };
}

export function listExpertsStatus(): {
  catalogRoot: string;
  installRoot: string;
  catalog: string[];
  installed: string[];
  effective: string[];
} {
  const catalogRoot = expertsCatalogRoot();
  const installRoot = expertsInstallRoot();
  const catalog = loadCatalogIndexSync(catalogRoot).map((p) => p.id);
  const installed = listInstalledPackIds();
  const effective = effectiveInstalledPackIds();
  return { catalogRoot, installRoot, catalog, installed, effective };
}

export function buildAliasMap(): Map<string, string> {
  const map = new Map<string, string>();
  const catalogRoot = expertsCatalogRoot();
  for (const e of loadCatalogIndexSync(catalogRoot)) {
    map.set(e.id, e.id);
    for (const a of e.aliases) map.set(a, e.id);
    try {
      const pack = loadPackFromDirSync(catalogPackDir(e.id));
      map.set(pack.id, pack.id);
      for (const a of pack.aliases) map.set(a, pack.id);
    } catch {
      /* skip */
    }
  }
  return map;
}

export function normalizeToPackId(value: string): string | null {
  const key = value.toLowerCase().trim();
  if (!key) return null;
  return buildAliasMap().get(key) || null;
}

export function readInstallStamp(packId: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(join(installPackDir(packId), ".installed.json"), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function packExistsInCatalog(packId: string): boolean {
  return dirHasPackSync(catalogPackDir(packId));
}
