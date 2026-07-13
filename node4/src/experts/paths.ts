/**
 * Paths for the shared experts catalog and this node's installed packs.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { node4Root } from "../config.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repo-level experts/ catalog (source of pack content). */
export function expertsCatalogRoot(): string {
  if (process.env.NODE4_EXPERTS_CATALOG?.trim()) {
    return resolve(process.env.NODE4_EXPERTS_CATALOG.trim());
  }
  // node4/src/experts → node4 → repo root → experts
  const fromSrc = resolve(HERE, "../../../experts");
  if (existsSync(fromSrc)) return fromSrc;
  const fromNode4 = resolve(node4Root(), "../experts");
  if (existsSync(fromNode4)) return fromNode4;
  return fromSrc;
}

/** Node-local install root (copies of enabled packs). */
export function expertsInstallRoot(): string {
  if (process.env.NODE4_EXPERTS_INSTALL?.trim()) {
    return resolve(process.env.NODE4_EXPERTS_INSTALL.trim());
  }
  return resolve(node4Root(), "installed-experts");
}

export function catalogPackDir(packId: string): string {
  return resolve(expertsCatalogRoot(), packId.toLowerCase().trim());
}

export function installPackDir(packId: string): string {
  return resolve(expertsInstallRoot(), packId.toLowerCase().trim());
}
