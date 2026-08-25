/**
 * Surface identity + status pure core (Case Surface ledger Spec #368 / #369 / #379).
 *
 * Pure functions only — no I/O. #370 (SQLite store / surface tool) consumes this contract.
 *
 * Identity:
 *   origin_key = scheme://host:port  (scheme/host lowercased; port always explicit)
 *   surface row key = origin_key + path_key
 *   path_key = HTTP(S) pathname normalized (no query/fragment); empty for non-HTTP
 *   methods[] / params[] merge on same identity — not part of primary key
 *
 * Status (v2 D3): seen → touched → booked
 *   - never downgrade on re-upsert
 *   - ordinary upsert cannot set booked (allowBooked / confirm path only)
 *   - ordinary upsert cannot elevate to touched/TESTED without allowTested (Traffic settle) (#411)
 * Expand-contract: accept legacy on read; normalize to v2 on write (see LEGACY_STATUS_MAP).
 */

import { pathKey as httpPathKey } from "../runtime/subagent-booking.js";

/**
 * Normative v2 management statuses (+ optional retained terminals).
 * Write path always stores these (never open/in_probe/probed).
 */
export type SurfaceStatus =
  | "seen"
  | "touched"
  | "booked"
  | "deadend"
  | "skipped_roe";

/** Legacy v1 statuses accepted on read; mapped via LEGACY_STATUS_MAP on write. */
export type LegacySurfaceStatus = "open" | "in_probe" | "probed";

/** Any status string the pure core accepts as input (legacy or v2). */
export type AcceptedSurfaceStatus = SurfaceStatus | LegacySurfaceStatus;

/** Normative write vocabulary (Spec D3). */
export const SURFACE_STATUSES_V2: readonly SurfaceStatus[] = [
  "seen",
  "touched",
  "booked",
] as const;

/**
 * Write statuses: v2 + optional terminals retained from v1.
 * Choice (#379): deadend / skipped_roe are optional terminals (same rank as touched),
 * not collapsed to touched+tag.
 */
export const SURFACE_STATUSES: readonly SurfaceStatus[] = [
  "seen",
  "touched",
  "booked",
  "deadend",
  "skipped_roe",
] as const;

/** Legacy strings still accepted on read / inbound payloads. */
export const LEGACY_SURFACE_STATUSES: readonly LegacySurfaceStatus[] = [
  "open",
  "in_probe",
  "probed",
] as const;

/**
 * Expand-contract migration map (read accept → write normalize).
 * open→seen, in_probe/probed→touched, booked→booked;
 * deadend/skipped_roe retained as optional terminals (identity map).
 */
export const LEGACY_STATUS_MAP: Readonly<Record<string, SurfaceStatus>> = {
  open: "seen",
  in_probe: "touched",
  probed: "touched",
  seen: "seen",
  touched: "touched",
  booked: "booked",
  deadend: "deadend",
  skipped_roe: "skipped_roe",
};

const STATUS_SET: ReadonlySet<string> = new Set(SURFACE_STATUSES);
const ACCEPTED_STATUS_SET: ReadonlySet<string> = new Set([
  ...SURFACE_STATUSES,
  ...LEGACY_SURFACE_STATUSES,
]);

/**
 * Rank for monotonic advance (post-normalize).
 * Peers at same rank cannot lateral-transition (touched ↔ deadend ↔ skipped_roe).
 */
