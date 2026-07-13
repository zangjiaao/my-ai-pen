/**
 * Load a RolePack from an experts/<id>/ directory (pack.json + mission.md + work.md).
 */
import { readFileSync, existsSync, readdirSync, accessSync } from "node:fs";
import { readFile, access, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { BookingMode, RolePack } from "../roles/types.js";

export type PackManifest = {
  id: string;
  label: string;
  aliases?: string[];
  toolNames: string[];
  skillIds?: string[];
  bookingMode?: BookingMode;
  settlementNote?: string;
  defaultGoalObjective?: string;
  recipeDir?: string;
};

export type LoadedPack = RolePack & {
  packRoot: string;
  skillsRoot: string;
  aliases: string[];
};

export type CatalogEntry = {
  id: string;
  label: string;
  aliases: string[];
};

function linesFromMarkdown(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0 && !l.trim().startsWith("#"));
}

function packFromParts(packDir: string, manifest: PackManifest, missionRaw: string, workRaw: string): LoadedPack {
  if (!manifest.id || !Array.isArray(manifest.toolNames)) {
    throw new Error(`Invalid pack.json in ${packDir}: need id and toolNames`);
  }
  const missionLines = linesFromMarkdown(missionRaw);
  const workLines = linesFromMarkdown(workRaw);
  const bookingMode: BookingMode = manifest.bookingMode === "none" ? "none" : "finding";
  return {
    id: String(manifest.id).toLowerCase().trim(),
    label: manifest.label || manifest.id,
    missionLines: missionLines.length
      ? missionLines
      : [`You are Node4 in the **${manifest.id}** role pack.`],
    workLines: workLines.length
      ? workLines
      : ["Work within authorized scope. No finish tool; harness settles."],
    toolNames: manifest.toolNames.map(String),
    bookingMode,
    settlementNote: manifest.settlementNote || "Harness settles the session.",
    defaultGoalObjective: manifest.defaultGoalObjective,
    skillIds: (manifest.skillIds || []).map(String),
    recipeDir: manifest.recipeDir,
    packRoot: packDir,
    skillsRoot: join(packDir, "skills"),
    aliases: (manifest.aliases || []).map((a) => String(a).toLowerCase().trim()),
  };
}

export function loadPackFromDirSync(packDir: string): LoadedPack {
  const manifest = JSON.parse(readFileSync(join(packDir, "pack.json"), "utf8")) as PackManifest;
  let missionRaw = "";
  let workRaw = "";
  try {
    missionRaw = readFileSync(join(packDir, "mission.md"), "utf8");
  } catch {
    /* optional */
  }
  try {
    workRaw = readFileSync(join(packDir, "work.md"), "utf8");
  } catch {
    /* optional */
  }
  return packFromParts(packDir, manifest, missionRaw, workRaw);
}

export async function loadPackFromDir(packDir: string): Promise<LoadedPack> {
  const manifest = JSON.parse(await readFile(join(packDir, "pack.json"), "utf8")) as PackManifest;
  let missionRaw = "";
  let workRaw = "";
  try {
    missionRaw = await readFile(join(packDir, "mission.md"), "utf8");
  } catch {
    /* optional */
  }
  try {
    workRaw = await readFile(join(packDir, "work.md"), "utf8");
  } catch {
    /* optional */
  }
  return packFromParts(packDir, manifest, missionRaw, workRaw);
}

export function loadCatalogIndexSync(catalogRoot: string): CatalogEntry[] {
  const catalogPath = join(catalogRoot, "catalog.json");
  if (existsSync(catalogPath)) {
    try {
      const data = JSON.parse(readFileSync(catalogPath, "utf8")) as { packs?: CatalogEntry[] };
      if (Array.isArray(data.packs) && data.packs.length) {
        return data.packs.map((p) => ({
          id: String(p.id).toLowerCase().trim(),
          label: p.label || p.id,
          aliases: (p.aliases || []).map((a) => String(a).toLowerCase().trim()),
        }));
      }
    } catch {
      /* scan dirs */
    }
  }
  if (!existsSync(catalogRoot)) return [];
  const out: CatalogEntry[] = [];
  for (const name of readdirSync(catalogRoot, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    try {
      const pack = loadPackFromDirSync(join(catalogRoot, name.name));
      out.push({ id: pack.id, label: pack.label, aliases: pack.aliases });
    } catch {
      /* skip */
    }
  }
  return out;
}

export async function loadCatalogIndex(catalogRoot: string): Promise<CatalogEntry[]> {
  return loadCatalogIndexSync(catalogRoot);
}

export function dirHasPackSync(dir: string): boolean {
  try {
    accessSync(join(dir, "pack.json"));
    return true;
  } catch {
    return false;
  }
}
