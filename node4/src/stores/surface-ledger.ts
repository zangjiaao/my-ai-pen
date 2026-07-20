/**
 * Attack-surface ledger — coverage truth for recon → probe → book.
 * Stored under taskDir/surfaces/ledger.json. No platform host assets.
 *
 * Status flow: open → in_probe → probed | booked | deadend | skipped_roe
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathKey, pathsMatch } from "../runtime/subagent-booking.js";
import type { SubagentSurface } from "../runtime/subagent-result.js";

export type SurfaceStatus =
  | "open"
  | "in_probe"
  | "probed"
  | "booked"
  | "deadend"
  | "skipped_roe";

export type SurfaceItem = {
  id: string;
  location: string;
  path_key: string;
  kind?: string;
  params?: string[];
  auth?: string;
  status: SurfaceStatus;
  note?: string;
  updated_at: string;
  source_subagent_id?: string;
};

export type SurfaceLedgerSummary = {
  total: number;
  open: number;
  in_probe: number;
  probed: number;
  booked: number;
  deadend: number;
  skipped: number;
  /** Paths still needing act (open + in_probe) */
  actionable: number;
  open_preview: string[];
};

export type SurfaceLedgerFile = {
  version: 1;
  updated_at: string;
  surfaces: SurfaceItem[];
};

const MAX_SURFACES = 200;
const PREVIEW = 8;

const TERMINAL: ReadonlySet<SurfaceStatus> = new Set([
  "probed",
  "booked",
  "deadend",
  "skipped_roe",
]);

const ACTED: ReadonlySet<SurfaceStatus> = new Set([
  "probed",
  "booked",
  "deadend",
  "skipped_roe",
  "in_probe",
]);

function nowIso(): string {
  return new Date().toISOString();
}

function idFromLocation(location: string): string {
  const pk = pathKey(location);
  if (pk) return pk.slice(0, 180);
  return String(location || "")
    .trim()
    .toLowerCase()
    .slice(0, 180);
}

function asParams(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .slice(0, 40);
  return out.length ? out : undefined;
}

export class SurfaceLedgerStore {
  private cache: SurfaceLedgerFile | null = null;

  constructor(private readonly ledgerPath: string) {}

  static dirFromTaskDir(taskDir: string): string {
    return join(taskDir, "surfaces");
  }

  static pathFromTaskDir(taskDir: string): string {
    return join(taskDir, "surfaces", "ledger.json");
  }

  async ensureDir(): Promise<void> {
    await mkdir(dirname(this.ledgerPath), { recursive: true });
  }

