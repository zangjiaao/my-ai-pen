/**
 * Surface identity + status pure core (Case Surface ledger Spec #368 / issue #369).
 *
 * Pure functions only — no I/O. #370 (SQLite store / surface tool) consumes this contract.
 *
 * Identity:
 *   origin_key = scheme://host:port  (scheme/host lowercased; port always explicit)
 *   surface row key = origin_key + path_key
 *   path_key = HTTP(S) pathname normalized (no query/fragment); empty for non-HTTP
 *   methods[] / params[] merge on same identity — not part of primary key
 *
 * Status: open → in_probe → probed | booked | deadend | skipped_roe
 *   - never downgrade on re-upsert
 *   - ordinary upsert cannot set booked (booking path only)
 */

import { pathKey as httpPathKey } from "../runtime/subagent-booking.js";

export type SurfaceStatus =
  | "open"
  | "in_probe"
  | "probed"
  | "booked"
  | "deadend"
  | "skipped_roe";

export const SURFACE_STATUSES: readonly SurfaceStatus[] = [
  "open",
  "in_probe",
  "probed",
  "booked",
  "deadend",
  "skipped_roe",
] as const;

const STATUS_SET: ReadonlySet<string> = new Set(SURFACE_STATUSES);

/** Rank for monotonic advance. Peers at same rank cannot lateral-transition. */
const STATUS_RANK: Record<SurfaceStatus, number> = {
  open: 0,
  in_probe: 1,
  probed: 2,
  deadend: 2,
  skipped_roe: 2,
  booked: 3,
};

/**
 * Well-known default ports. Unknown schemes require an explicit port in the location.
 * Not product-target-specific — generic IANA-style defaults only.
 */
const DEFAULT_PORTS: Readonly<Record<string, number>> = {
  http: 80,
  https: 443,
  ws: 80,
  wss: 443,
  ssh: 22,
  sftp: 22,
  redis: 6379,
  mysql: 3306,
  postgres: 5432,
  postgresql: 5432,
  mongodb: 27017,
  mongo: 27017,
  ftp: 21,
  smtp: 25,
  telnet: 23,
  rdp: 3389,
  mssql: 1433,
  amqp: 5672,
  mqtt: 1883,
  ldap: 389,
  ldaps: 636,
};

export type ParsedLocationOk = {
  ok: true;
  /** scheme://host:port — port always explicit (defaults filled). */
  origin_key: string;
  /** HTTP(S) normalized path (no query/fragment); "" for non-HTTP. */
  path_key: string;
  /** Original trimmed location (display / agent input). */
  location: string;
  scheme: string;
  /** Host as used in origin_key (IPv6 bracketed). */
  host: string;
  port: number;
  /** Derived kind: http(s) → "url"; else scheme. */
  kind: string;
};

export type ParsedLocationErr = {
  ok: false;
  error: string;
};

export type ParsedLocation = ParsedLocationOk | ParsedLocationErr;

export type StatusTransitionOpts = {
  /**
   * When true, allow transition into `booked` (finding booking path only).
   * Ordinary upsert must leave this false / omit it.
   */
  allowBooked?: boolean;
};

export function isSurfaceStatus(v: unknown): v is SurfaceStatus {
  return typeof v === "string" && STATUS_SET.has(v);
}

export function statusRank(status: SurfaceStatus): number {
  return STATUS_RANK[status];
}

function isHttpScheme(scheme: string): boolean {
  return scheme === "http" || scheme === "https";
}

function kindFromScheme(scheme: string): string {
  return isHttpScheme(scheme) ? "url" : scheme;
}

/**
 * Parse a location into origin_key + path_key identity parts.
 * Requires `scheme://…`. Port defaults are filled when the scheme is known.
 */
