/**
 * Case Surface ledger — Node SQLite working store (Spec #368 / issues #370–#371).
 *
 * Path: taskDir/surfaces/ledger.sqlite
 * Identity / status: surface-identity pure core (#369).
 *
 * Offline-complete: tool ok does not require Platform.
 * Graph coverage gates (todo done, subagent post-process, settlement) read this store.
 * Online dual-write (#374): local commit → platform_sync pending; async WS surface_upsert → ok|error.
 */

import { mkdir, readFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createMutex } from "../runtime/concurrency.js";
import { pathsMatch } from "../runtime/subagent-booking.js";
import type { SubagentSurface } from "../runtime/subagent-result.js";
import {
  applyStatusAdvance,
  isSurfaceStatus,
  mergeMethods,
  mergeParams,
  normalizeSurfaceStatus,
  parseLocation,
  resolveBookingLocation,
  resolveUpsertStatus,
  surfaceRowKey,
  type ResolveBookingLocationInput,
  type SurfaceStatus,
} from "./surface-identity.js";

/** Write hard-cap per Case/task ledger (Spec D4). */
export const SURFACE_WRITE_HARD_CAP = 2000;

/** Agent list page default / max (Spec D4). */
export const SURFACE_LIST_DEFAULT_LIMIT = 200;

/** Recommend max surfaces per upsert call (Spec D4 / story 26). */
export const SURFACE_UPSERT_BATCH_MAX = 20;

/** Open-path preview size for gate error messages (matches legacy ledger). */
const OPEN_PREVIEW = 8;

/**
 * Terminal / acted statuses for Graph todo(done) match (v2 + retained terminals).
 * Legacy probed maps to touched via normalizeSurfaceStatus on read.
 */
const TERMINAL: ReadonlySet<SurfaceStatus> = new Set([
  "touched",
  "booked",
  "deadend",
  "skipped_roe",
]);

export type PlatformSyncState = "offline" | "pending" | "ok" | "error";

export type SurfaceRow = {
  id: string;
  origin_key: string;
  path_key: string;
  location: string;
  kind?: string;
  methods: string[];
  params: string[];
  auth?: string;
  status: SurfaceStatus;
  note?: string;
  source?: string;
  source_agent_id?: string;
  platform_sync: PlatformSyncState;
  created_at: string;
  updated_at: string;
};

export type SurfaceUpsertItem = {
  location: string;
  methods?: string[] | null;
  params?: string[] | null;
  status?: string | null;
  kind?: string | null;
  auth?: string | null;
  note?: string | null;
  source?: string | null;
};

export type SurfaceUpsertMeta = {
  source_agent_id?: string;
  /** Default source label when item.source omitted (agent | finding | import | migrate). */
  source?: string;
  /**
   * Allow status=booked (finding booking path only). Ordinary tool upsert leaves this false.
   */
  allowBooked?: boolean;
  /**
   * Allow status=touched (operator TESTED). Traffic settle only (#411).
   * Ordinary Agent upsert leaves this false — cannot fake TESTED without traffic.
   * Also true when source is `"traffic"`.
   */
  allowTested?: boolean;
  /**
   * When true, skip hard-cap create failure by returning skip (finding path may keep booking).
   * Ordinary tool upsert leaves this false → hard reject.
   */
  softCapSkip?: boolean;
  /**
   * Spec #374: when true (Node bound to Platform + conversationId), write rows as
   * platform_sync=pending for async dual-write. Offline/standalone leaves this false → offline.
   */
  platformOnline?: boolean;
};

export type SurfaceUpsertResult = {
  ok: true;
  upserted: SurfaceRow[];
  created: number;
  updated: number;
  total: number;
  platform_sync: PlatformSyncState;
  /** Present when softCapSkip dropped new creates at hard-cap. */
  cap_skipped?: number;
};

export type SurfaceUpsertError = {
  ok: false;
  error: string;
  total?: number;
  hard_cap?: number;
};