  async load(): Promise<SurfaceLedgerFile> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.ledgerPath, "utf8");
      const parsed = JSON.parse(raw) as SurfaceLedgerFile;
      if (!parsed || !Array.isArray(parsed.surfaces)) {
        this.cache = { version: 1, updated_at: nowIso(), surfaces: [] };
      } else {
        this.cache = {
          version: 1,
          updated_at: parsed.updated_at || nowIso(),
          surfaces: parsed.surfaces.slice(0, MAX_SURFACES),
        };
      }
    } catch {
      this.cache = { version: 1, updated_at: nowIso(), surfaces: [] };
    }
    return this.cache;
  }

  async save(): Promise<void> {
    const data = await this.load();
    data.updated_at = nowIso();
    await this.ensureDir();
    await writeFile(this.ledgerPath, JSON.stringify(data, null, 2), "utf8");
  }

  summary(): SurfaceLedgerSummary {
    const surfaces = this.cache?.surfaces ?? [];
    const counts = {
      total: surfaces.length,
      open: 0,
      in_probe: 0,
      probed: 0,
      booked: 0,
      deadend: 0,
      skipped: 0,
      actionable: 0,
      open_preview: [] as string[],
    };
    for (const s of surfaces) {
      if (s.status === "open") counts.open += 1;
      else if (s.status === "in_probe") counts.in_probe += 1;
      else if (s.status === "probed") counts.probed += 1;
      else if (s.status === "booked") counts.booked += 1;
      else if (s.status === "deadend") counts.deadend += 1;
      else if (s.status === "skipped_roe") counts.skipped += 1;
    }
    counts.actionable = counts.open + counts.in_probe;
    counts.open_preview = surfaces
      .filter((s) => s.status === "open" || s.status === "in_probe")
      .slice(0, PREVIEW)
      .map((s) => s.path_key || s.location);
    return counts;
  }

  listOpen(): SurfaceItem[] {
    return (this.cache?.surfaces ?? []).filter(
      (s) => s.status === "open" || s.status === "in_probe",
    );
  }

  all(): SurfaceItem[] {
    return this.cache?.surfaces ? [...this.cache.surfaces] : [];
  }

  /**
   * Merge recon surfaces. New paths start open; existing keep status and enrich metadata.
   */
  async upsertFromRecon(
    surfaces: SubagentSurface[],
    meta?: { source_subagent_id?: string },
  ): Promise<{ added: number; total: number }> {
    const data = await this.load();
    let added = 0;
    const byId = new Map(data.surfaces.map((s) => [s.id, s]));

    for (const raw of surfaces.slice(0, MAX_SURFACES)) {
      const location = String(raw.location || "").trim();
      if (!location || location.length < 2) continue;
      const id = idFromLocation(location);
      if (!id) continue;
      const existing = byId.get(id);
      if (existing) {
        if (raw.kind && !existing.kind) existing.kind = String(raw.kind).slice(0, 64);
        if (raw.auth && !existing.auth) existing.auth = String(raw.auth).slice(0, 64);
        const params = asParams(raw.params);
        if (params?.length && !existing.params?.length) existing.params = params;
        if (raw.note && !existing.note) existing.note = String(raw.note).slice(0, 500);
        existing.updated_at = nowIso();
        continue;
      }
      if (data.surfaces.length >= MAX_SURFACES) break;
      const item: SurfaceItem = {
        id,
        location: location.slice(0, 500),
        path_key: pathKey(location) || id,
        kind: raw.kind ? String(raw.kind).slice(0, 64) : undefined,
        params: asParams(raw.params),
        auth: raw.auth ? String(raw.auth).slice(0, 64) : undefined,
        status: "open",
        note: raw.note ? String(raw.note).slice(0, 500) : undefined,
        updated_at: nowIso(),
        source_subagent_id: meta?.source_subagent_id,
      };
      data.surfaces.push(item);
      byId.set(id, item);
      added += 1;
    }
    this.cache = data;
    await this.save();
    return { added, total: data.surfaces.length };
  }

  private async setStatus(
    locations: string[],
    status: SurfaceStatus,
    note?: string,
    options?: { onlyFrom?: SurfaceStatus[] },
  ): Promise<number> {
    const data = await this.load();
    let n = 0;
    for (const loc of locations) {
      const target = String(loc || "").trim();
      if (!target) continue;
      for (const s of data.surfaces) {
        if (!pathsMatch(target, s.location) && !pathsMatch(target, s.path_key)) continue;
        if (options?.onlyFrom && !options.onlyFrom.includes(s.status)) {
          // Still allow upgrade booked from anything; for in_probe only from open
          if (status === "booked") {
            /* always allow booked */
          } else if (status === "probed" && TERMINAL.has(s.status) && s.status !== "probed") {
            continue; // don't downgrade booked/deadend/skip to probed
          } else if (options.onlyFrom && !options.onlyFrom.includes(s.status)) {
            if (!(status === "probed" && s.status === "in_probe")) {
              if (!(status === "in_probe" && s.status === "open")) {
                if (!(status === "probed" && s.status === "open")) {
                  if (s.status !== "open" && s.status !== "in_probe" && status !== "booked") {
                    continue;
                  }
                }
              }
            }
          }
        }
        // Never downgrade booked → probed
        if (s.status === "booked" && status !== "booked") continue;
        if (s.status === "deadend" && (status === "open" || status === "in_probe")) continue;
        if (s.status === "skipped_roe" && (status === "open" || status === "in_probe")) continue;

        s.status = status;
        if (note) s.note = note.slice(0, 500);
        s.updated_at = nowIso();
        n += 1;
      }
    }
    if (n) {
      this.cache = data;
      await this.save();
    }
    return n;
  }

  async markInProbe(locations: string[]): Promise<number> {
    return this.setStatus(locations, "in_probe", undefined, { onlyFrom: ["open"] });
  }

  async markProbed(locations: string[]): Promise<number> {
    const data = await this.load();
    let n = 0;
    for (const loc of locations) {
      const target = String(loc || "").trim();
      if (!target) continue;
      for (const s of data.surfaces) {
        if (!pathsMatch(target, s.location) && !pathsMatch(target, s.path_key)) continue;
        if (s.status === "booked" || s.status === "deadend" || s.status === "skipped_roe") continue;
        s.status = "probed";
        s.updated_at = nowIso();
        n += 1;
      }
    }
    if (n) {
      this.cache = data;
      await this.save();
    }
    return n;
  }

  async markBooked(location: string): Promise<number> {
    return this.setStatus([location], "booked");
  }

  async markDeadend(location: string, note?: string): Promise<number> {
    return this.setStatus([location], "deadend", note);
  }

  async markSkipped(location: string, note?: string): Promise<number> {
    return this.setStatus([location], "skipped_roe", note);
  }

  /**
   * True if text mentions a path that has been acted on (probed/booked/deadend/skip).
   */
  hasActedMatch(text: string): boolean {
    const t = String(text || "");
    if (!t.trim()) return false;
    for (const s of this.cache?.surfaces ?? []) {
      if (!ACTED.has(s.status) || s.status === "in_probe") {
        if (!TERMINAL.has(s.status)) continue;
      }
      if (!TERMINAL.has(s.status)) continue;
      const pk = s.path_key || s.id;
      if (pk.length >= 3 && t.toLowerCase().includes(pk.toLowerCase())) return true;
      if (s.location && t.toLowerCase().includes(s.location.toLowerCase().slice(0, 40))) return true;
    }
    return false;
  }

  findByLocationHint(text: string): SurfaceItem | undefined {
    const t = String(text || "").trim();
    if (!t) return undefined;
    for (const s of this.cache?.surfaces ?? []) {
      if (pathsMatch(t, s.location) || pathsMatch(t, s.path_key)) return s;
      const pk = s.path_key || s.id;
      if (pk.length >= 4 && t.toLowerCase().includes(pk.toLowerCase())) return s;
    }
    return undefined;
  }
}

