/**
 * Spec #368 D8 / issue #381 — TARGET + scope.allow seed at task start.
 *
 * Seeds web origins (and path `/`) into Surface SQLite as status **seen**,
 * source=target_seed, without Agent upsert or prior traffic.
 * Online: dual-write via existing surface_upsert path (#374).
 */

import {
  SURFACE_UPSERT_BATCH_MAX,
  type SurfaceRow,
  type SurfaceUpsertItem,
} from "../stores/surface-sqlite.js";
import { parseLocation } from "../stores/surface-identity.js";
import type { ToolRuntime } from "../types.js";
import {
  enqueueSurfacePlatformSync,
  isSurfacePlatformOnline,
} from "./surface-platform-sync.js";

export type TargetSeedLocation = {
  /** Canonical location for upsert: origin_key + `/` for HTTP(S). */
  location: string;
  origin_key: string;
  path_key: "/";
};

export type TargetSeedResult = {
  /** Distinct web origins considered for seed. */
  seeded: number;
  created: number;
  updated: number;
  locations: string[];
  platform_sync: "offline" | "pending";
  upserted: SurfaceRow[];
};

/**
 * Parse a raw string into a web origin seed row (always path `/`).
 * - Requires http(s) after optional bare-host coerce.
 * - Non-HTTP schemes, wildcards, and unparseable strings are skipped.
 */
export function tryParseWebSeedLocation(
  raw: string,
  opts?: { coerceBare?: boolean },
): TargetSeedLocation | null {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  // Reject wildcard / glob scope entries even if scheme present.
  if (s.includes("*")) return null;

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (!opts?.coerceBare) return null;
    // Bare host or host/path — product targets often omit scheme (see resolveTargetUrl).
    if (/\s/.test(s)) return null;
    s = `http://${s.replace(/^\/\//, "")}`;
  }

  const parsed = parseLocation(s);
  if (!parsed.ok) return null;
  if (parsed.scheme !== "http" && parsed.scheme !== "https") return null;

  const path_key = "/" as const;
  // location uses explicit port so identity matches parseLocation on re-upsert.
  const location = `${parsed.origin_key}/`;
  return {
    location,
    origin_key: parsed.origin_key,
    path_key,
  };
}

/**
 * Collect distinct web origin seeds from task.target + scope.allow.
 * Pure — no I/O.
 */
export function collectTargetSeedLocations(task: {
  target?: Record<string, unknown>;
  scope?: Record<string, unknown>;
}): TargetSeedLocation[] {
  const byOrigin = new Map<string, TargetSeedLocation>();

  const add = (raw: string, coerceBare: boolean): void => {
    const loc = tryParseWebSeedLocation(raw, { coerceBare });
    if (!loc) return;
    byOrigin.set(loc.origin_key, loc);
  };

  const target = task.target && typeof task.target === "object" ? task.target : {};
  const tval = String(
    (target as { value?: unknown }).value
      ?? (target as { url?: unknown }).url
      ?? (target as { host?: unknown }).host
      ?? "",
  ).trim();
  if (tval) {
    const type = String((target as { type?: unknown }).type ?? "")
      .toLowerCase()
      .trim();
    // Coerce bare host for url/web targets and when type omitted (common envelope).
    const coerceBare =
      !type || type === "url" || type === "web" || type === "http" || type === "https";
    add(tval, coerceBare);
  }

  const allow =
    task.scope && typeof task.scope === "object"
      ? (task.scope as { allow?: unknown }).allow
      : undefined;
  if (Array.isArray(allow)) {
    for (const item of allow) {
      // Scope allow: only entries that already parse as web origins (scheme required).
      add(String(item ?? ""), false);
    }
  }

  return [...byOrigin.values()];
}

/**
 * Host task-start seed: upsert TARGET / scope.allow web roots as seen.
 * Idempotent (never downgrades; re-seed on continue is a no-op advance).
 * Failures must not block task start — callers may catch.
 */
export async function seedSurfacesFromTargetAtTaskStart(
  runtime: ToolRuntime,
): Promise<TargetSeedResult> {
  const empty: TargetSeedResult = {
    seeded: 0,
    created: 0,
    updated: 0,
    locations: [],
    platform_sync: "offline",
    upserted: [],
  };

  const store = runtime.surfaceSqlite;
  if (!store) return empty;

  const locations = collectTargetSeedLocations(runtime.task);
  if (!locations.length) return empty;

  await store.open();

  const platformOnline = isSurfacePlatformOnline(runtime);
  const items: SurfaceUpsertItem[] = locations.map((l) => ({
    location: l.location,
    status: "seen",
    source: "target_seed",
    kind: "url",
  }));

  let created = 0;
  let updated = 0;
  const upserted: SurfaceRow[] = [];

  for (let i = 0; i < items.length; i += SURFACE_UPSERT_BATCH_MAX) {
    const chunk = items.slice(i, i + SURFACE_UPSERT_BATCH_MAX);
    const result = await store.upsert(chunk, {
      source: "target_seed",
      platformOnline,
      softCapSkip: true,
    });
    if (!result.ok) continue;
    created += result.created;
    updated += result.updated;
    upserted.push(...result.upserted);
  }

  if (platformOnline && upserted.length) {
    void enqueueSurfacePlatformSync(runtime, upserted);
  }

  return {
    seeded: locations.length,
    created,
    updated,
    locations: locations.map((l) => l.location),
    platform_sync: platformOnline ? "pending" : "offline",
    upserted,
  };
}