const STATUS_RANK: Record<SurfaceStatus, number> = {
  seen: 0,
  touched: 1,
  deadend: 1,
  skipped_roe: 1,
  booked: 2,
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

/** True for any accepted input status (legacy or write form). */
export function isSurfaceStatus(v: unknown): v is AcceptedSurfaceStatus {
  return typeof v === "string" && ACCEPTED_STATUS_SET.has(v.trim().toLowerCase());
}

/** True only for post-normalize write statuses. */
export function isWriteSurfaceStatus(v: unknown): v is SurfaceStatus {
  return typeof v === "string" && STATUS_SET.has(v.trim().toLowerCase());
}

/**
 * Expand-contract: accept legacy/v2 on read; return write SurfaceStatus or null.
 * Ordinary callers should normalize before persist.
 */
export function normalizeSurfaceStatus(v: unknown): SurfaceStatus | null {
  if (typeof v !== "string") return null;
  const key = v.trim().toLowerCase();
  const mapped = LEGACY_STATUS_MAP[key];
  return mapped ?? null;
}

/** Rank after normalize; unknown → -1. */
export function statusRank(status: AcceptedSurfaceStatus | string): number {
  const n = normalizeSurfaceStatus(status);
  return n != null ? STATUS_RANK[n] : -1;
}

function isHttpScheme(scheme: string): boolean {
  return scheme === "http" || scheme === "https";
}

function kindFromScheme(scheme: string): string {
  return isHttpScheme(scheme) ? "url" : scheme;
}

const ABS_URL_TOKEN_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s,;)\]}>'"]+/gi;
const METHOD_PATH_RE = /^(?:[A-Z]{3,10}\s+)(\/[^\s?#]+)/i;
const PATH_IN_TEXT_RE = /(\/(?:[A-Za-z0-9._~!$&'()*+,;=:@%{}-]|%[0-9A-Fa-f]{2})+)/;

function extractAbsUrlTokens(text: string | null | undefined): string[] {
  const raw = String(text ?? "").trim();
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of raw.matchAll(ABS_URL_TOKEN_RE)) {
    const tok = m[0]!.replace(/[).,;\]'"]+$/g, "");
    if (tok && !seen.has(tok)) {
      seen.add(tok);
      out.push(tok);
    }
  }
  return out;
}

function normalizeBookingPath(path: string | null | undefined): string {
  let p = String(path ?? "").trim();
  if (!p) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) {
    try {
      p = new URL(p).pathname || "/";
    } catch {
      return "";
    }
  }
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.split("?", 1)[0]!.split("#", 1)[0]!;
  while (p.includes("//")) p = p.replaceAll("//", "/");
  if (p !== "/" && p.endsWith("/")) p = p.replace(/\/+$/, "");
  return p.toLowerCase();
}

/** Extract path from method-path / prose finding locations (e.g. `PUT /api/x/{id}`). */
export function pathFromLocationBlob(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const methodPath = METHOD_PATH_RE.exec(s);
  if (methodPath?.[1]) {
    return normalizeBookingPath(methodPath[1].replace(/[).,;\]'"]+$/g, ""));
  }
  if (s.startsWith("/")) {
    const token = s.split("?", 1)[0]!.split("#", 1)[0]!.split(/\s+/, 1)[0]!;
    return normalizeBookingPath(token.replace(/[).,;\]'"]+$/g, ""));
  }
  const inText = PATH_IN_TEXT_RE.exec(s);
  if (inText?.[1]) {
    return normalizeBookingPath(inText[1].replace(/[).,;\]'"]+$/g, ""));
  }
  return "";
}

function cleanHost(host: string | null | undefined): string {
  let h = String(host ?? "")
    .trim()
    .toLowerCase();
  if (!h) return "";
  h = h.replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (h.includes("/")) h = h.split("/", 1)[0]!;
  if (h.includes("@")) h = h.split("@").pop()!;
  if ((h.match(/:/g) || []).length === 1 && !h.startsWith("[")) {
    const [left, right] = h.split(":", 2);
    if (right && /^\d+$/.test(right)) h = left!;
  }
  return h;
}

function parsePortValue(port: string | number | null | undefined): number | null {
  if (port == null || port === "") return null;
  const n = typeof port === "number" ? port : Number.parseInt(String(port).trim(), 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) return null;
  return n;
}

/** Build scheme://host[:port]/path for parseLocation (strong identity composition). */
export function composeHttpLocation(
  host: string,
  port: number,
  path: string,
  scheme?: string | null,
): string {
  const hostS = cleanHost(host);
  if (!hostS) return "";
  let schemeS = String(scheme ?? "")
    .trim()
    .toLowerCase();
  if (schemeS !== "http" && schemeS !== "https") {
    schemeS = port === 443 || port === 8443 ? "https" : "http";
  }
  const hostDisp = hostS.includes(":") ? `[${hostS}]` : hostS;
  const pathS = normalizeBookingPath(path) || "/";
  if ((schemeS === "http" && port === 80) || (schemeS === "https" && port === 443)) {
    return `${schemeS}://${hostDisp}${pathS}`;
  }
  return `${schemeS}://${hostDisp}:${port}${pathS}`;
}

export type ResolveBookingLocationInput = {
  location?: string | null;
  host?: string | null;
  port?: string | number | null;
  locationKey?: string | null;
  proof?: string | null;
  proofExcerpts?: Array<{ excerpt?: string } | string> | null;
  scheme?: string | null;
};

/**
 * Spec #368 D7 / #382: resolve strong surface identity for finding book.
 * Order: absolute URL → host+port+location_key → proof URL.
 */
export function resolveBookingLocation(input: ResolveBookingLocationInput): ParsedLocation {
  const raw = String(input.location ?? "").trim();

  // 1a. Whole location is scheme://…
  if (raw && /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const parsed = parseLocation(raw);
    if (parsed.ok) return parsed;
  }

  // 1b. Absolute URL token embedded in location free-text
  for (const url of extractAbsUrlTokens(raw)) {
    const parsed = parseLocation(url);
    if (parsed.ok) return parsed;
  }

  // 2. host + port + location_key (strong composition)
  const hostS = cleanHost(input.host);
  const portN = parsePortValue(input.port);
  let path = input.locationKey ? normalizeBookingPath(input.locationKey) : "";
  if (!path) path = pathFromLocationBlob(raw);
  if (hostS && portN != null && path) {
    const composed = composeHttpLocation(hostS, portN, path, input.scheme);
    if (composed) {
      const parsed = parseLocation(composed);
      if (parsed.ok) return parsed;
    }
  }

  // 3. Proof absolute URLs
  const proofBlobs: string[] = [];
  if (input.proof != null && String(input.proof).trim()) {
    proofBlobs.push(String(input.proof));
  }
  if (Array.isArray(input.proofExcerpts)) {
    for (const item of input.proofExcerpts) {
      if (item && typeof item === "object" && "excerpt" in item && item.excerpt) {
        proofBlobs.push(String(item.excerpt));
      } else if (typeof item === "string" && item.trim()) {
        proofBlobs.push(item);
      }
    }
  }
  for (const blob of proofBlobs) {
    for (const url of extractAbsUrlTokens(blob)) {
      const parsed = parseLocation(url);
      if (parsed.ok) return parsed;
    }
  }

  if (!raw && !hostS) return { ok: false, error: "empty location" };
  return {
    ok: false,
    error:
      "unresolvable location (need absolute URL, or host+port+location_key, or proof URL)",
  };
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
 * Whether a status transition is allowed (inputs may be legacy; compared post-normalize).
 * Same status is allowed (no-op). Downgrades and same-rank laterals are refused.
 * Transition into `booked` requires `{ allowBooked: true }`.
 */
export function canTransitionStatus(
  from: AcceptedSurfaceStatus | string,
  to: AcceptedSurfaceStatus | string,
  opts?: StatusTransitionOpts,
): boolean {
  const fromN = normalizeSurfaceStatus(from);
  const toN = normalizeSurfaceStatus(to);
  if (fromN == null || toN == null) return false;
  if (toN === "booked" && !opts?.allowBooked) return false;
  if (fromN === toN) return true;
  const fromR = STATUS_RANK[fromN];
  const toR = STATUS_RANK[toN];
  if (toR < fromR) return false;
  // Same rank, different peer (touched ↔ deadend ↔ skipped_roe): no lateral.
  if (toR === fromR) return false;
  return true;
}

/**
 * Apply a forward status change when allowed; otherwise keep normalized `from`.
 * Use `{ allowBooked: true }` only from the finding booking / confirm path.
 * Always returns a write SurfaceStatus (legacy inputs normalized).
 */
export function applyStatusAdvance(
  from: AcceptedSurfaceStatus | string,
  to: AcceptedSurfaceStatus | string,
  opts?: StatusTransitionOpts,
): { status: SurfaceStatus; changed: boolean } {
  const fromN = normalizeSurfaceStatus(from) ?? "seen";
  const toN = normalizeSurfaceStatus(to);
  if (toN == null || !canTransitionStatus(fromN, toN, opts)) {
    return { status: fromN, changed: false };
  }
  if (fromN === toN) return { status: fromN, changed: false };
  return { status: toN, changed: true };
}

export type ResolveUpsertStatusOpts = {
  /**
   * Allow advance to `touched` (operator TESTED). Traffic settle only (#411).
   * Ordinary Agent upsert must not fake TESTED without real traffic.
   */
  allowTested?: boolean;
};

/**
 * Status resolution for ordinary surface upsert / settle (not booking).
 * - New row defaults to `seen` when request omitted/invalid.
 * - Requested `booked` is ignored (stays existing or `seen`).
 * - Requested `touched` (TESTED) requires `{ allowTested: true }` — Traffic settle.
 *   Without it, elevation to touched is refused (existing rank preserved; new rows → seen).
 * - Legacy requested/existing values are normalized (open→seen, in_probe/probed→touched).
 * - Never downgrades an existing status.
 * - Terminals deadend / skipped_roe are ignored on upsert (#518 — use surface skip).
 */
export function resolveUpsertStatus(
  existing: AcceptedSurfaceStatus | string | undefined,
  requested?: AcceptedSurfaceStatus | string | null,
  opts?: ResolveUpsertStatusOpts,
): SurfaceStatus {
  let want: SurfaceStatus = "seen";
  if (requested != null) {
    const reqN = normalizeSurfaceStatus(requested);
    if (reqN != null && reqN !== "booked") {
      want = reqN;
    }
  }
  // Agent upsert cannot elevate to touched without traffic
  if (want === "touched" && !opts?.allowTested) {
    want = "seen";
  }
  if (want === "deadend" || want === "skipped_roe") {
    want = existing != null && existing !== "" ? (normalizeSurfaceStatus(existing) ?? "seen") : "seen";
  }
  if (existing == null || existing === "") return want;
  const existingN = normalizeSurfaceStatus(existing);
  if (existingN == null) return want;
  return applyStatusAdvance(existingN, want).status;
}