export function parseLocation(raw: string): ParsedLocation {
  const location = String(raw ?? "").trim();
  if (!location) return { ok: false, error: "empty location" };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(location)) {
    return { ok: false, error: "location must include scheme://" };
  }

  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return { ok: false, error: "invalid location URL" };
  }

  const scheme = (url.protocol || "").replace(/:$/, "").toLowerCase();
  if (!scheme) return { ok: false, error: "missing scheme" };

  // IPv6 must appear in bracket form in origin_key. Node's url.hostname may already
  // include brackets (current) or return bare hex (some runtimes) — normalize once.
  const hostname = (url.hostname || "").toLowerCase();
  if (!hostname) return { ok: false, error: "missing host" };
  let host: string;
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    host = hostname;
  } else if (hostname.includes(":")) {
    host = `[${hostname}]`;
  } else {
    host = hostname;
  }

  let port: number;
  if (url.port) {
    port = Number.parseInt(url.port, 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      return { ok: false, error: "invalid port" };
    }
  } else if (DEFAULT_PORTS[scheme] != null) {
    port = DEFAULT_PORTS[scheme]!;
  } else {
    return { ok: false, error: `missing port for scheme ${scheme}` };
  }

  const origin_key = `${scheme}://${host}:${port}`;

  let path_key = "";
  if (isHttpScheme(scheme)) {
    // Reuse booking pathKey: lowercase path, strip query/fragment, trailing-slash rules.
    path_key = httpPathKey(location);
  }

  return {
    ok: true,
    origin_key,
    path_key,
    location,
    scheme,
    host,
    port,
    kind: kindFromScheme(scheme),
  };
}

/**
 * Stable composite row key for origin + path identity.
 * HTTP: `https://h:443/api/users` · non-HTTP: origin only.
 */
export function surfaceRowKey(origin_key: string, path_key: string): string {
  const origin = String(origin_key || "").trim();
  const path = String(path_key || "").trim();
  if (!path) return origin;
  return path.startsWith("/") ? `${origin}${path}` : `${origin}/${path}`;
}

/** Union merge for HTTP methods (uppercased, first-seen order). */
export function mergeMethods(
  a?: readonly string[] | null,
  b?: readonly string[] | null,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const src of [a, b]) {
    if (!src) continue;
    for (const raw of src) {
      const m = String(raw ?? "")
        .trim()
        .toUpperCase();
      if (!m || seen.has(m)) continue;
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}

/** Union merge for param names (trimmed, case-sensitive, first-seen order). */
export function mergeParams(
  a?: readonly string[] | null,
  b?: readonly string[] | null,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const src of [a, b]) {
    if (!src) continue;
    for (const raw of src) {
      const p = String(raw ?? "").trim();
      if (!p || seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/**
 * Whether a status transition is allowed.
 * Same status is allowed (no-op). Downgrades and same-rank laterals are refused.
 * Transition into `booked` requires `{ allowBooked: true }`.
 */
export function canTransitionStatus(
  from: SurfaceStatus,
  to: SurfaceStatus,
  opts?: StatusTransitionOpts,
): boolean {
  if (!isSurfaceStatus(from) || !isSurfaceStatus(to)) return false;
  if (to === "booked" && !opts?.allowBooked) return false;
  if (from === to) return true;
  const fromR = STATUS_RANK[from];
  const toR = STATUS_RANK[to];
  if (toR < fromR) return false;
  // Same rank, different terminal (probed ↔ deadend ↔ skipped_roe): no lateral.
  if (toR === fromR) return false;
  return true;
}

/**
 * Apply a forward status change when allowed; otherwise keep `from`.
 * Use `{ allowBooked: true }` only from the finding booking path.
 */
export function applyStatusAdvance(
  from: SurfaceStatus,
  to: SurfaceStatus,
  opts?: StatusTransitionOpts,
): { status: SurfaceStatus; changed: boolean } {
  if (!canTransitionStatus(from, to, opts)) {
    return { status: from, changed: false };
  }
  if (from === to) return { status: from, changed: false };
  return { status: to, changed: true };
}

/**
 * Status resolution for ordinary surface upsert (not booking).
 * - New row defaults to `open` when request omitted/invalid.
 * - Requested `booked` is ignored (stays existing or `open`).
 * - Never downgrades an existing status.
 */
export function resolveUpsertStatus(
  existing: SurfaceStatus | undefined,
  requested?: SurfaceStatus | null,
): SurfaceStatus {
  let want: SurfaceStatus = "open";
  if (requested != null && isSurfaceStatus(requested) && requested !== "booked") {
    want = requested;
  }
  if (existing == null) return want;
  return applyStatusAdvance(existing, want).status;
}