/** Graph consumer node types that probe surfaces (not pure surface recon). */
export const SURFACE_CONSUMER_NODES = new Set([
  "class_probe",
  "authz_logic",
  "component",
  "auth_session",
  "prior_reverify",
  "chain",
  "postex",
  "lateral",
]);

export const SURFACE_PRODUCER_NODES = new Set(["surface", "recon"]);

/**
 * Pure gate for Graph todo(done). Ledger is coverage truth.
 */
export function assertTodoDoneAllowed(input: {
  task?: string;
  phase?: string;
  note?: string;
  summary: SurfaceLedgerSummary;
  hasActedMatch: (text: string) => boolean;
  findByLocationHint: (text: string) => SurfaceItem | undefined;
}): { ok: true; ledgerOp?: { op: "deadend" | "skipped_roe"; location: string; note?: string } } | { ok: false; error: string } {
  const task = String(input.task || "").trim();
  const phase = String(input.phase || "").trim();
  const note = String(input.note || "").trim();
  const { summary } = input;

  // No ledger content → no gate
  if (summary.total < 1) return { ok: true };

  // All actionable cleared
  if (summary.actionable < 1) return { ok: true };

  const blob = `${task} ${phase} ${note}`;
  const meta =
    /report|汇总|validate|台账|prior\s*re-?verif|检查台账/i.test(task) ||
    /report|汇总|validate/i.test(phase);

  // Explicit deadend / skip with optional location
  const deadendM = note.match(/^(deadend|skipped_roe)\b[:\s]*(.*)$/i);
  if (deadendM) {
    const kind = deadendM[1]!.toLowerCase() === "skipped_roe" ? "skipped_roe" : "deadend";
    const rest = (deadendM[2] || "").trim();
    const hit = input.findByLocationHint(rest || task || note);
    if (hit) {
      return {
        ok: true,
        ledgerOp: { op: kind, location: hit.location, note: note.slice(0, 500) },
      };
    }
    // Allow category-level deadend/skip without path when note is explicit
    return { ok: true };
  }

  // probed/booked note — need acted match or path in ledger terminal
  if (/^(probed|booked)\b/i.test(note)) {
    if (input.hasActedMatch(blob)) return { ok: true };
    return {
      ok: false,
      error:
        "error: todo(done) note=probed|booked requires a ledger surface path that is already probed/booked. " +
        `Open/in_probe (${summary.actionable}): ${summary.open_preview.join(", ") || "(none)"}. ` +
        "Dispatch subagent on an open surface, or note=deadend:<path> / skipped_roe:<path>.",
    };
  }

  // n/a for meta tasks only
  if (/^(n\/a|na|skip)\b/i.test(note)) {
    if (meta) return { ok: true };
    return {
      ok: false,
      error:
        "error: note=n/a only for meta/report tasks. For attack categories: probe open surfaces or note=deadend|skipped_roe.",
    };
  }

  // Path already acted appears in task/note
  if (input.hasActedMatch(blob)) return { ok: true };

  // Meta task with any note
  if (meta && note.length >= 2) return { ok: true };

  const preview = summary.open_preview.join(", ") || "(no preview)";
  return {
    ok: false,
    error:
      `error: Graph todo(done) blocked — surface ledger still has ${summary.actionable} open/in_probe path(s): ${preview}. ` +
      "Do not batch-flip categories without act. Options: (1) subagent on an open path, " +
      "(2) note=deadend:<path> or skipped_roe:<path>, (3) note=probed after ledger shows probed. " +
      `Task was: ${task || phase || "(phase)"}`,
  };
}