export type SurfaceListOpts = {
  /** Status filter; default open+in_probe (actionable queue). Pass "all" for every status. */
  status?: string | string[] | null;
  origin_key?: string | null;
  limit?: number | null;
  offset?: number | null;
};

export type SurfaceListResult = {
  surfaces: SurfaceRow[];
  returned: number;
  total_matching: number;
  has_more: boolean;
  limit: number;
  offset: number;
};

export type SurfaceGetOpts = {
  id?: string | null;
  location?: string | null;
  origin_key?: string | null;
  path_key?: string | null;
};

/**
 * Gate / settlement summary.
 * Field names keep v1 gate consumers working:
 *   open ≈ seen, in_probe ≈ touched (active work), probed unused under v2 (stays 0),
 *   actionable = seen + touched (not booked / optional terminals).
 */
export type SurfaceCoverageSummary = {
  total: number;
  open: number;
  in_probe: number;
  probed: number;
  booked: number;
  deadend: number;
  skipped: number;
  /** Paths still needing act (seen + touched). */
  actionable: number;
  open_preview: string[];
};

type DbRow = {
  id: string;
  origin_key: string;
  path_key: string;
  location: string;
  kind: string | null;
  methods_json: string | null;
  params_json: string | null;
  auth: string | null;
  status: string;
  note: string | null;
  source: string | null;
  source_agent_id: string | null;
  platform_sync: string | null;
  created_at: string;
  updated_at: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS surfaces (
  id TEXT PRIMARY KEY NOT NULL,
  origin_key TEXT NOT NULL,
  path_key TEXT NOT NULL,
  location TEXT NOT NULL,
  kind TEXT,
  methods_json TEXT,
  params_json TEXT,
  auth TEXT,
  status TEXT NOT NULL,
  note TEXT,
  source TEXT,
  source_agent_id TEXT,
  platform_sync TEXT NOT NULL DEFAULT 'offline',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_surfaces_origin_path
  ON surfaces(origin_key, path_key);
CREATE INDEX IF NOT EXISTS ix_surfaces_status ON surfaces(status);
CREATE INDEX IF NOT EXISTS ix_surfaces_origin ON surfaces(origin_key);
`;

function nowIso(): string {
  return new Date().toISOString();
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.map((x) => String(x ?? "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n);
}

function asStringList(v: unknown, max = 40): string[] | undefined {
  if (v == null) return undefined;
  if (!Array.isArray(v)) return undefined;
  const out = v
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .slice(0, max);
  return out.length ? out : undefined;
}

function rowFromDb(r: DbRow): SurfaceRow {
  // Expand-contract: accept legacy DB values; surface write form to callers.
  const status = normalizeSurfaceStatus(r.status) ?? "seen";
  const sync = r.platform_sync;
  const platform_sync: PlatformSyncState =
    sync === "pending" || sync === "ok" || sync === "error" || sync === "offline"
      ? sync
      : "offline";
  return {
    id: r.id,
    origin_key: r.origin_key,
    path_key: r.path_key ?? "",
    location: r.location,
    kind: r.kind || undefined,
    methods: parseJsonArray(r.methods_json),
    params: parseJsonArray(r.params_json),
    auth: r.auth || undefined,
    status,
    note: r.note || undefined,
    source: r.source || undefined,
    source_agent_id: r.source_agent_id || undefined,
    platform_sync,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function defaultListStatuses(status: SurfaceListOpts["status"]): SurfaceStatus[] | "all" {
  const fallback: SurfaceStatus[] = ["seen", "touched"];
  if (status == null || status === "") return fallback;
  if (typeof status === "string") {
    const s = status.trim().toLowerCase();
    if (s === "all" || s === "*") return "all";
    if (s.includes(",")) {
      const out = s
        .split(",")
        .map((x) => normalizeSurfaceStatus(x.trim()))
        .filter((x): x is SurfaceStatus => x != null);
      return out.length ? out : fallback;
    }
    const one = normalizeSurfaceStatus(s);
    return one != null ? [one] : fallback;
  }
  if (Array.isArray(status)) {
    const out = status
      .map((x) => normalizeSurfaceStatus(String(x ?? "").trim()))
      .filter((x): x is SurfaceStatus => x != null);
    return out.length ? out : fallback;
  }
  return fallback;
}

/**
 * Expand write statuses to SQL match set including unmigrated legacy values
 * still stored in SQLite (expand-contract read).
 */
function sqlStatusMatchSet(statuses: SurfaceStatus[]): string[] {
  const out = new Set<string>();
  for (const s of statuses) {
    out.add(s);
    if (s === "seen") out.add("open");
    if (s === "touched") {
      out.add("in_probe");
      out.add("probed");
    }
  }
  return [...out];
}

export class SurfaceSqliteStore {
  private db: DatabaseSync | null = null;
  private migratedJson = false;
  private readonly withLock = createMutex();

  constructor(private readonly dbPath: string) {}

  static dirFromTaskDir(taskDir: string): string {
    return join(taskDir, "surfaces");
  }

  static pathFromTaskDir(taskDir: string): string {
    return join(taskDir, "surfaces", "ledger.sqlite");
  }

  static legacyJsonPathFromTaskDir(taskDir: string): string {
    return join(taskDir, "surfaces", "ledger.json");
  }

  /** Ensure parent dir exists and open SQLite (idempotent). */
  async open(): Promise<void> {
    return this.withLock(async () => {
      if (this.db) return;
      await mkdir(dirname(this.dbPath), { recursive: true });
      const db = new DatabaseSync(this.dbPath);
      db.exec(SCHEMA);
      this.db = db;
      await this.migrateLegacyJsonUnlocked();
    });
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* ignore */
      }
      this.db = null;
    }
  }

  private requireDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("SurfaceSqliteStore not open — call open() first");
    }
    return this.db;
  }

  private countUnlocked(): number {
    const db = this.requireDb();
    const row = db.prepare("SELECT COUNT(*) AS c FROM surfaces").get() as { c: number };
    return Number(row?.c ?? 0);
  }

  count(): Promise<number> {
    return this.withLock(async () => {
      this.requireDb();
      return this.countUnlocked();
    });
  }

  /**
   * One-shot import from legacy surfaces/ledger.json when SQLite is empty.
   * Spec D12 — preserves statuses; does not dual-read after.
   */
  private async migrateLegacyJsonUnlocked(): Promise<void> {
    if (this.migratedJson) return;
    this.migratedJson = true;
    const total = this.countUnlocked();
    if (total > 0) return;

    const jsonPath = join(dirname(this.dbPath), "ledger.json");
    try {
      await access(jsonPath);
    } catch {
      return;
    }
    let raw: string;
    try {
      raw = await readFile(jsonPath, "utf8");
    } catch {
      return;
    }
    let parsed: { surfaces?: unknown[] };
    try {
      parsed = JSON.parse(raw) as { surfaces?: unknown[] };
    } catch {
      return;
    }
    if (!Array.isArray(parsed.surfaces) || !parsed.surfaces.length) return;

    const ts = nowIso();
    for (const item of parsed.surfaces) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const location = String(rec.location || "").trim();
      if (!location) continue;
      const parsedLoc = parseLocation(location);
      let origin_key: string;
      let path_key: string;
      let kind: string | undefined;
      if (parsedLoc.ok) {
        origin_key = parsedLoc.origin_key;
        path_key = parsedLoc.path_key;
        kind = parsedLoc.kind;
      } else {
        // Legacy rows may be path-only; keep a stable synthetic origin so identity is unique.
        origin_key = "legacy://migrated:0";
        path_key = String(rec.path_key || rec.id || location).trim().slice(0, 500);
        kind = rec.kind != null ? String(rec.kind) : undefined;
      }
      const id = surfaceRowKey(origin_key, path_key);
      const statusRaw = String(rec.status || "seen").trim();
      const status: SurfaceStatus = normalizeSurfaceStatus(statusRaw) ?? "seen";
      const methods = asStringList(rec.methods) ?? [];
      const params = asStringList(rec.params) ?? [];
      const note = rec.note != null ? clip(String(rec.note), 500) : undefined;
      const auth = rec.auth != null ? clip(String(rec.auth), 64) : undefined;
      const source_agent_id =
        rec.source_subagent_id != null
          ? String(rec.source_subagent_id)
          : rec.source_agent_id != null
            ? String(rec.source_agent_id)
            : undefined;
      const created_at = rec.updated_at != null ? String(rec.updated_at) : ts;
      const updated_at = created_at;
      try {
        this.requireDb()
          .prepare(
            `INSERT OR IGNORE INTO surfaces (
              id, origin_key, path_key, location, kind, methods_json, params_json,
              auth, status, note, source, source_agent_id, platform_sync, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            origin_key,
            path_key,
            clip(location, 500),
            kind ? clip(kind, 64) : null,
            methods.length ? JSON.stringify(methods) : null,
            params.length ? JSON.stringify(params) : null,
            auth ?? null,
            status,
            note ?? null,
            "migrate",
            source_agent_id ?? null,
            "offline",
            created_at,
            updated_at,
          );
      } catch {
        /* skip bad row */
      }
    }
  }

  private getByIdentityUnlocked(origin_key: string, path_key: string): SurfaceRow | null {
    const db = this.requireDb();
    const r = db
      .prepare("SELECT * FROM surfaces WHERE origin_key = ? AND path_key = ?")
      .get(origin_key, path_key) as DbRow | undefined;
    return r ? rowFromDb(r) : null;
  }

  private getByIdUnlocked(id: string): SurfaceRow | null {
    const db = this.requireDb();
    const r = db.prepare("SELECT * FROM surfaces WHERE id = ?").get(id) as DbRow | undefined;
    return r ? rowFromDb(r) : null;
  }

  /**
   * Upsert one or many surfaces by identity (origin_key + path_key).
   * New rows rejected when total would exceed SURFACE_WRITE_HARD_CAP (unless softCapSkip).
   */
  async upsert(
    items: SurfaceUpsertItem[],
    meta?: SurfaceUpsertMeta,
  ): Promise<SurfaceUpsertResult | SurfaceUpsertError> {
    return this.withLock(async () => {
      this.requireDb();
      const batch = items.slice(0, SURFACE_UPSERT_BATCH_MAX);
      if (!batch.length) {
        return { ok: false as const, error: "upsert requires at least one surface with location" };
      }

      const ts = nowIso();
      const upserted: SurfaceRow[] = [];
      let created = 0;
      let updated = 0;
      let cap_skipped = 0;
      // Online dual-write (#374): pending until async Platform publish settles; offline stays local-only.
      const platform_sync: PlatformSyncState = meta?.platformOnline ? "pending" : "offline";
      const sourceDefault = meta?.source || "agent";
      const source_agent_id = meta?.source_agent_id
        ? clip(String(meta.source_agent_id), 120)
        : undefined;

      for (const raw of batch) {
        const location = String(raw.location || "").trim();
        if (!location || location.length < 2) {
          return {
            ok: false as const,
            error: "each surface requires a non-empty location with scheme://",
          };
        }
        const parsed = parseLocation(location);
        if (!parsed.ok) {
          return { ok: false as const, error: `invalid location: ${parsed.error}` };
        }

        const { origin_key, path_key, kind: parsedKind } = parsed;
        const id = surfaceRowKey(origin_key, path_key);
        const existing = this.getByIdentityUnlocked(origin_key, path_key);

        let status: SurfaceStatus;
        const rawStatusNorm =
          raw.status != null ? normalizeSurfaceStatus(String(raw.status).trim()) : null;
        if (meta?.allowBooked && rawStatusNorm === "booked") {
          // Booking path: advance with allowBooked semantics; force booked when allowed.
          status = "booked";
        } else {
          const requested =
            raw.status != null && isSurfaceStatus(String(raw.status).trim())
              ? String(raw.status).trim()
              : undefined;
          // Spec #411: TESTED (touched) only via Traffic settle (or explicit allowTested).
          const allowTested =
            meta?.allowTested === true ||
            meta?.source === "traffic" ||
            String(raw.source || "").trim() === "traffic";
          status = resolveUpsertStatus(existing?.status, requested, { allowTested });
        }

        const methods = mergeMethods(existing?.methods, asStringList(raw.methods));
        const params = mergeParams(existing?.params, asStringList(raw.params));
        const kind =
          (raw.kind != null && String(raw.kind).trim()
            ? clip(String(raw.kind).trim(), 64)
            : undefined) ||
          existing?.kind ||
          parsedKind;
        const auth =
          (raw.auth != null && String(raw.auth).trim()
            ? clip(String(raw.auth).trim(), 64)
            : undefined) || existing?.auth;
        const note =
          (raw.note != null && String(raw.note).trim()
            ? clip(String(raw.note).trim(), 500)
            : undefined) || existing?.note;
        const source =
          (raw.source != null && String(raw.source).trim()
            ? clip(String(raw.source).trim(), 64)
            : undefined) ||
          existing?.source ||
          sourceDefault;
        const agentId = source_agent_id || existing?.source_agent_id;
        const locationStore = clip(location, 500);

        if (!existing) {
          const total = this.countUnlocked();
          if (total >= SURFACE_WRITE_HARD_CAP) {
            if (meta?.softCapSkip) {
              cap_skipped += 1;
              continue;
            }
            return {
              ok: false as const,
              error: `surface write hard-cap reached (${SURFACE_WRITE_HARD_CAP} rows per Case/task ledger); cannot create new surface. Update existing rows by identity or raise cap via config (not implemented).`,
              total,
              hard_cap: SURFACE_WRITE_HARD_CAP,
            };
          }
          this.requireDb()
            .prepare(
              `INSERT INTO surfaces (
                id, origin_key, path_key, location, kind, methods_json, params_json,
                auth, status, note, source, source_agent_id, platform_sync, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              id,
              origin_key,
              path_key,
              locationStore,
              kind ?? null,
              methods.length ? JSON.stringify(methods) : null,
              params.length ? JSON.stringify(params) : null,
              auth ?? null,
              status,
              note ?? null,
              source,
              agentId ?? null,
              platform_sync,
              ts,
              ts,
            );
          created += 1;
        } else {
          this.requireDb()
            .prepare(
              `UPDATE surfaces SET
                location = ?, kind = ?, methods_json = ?, params_json = ?,
                auth = ?, status = ?, note = ?, source = ?,
                source_agent_id = ?, platform_sync = ?, updated_at = ?
              WHERE id = ?`,
            )
            .run(
              locationStore,
              kind ?? null,
              methods.length ? JSON.stringify(methods) : null,
              params.length ? JSON.stringify(params) : null,
              auth ?? null,
              status,
              note ?? null,
              source,
              agentId ?? null,
              // Online re-upsert always re-pending (attrs may have changed). Offline stays offline.
              platform_sync,
              ts,
              existing.id,
            );
          updated += 1;
        }

        const row = this.getByIdentityUnlocked(origin_key, path_key);
        if (row) upserted.push(row);
      }

      const result: SurfaceUpsertResult = {
        ok: true,
        upserted,
        created,
        updated,
        total: this.countUnlocked(),
        platform_sync,
      };
      if (cap_skipped > 0) result.cap_skipped = cap_skipped;
      return result;
    });
  }

  async list(opts: SurfaceListOpts = {}): Promise<SurfaceListResult> {
    return this.withLock(async () => {
      const db = this.requireDb();
      const limitRaw = opts.limit != null ? Number(opts.limit) : SURFACE_LIST_DEFAULT_LIMIT;
      const limit = Math.max(
        1,
        Math.min(
          SURFACE_LIST_DEFAULT_LIMIT,
          Number.isFinite(limitRaw) ? Math.floor(limitRaw) : SURFACE_LIST_DEFAULT_LIMIT,
        ),
      );
      const offsetRaw = opts.offset != null ? Number(opts.offset) : 0;
      const offset = Math.max(0, Number.isFinite(offsetRaw) ? Math.floor(offsetRaw) : 0);

      const statuses = defaultListStatuses(opts.status);
      const origin =
        opts.origin_key != null && String(opts.origin_key).trim()
          ? String(opts.origin_key).trim()
          : null;

      const where: string[] = [];
      const params: (string | number)[] = [];
      if (statuses !== "all") {
        if (!statuses.length) {
          return {
            surfaces: [],
            returned: 0,
            total_matching: 0,
            has_more: false,
            limit,
            offset,
          };
        }
        const match = sqlStatusMatchSet(statuses);
        where.push(`status IN (${match.map(() => "?").join(",")})`);
        params.push(...match);
      }
      if (origin) {
        where.push("origin_key = ?");
        params.push(origin);
      }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      const countRow = db
        .prepare(`SELECT COUNT(*) AS c FROM surfaces ${whereSql}`)
        .get(...params) as { c: number };
      const total_matching = Number(countRow?.c ?? 0);

      const rows = db
        .prepare(
          `SELECT * FROM surfaces ${whereSql}
           ORDER BY updated_at DESC, id ASC
           LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset) as DbRow[];

      const surfaces = rows.map(rowFromDb);
      return {
        surfaces,
        returned: surfaces.length,
        total_matching,
        has_more: offset + surfaces.length < total_matching,
        limit,
        offset,
      };
    });
  }

  async get(opts: SurfaceGetOpts): Promise<SurfaceRow | null> {
    return this.withLock(async () => {
      this.requireDb();
      const id = opts.id != null ? String(opts.id).trim() : "";
      if (id) return this.getByIdUnlocked(id);

      const location = opts.location != null ? String(opts.location).trim() : "";
      if (location) {
        const parsed = parseLocation(location);
        if (parsed.ok) {
          return this.getByIdentityUnlocked(parsed.origin_key, parsed.path_key);
        }
        // Fall back: treat as id / path_key match
        const byId = this.getByIdUnlocked(location);
        if (byId) return byId;
        return null;
      }

      const origin_key = opts.origin_key != null ? String(opts.origin_key).trim() : "";
      if (origin_key) {
        const path_key = opts.path_key != null ? String(opts.path_key).trim() : "";
        return this.getByIdentityUnlocked(origin_key, path_key);
      }
      return null;
    });
  }

  /**
   * Spec #374: update platform_sync after async dual-write attempt (pending → ok | error).
   * Does not touch updated_at (sync state is not a surface content change).
   */
  async setPlatformSync(ids: string[], state: PlatformSyncState): Promise<void> {
    if (!ids.length) return;
    return this.withLock(async () => {
      const db = this.requireDb();
      const stmt = db.prepare("UPDATE surfaces SET platform_sync = ? WHERE id = ?");
      for (const id of ids) {
        const key = String(id || "").trim();
        if (!key) continue;
        stmt.run(state, key);
      }
    });
  }

  private allUnlocked(): SurfaceRow[] {
    const db = this.requireDb();
    const rows = db
      .prepare("SELECT * FROM surfaces ORDER BY updated_at DESC, id ASC")
      .all() as DbRow[];
    return rows.map(rowFromDb);
  }

  /** All rows (gate / subagent post-process). */
  async all(): Promise<SurfaceRow[]> {
    return this.withLock(async () => this.allUnlocked());
  }

  /** seen + touched queue (actionable; Hard Workset emit / settlement). */
  async listOpen(): Promise<SurfaceRow[]> {
    return this.withLock(async () =>
      this.allUnlocked().filter((s) => s.status === "seen" || s.status === "touched"),
    );
  }

  /** Summary counts + open path preview for Graph gates / acceptance hints. */
  async summary(): Promise<SurfaceCoverageSummary> {
    return this.withLock(async () => {
      const surfaces = this.allUnlocked();
      const counts: SurfaceCoverageSummary = {
        total: surfaces.length,
        open: 0,
        in_probe: 0,
        probed: 0,
        booked: 0,
        deadend: 0,
        skipped: 0,
        actionable: 0,
        open_preview: [],
      };
      for (const s of surfaces) {
        // Map v2 write statuses onto legacy summary field names for gate parity.
        if (s.status === "seen") counts.open += 1;
        else if (s.status === "touched") counts.in_probe += 1;
        else if (s.status === "booked") counts.booked += 1;
        else if (s.status === "deadend") counts.deadend += 1;
        else if (s.status === "skipped_roe") counts.skipped += 1;
      }
      counts.actionable = counts.open + counts.in_probe;
      counts.open_preview = surfaces
        .filter((s) => s.status === "seen" || s.status === "touched")
        .slice(0, OPEN_PREVIEW)
        .map((s) => s.path_key || s.location);
      return counts;
    });
  }

  /**
   * True if text mentions a path that is terminal-acted (probed/booked/deadend/skipped_roe).
   * Semantics match legacy SurfaceLedgerStore.hasActedMatch for Graph todo(done).
   */
  async hasActedMatch(text: string): Promise<boolean> {
    return this.withLock(async () => {
      const t = String(text || "");
      if (!t.trim()) return false;
      const lower = t.toLowerCase();
      for (const s of this.allUnlocked()) {
        if (!TERMINAL.has(s.status)) continue;
        const pk = s.path_key || s.id;
        if (pk.length >= 3 && lower.includes(pk.toLowerCase())) return true;
        if (s.location && lower.includes(s.location.toLowerCase().slice(0, 40))) return true;
      }
      return false;
    });
  }

  /**
   * Find a surface by location / path_key hint (deadend note path matching).
   * Semantics match legacy SurfaceLedgerStore.findByLocationHint.
   */
  async findByLocationHint(text: string): Promise<SurfaceRow | undefined> {
    return this.withLock(async () => {
      const t = String(text || "").trim();
      if (!t) return undefined;
      const lower = t.toLowerCase();
      for (const s of this.allUnlocked()) {
        if (pathsMatch(t, s.location) || pathsMatch(t, s.path_key)) return s;
        const pk = s.path_key || s.id;
        if (pk.length >= 4 && lower.includes(pk.toLowerCase())) return s;
      }
      return undefined;
    });
  }

  /**
   * Advance matching rows to status using identity/path match + monotonic rules.
   * Returns number of rows updated.
   */
  private async setStatusByLocations(
    locations: string[],
    status: SurfaceStatus,
    note?: string,
    opts?: { allowBooked?: boolean },
  ): Promise<number> {
    return this.withLock(async () => {
      this.requireDb();
      const ts = nowIso();
      let n = 0;
      const surfaces = this.allUnlocked();
      for (const loc of locations) {
        const target = String(loc || "").trim();
        if (!target) continue;
        for (const s of surfaces) {
          if (
            !pathsMatch(target, s.location) &&
            !pathsMatch(target, s.path_key) &&
            !pathsMatch(target, s.id)
          ) {
            continue;
          }
          const advanced = applyStatusAdvance(s.status, status, {
            allowBooked: opts?.allowBooked === true || status === "booked",
          });
          if (!advanced.changed && advanced.status === s.status && !note) continue;
          // allowBooked booked→booked no-op still counts note-only? skip pure no-ops
          if (!advanced.changed && !note) continue;
          const nextStatus = advanced.changed ? advanced.status : s.status;
          const nextNote = note ? clip(note, 500) : s.note;
          this.requireDb()
            .prepare(
              `UPDATE surfaces SET status = ?, note = ?, updated_at = ? WHERE id = ?`,
            )
            .run(nextStatus, nextNote ?? null, ts, s.id);
          s.status = nextStatus;
          if (nextNote) s.note = nextNote;
          s.updated_at = ts;
          n += 1;
        }
      }
      return n;
    });
  }

  /** Advance to touched (legacy name; v2 maps in_probe → touched). */
  async markInProbe(locations: string[]): Promise<number> {
    return this.setStatusByLocations(locations, "touched");
  }

  /** Advance to touched (legacy name; v2 maps probed → touched). */
  async markProbed(locations: string[]): Promise<number> {
    return this.setStatusByLocations(locations, "touched");
  }

  /**
   * Spec #368 D7 / #376 / #382: finding book side-effect on local working store.
   * Resolve identity (absolute URL → host+port+location_key → proof URL), advance
   * matching rows to booked; if none match and identity is strong, system-create
   * source=finding status=booked. Hard-cap create is soft-skipped (finding must not fail).
   */
  async markBooked(
    location: string,
    opts?: Omit<ResolveBookingLocationInput, "location">,
  ): Promise<number> {
    const loc = String(location || "").trim();
    const resolved = resolveBookingLocation({
      location: loc || undefined,
      host: opts?.host,
      port: opts?.port,
      locationKey: opts?.locationKey,
      proof: opts?.proof,
      proofExcerpts: opts?.proofExcerpts,
      scheme: opts?.scheme,
    });
    // Prefer path/location match first (scheme-less location may still hit trafficked rows).
    const matchHints = [loc, resolved.ok ? resolved.location : "", resolved.ok ? resolved.path_key : ""]
      .map((s) => String(s || "").trim())
      .filter(Boolean);
    if (matchHints.length) {
      const advanced = await this.setStatusByLocations(matchHints, "booked", undefined, {
        allowBooked: true,
      });
      if (advanced > 0) return advanced;
    }
    // No match → system-create only with strong resolved identity (create-on-book).
    if (!resolved.ok) return 0;
    const result = await this.upsert(
      [{ location: resolved.location, status: "booked", source: "finding" }],
      {
        source: "finding",
        allowBooked: true,
        softCapSkip: true,
      },
    );
    if (!result.ok) return 0;
    if ((result.cap_skipped ?? 0) > 0 && result.created === 0) return 0;
    return result.created + result.updated;
  }

  async markDeadend(location: string, note?: string): Promise<number> {
    return this.setStatusByLocations([location], "deadend", note);
  }

  async markSkipped(location: string, note?: string): Promise<number> {
    return this.setStatusByLocations([location], "skipped_roe", note);
  }

  /**
   * Merge recon surfaces (host inject / subagent structured). New paths start seen.
   * Prefer surface tool upsert for agent deposits; this is the gate/settlement write path.
   */
  async upsertFromRecon(
    surfaces: SubagentSurface[],
    meta?: { source_subagent_id?: string },
  ): Promise<{ added: number; total: number }> {
    const items: SurfaceUpsertItem[] = [];
    for (const raw of surfaces.slice(0, SURFACE_UPSERT_BATCH_MAX * 10)) {
      const location = String(raw.location || "").trim();
      if (!location || location.length < 2) continue;
      // SQLite identity requires scheme:// — skip bare path rows (legacy only).
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(location)) continue;
      items.push({
        location,
        kind: raw.kind != null ? String(raw.kind) : undefined,
        params: Array.isArray(raw.params)
          ? raw.params.map((x) => String(x ?? "").trim()).filter(Boolean)
          : undefined,
        auth: raw.auth != null ? String(raw.auth) : undefined,
        note: raw.note != null ? String(raw.note) : undefined,
        status: "seen",
      });
    }
    if (!items.length) {
      const total = await this.count();
      return { added: 0, total };
    }
    let added = 0;
    // Batch in SURFACE_UPSERT_BATCH_MAX chunks
    for (let i = 0; i < items.length; i += SURFACE_UPSERT_BATCH_MAX) {
      const chunk = items.slice(i, i + SURFACE_UPSERT_BATCH_MAX);
      const result = await this.upsert(chunk, {
        source_agent_id: meta?.source_subagent_id,
        source: meta?.source_subagent_id ? "agent" : "import",
        softCapSkip: true,
      });
      if (result.ok) added += result.created;
    }
    const total = await this.count();
    return { added, total };
  }
}
