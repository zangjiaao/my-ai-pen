/**
 * Attack surface inventory pure model (parse / collect / attach / resolve).
 */
import type { PlanNode } from "./panelTypes";
import type { SecurityVulnerability } from "./securityTypes";
import {
  classifyFindingKind,
  toSurfaceFindingTagForKind,
  type SurfaceFindingTag,
} from "./findingKinds";

export type SurfaceEntry = {
  key: string;
  host: string;
  port: string;
  origin: string;
  service: string;
  path: string;
  method: string | null;
  source?: string;
  title?: string;
  /** Stable group for one logical asset (merges IP / private / docker aliases). */
  assetKey?: string;
  /** Root label shown in the tree (asset name or primary host). */
  assetLabel?: string;
  /** Other hostnames/IPs observed for the same asset. */
  hostAliases?: string[];
  /** Authorized engagement target (from task.target / scope.allow). */
  isTarget?: boolean;
  /** Discovered later (SSRF/internal/out-of-scope probe) — not the user TARGET. */
  isDiscovered?: boolean;
  /** Case surface_ledger status (v2 internal: seen | touched | booked; legacy mapped on project). */
  status?: string;
  /**
   * Spec #409 / inventory novelty: true only when Case row / join flags first inventory admit.
   * False-safe until durable inventory (#410) lands — absent/undefined ⇒ not NEW.
   */
  isNew?: boolean;
  /** URL scheme from origin_key (http/https/ssh/…). */
  scheme?: string;
  /**
   * Spec D2 tree root: normalized `scheme://host:port`.
   * Different ports are different objects (not collapsed under bare host).
   */
  originKey?: string;
};

/**
 * Spec #368 / #379 / #384 — Surface status vocabulary (D3).
 * Write form: seen → touched → booked (+ optional deadend / skipped_roe).
 * Legacy open / in_probe / probed accepted on read and mapped for display.
 */
export const SURFACE_STATUS_LEGACY_MAP: Record<string, string> = {
  open: "seen",
  in_probe: "touched",
  probed: "touched",
  seen: "seen",
  touched: "touched",
  booked: "booked",
  deadend: "deadend",
  skipped_roe: "skipped_roe",
};

/** Rank after normalize (monotonic advance; peers do not lateral). */
export const SURFACE_STATUS_RANK: Record<string, number> = {
  seen: 0,
  touched: 1,
  deadend: 1,
  skipped_roe: 1,
  booked: 2,
};

/** Expand-contract: accept legacy/v2 on read; return write/display status or undefined. */
export function normalizeSurfaceStatus(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  const s = String(raw).trim().toLowerCase();
  if (!s) return undefined;
  return SURFACE_STATUS_LEGACY_MAP[s];
}

/**
 * Prefer the higher-rank status (post-normalize). Never “downgrade” when merging
 * live surface_upsert rows or projected entries.
 */
export function preferSurfaceStatus(
  a?: string | null,
  b?: string | null,
): string | undefined {
  const na = normalizeSurfaceStatus(a);
  const nb = normalizeSurfaceStatus(b);
  if (!na) return nb;
  if (!nb) return na;
  const ra = SURFACE_STATUS_RANK[na] ?? -1;
  const rb = SURFACE_STATUS_RANK[nb] ?? -1;
  return rb > ra ? nb : na;
}

/**
 * Spec #409 / L1 L6 — operator-facing status chip label (not internal v2 write form).
 *
 * | Internal (normalize) | Operator chip |
 * |----------------------|---------------|
 * | touched (+ legacy in_probe/probed) | TESTED |
 * | seen (+ legacy open) | *(none — quiet)* |
 * | booked | *(none — finding tags only)* |
 * | deadend / skipped_roe | retained muted terminal |
 *
 * Never returns SEEN, BOOK, BOOKED, or PRIOR.
 */
export function surfaceStatusLabel(status?: string | null): string {
  const n = normalizeSurfaceStatus(status);
  if (!n) return "";
  if (n === "touched") return "TESTED";
  if (n === "deadend") return "deadend";
  if (n === "skipped_roe") return "skipped_roe";
  // seen, booked: no operator status chip
  return "";
}

/**
 * True when operator UI should render a status chip for this internal status.
 * Collapsed parents still suppress chips via tree chrome (#408).
 */
export function surfaceShowsStatusChip(status?: string | null): boolean {
  return Boolean(surfaceStatusLabel(status));
}

/**
 * Spec #409 — NEW badge only when novelty flag is explicitly true.
 * Absent / null / unknown ⇒ false (safe until inventory #410).
 */
export function isSurfaceNew(row: { is_new?: unknown; isNew?: unknown } | null | undefined): boolean {
  if (!row || typeof row !== "object") return false;
  const flag = (row as { is_new?: unknown; isNew?: unknown }).is_new ?? (row as { isNew?: unknown }).isNew;
  if (flag === undefined || flag === null || flag === "") return false;
  return flag === true || flag === 1 || flag === "true" || flag === "1";
}

/** Tailwind badge classes for operator Surface status chips (TESTED / terminals). */
export function surfaceStatusBadgeClass(status?: string | null): string {
  const n = normalizeSurfaceStatus(status);
  if (n === "touched") return "bg-status-running/12 text-status-running";
  if (n === "deadend" || n === "skipped_roe") return "bg-canvas-inset text-ink-muted";
  // Fallback when a label is still rendered (should not be seen/booked after #409)
  return "bg-canvas-inset text-ink-secondary";
}

/**
 * Spec #368 / #375 — Case surface_ledger document (Platform snapshot + WS).
 * UI Surface tab projects only this SoT (D10).
 */
export type SurfaceLedgerRow = {
  id?: string;
  origin_key?: string;
  path_key?: string;
  location?: string;
  kind?: string;
  methods?: string[];
  params?: string[];
  auth?: string | null;
  status?: string;
  note?: string | null;
  source?: string;
  source_agent_id?: string;
  updated_at?: string;
  created_at?: string;
  conversation_id?: string;
  [key: string]: unknown;
};

export type SurfaceLedger = {
  version?: number;
  updated_at?: string | null;
  surfaces: SurfaceLedgerRow[];
};

/** Honest empty Case surface ledger (empty panel is correct). */
export function emptySurfaceLedger(): SurfaceLedger {
  return { version: 1, updated_at: null, surfaces: [] };
}

/** Normalize snapshot / WS payload into a SurfaceLedger (missing → empty). */
export function ensureSurfaceLedger(raw: unknown): SurfaceLedger {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptySurfaceLedger();
  const doc = raw as Record<string, unknown>;
  const surfaces = Array.isArray(doc.surfaces)
    ? (doc.surfaces as SurfaceLedgerRow[]).filter((s) => s && typeof s === "object")
    : [];
  const version = Number(doc.version);
  return {
    version: Number.isFinite(version) && version > 0 ? version : 1,
    updated_at: doc.updated_at != null ? String(doc.updated_at) : null,
    surfaces,
  };
}

/** Identity for Case ledger rows: origin_key + path_key (D2). */
export function surfaceLedgerIdentity(row: Pick<SurfaceLedgerRow, "origin_key" | "path_key">): string {
  const origin = String(row.origin_key || "").trim().toLowerCase();
  const path = String(row.path_key ?? "").trim();
  if (!origin) return "";
  if (!path) return origin;
  return path.startsWith("/") ? `${origin}${path}` : `${origin}/${path}`;
}

/**
 * Merge WS `surface_upsert` rows into the Case ledger by origin_key+path_key.
 * Later fields enrich; methods union. Does not invent rows from assets/plan.
 */
export function upsertSurfaceLedger(
  ledger: SurfaceLedger | null | undefined,
  incoming: { surfaces?: SurfaceLedgerRow[]; updated_at?: string | null },
): SurfaceLedger {
  const base = ensureSurfaceLedger(ledger);
  const rows = Array.isArray(incoming?.surfaces) ? incoming.surfaces : [];
  if (!rows.length) {
    if (incoming?.updated_at != null) {
      return { ...base, updated_at: String(incoming.updated_at) };
    }
    return base;
  }
  const byKey = new Map<string, SurfaceLedgerRow>();
  for (const s of base.surfaces) {
    const k = surfaceLedgerIdentity(s);
    if (k) byKey.set(k, s);
  }
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const k = surfaceLedgerIdentity(raw);
    if (!k) continue;
    const prev = byKey.get(k);
    if (!prev) {
      byKey.set(k, { ...raw });
      continue;
    }
    const methods = mergeStringList(
      Array.isArray(prev.methods) ? prev.methods.map(String) : [],
      Array.isArray(raw.methods) ? raw.methods.map(String) : [],
    );
    const params = mergeStringList(
      Array.isArray(prev.params) ? prev.params.map(String) : [],
      Array.isArray(raw.params) ? raw.params.map(String) : [],
    );
    // Spec #384 / D3: never downgrade status on live merge (seen→touched→booked).
    const status =
      preferSurfaceStatus(
        prev.status != null ? String(prev.status) : null,
        raw.status != null ? String(raw.status) : null,
      ) ??
      (raw.status != null ? String(raw.status) : undefined) ??
      (prev.status != null ? String(prev.status) : undefined);
    byKey.set(k, {
      ...prev,
      ...raw,
      origin_key: prev.origin_key || raw.origin_key,
      path_key: prev.path_key != null && prev.path_key !== "" ? prev.path_key : raw.path_key,
      methods: methods.length ? methods : prev.methods || raw.methods,
      params: params.length ? params : prev.params || raw.params,
      id: prev.id || raw.id,
      created_at: prev.created_at || raw.created_at,
      ...(status != null ? { status } : {}),
    });
  }
  return {
    version: base.version || 1,
    updated_at:
      incoming?.updated_at != null
        ? String(incoming.updated_at)
        : base.updated_at ?? null,
    surfaces: Array.from(byKey.values()).sort((a, b) =>
      surfaceLedgerIdentity(a).localeCompare(surfaceLedgerIdentity(b)),
    ),
  };
}

/**
 * Spec #375 D10: project Surface inventory from Case surface_ledger only.
 * Empty ledger ⇒ empty list (honest empty panel). No assets/plan/target seed.
 */
export function projectSurfaceEntriesFromLedger(ledger: SurfaceLedger | null | undefined): SurfaceEntry[] {
  const doc = ensureSurfaceLedger(ledger);
  const byKey = new Map<string, SurfaceEntry>();
  for (const row of doc.surfaces) {
    const entry = ledgerRowToSurfaceEntry(row);
    if (!entry) continue;
    const existing = byKey.get(entry.key.toLowerCase());
    if (!existing) {
      byKey.set(entry.key.toLowerCase(), entry);
      continue;
    }
    const methods = mergeMethodList(existing.method, entry.method);
    byKey.set(entry.key.toLowerCase(), {
      ...existing,
      method: methods.length ? methods.join(",") : existing.method,
      source: existing.source || entry.source,
      status: preferSurfaceStatus(existing.status, entry.status) || existing.status || entry.status,
      // Novelty is sticky true once any merge source flags it (false-safe default).
      isNew: Boolean(existing.isNew || entry.isNew),
      title: existing.title || entry.title,
    });
  }
  return Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key));
}

/** Convert one Case ledger row into a tree SurfaceEntry (or null if unusable). */
export function ledgerRowToSurfaceEntry(row: SurfaceLedgerRow): SurfaceEntry | null {
  if (!row || typeof row !== "object") return null;
  const originKey = String(row.origin_key || "").trim();
  const location = String(row.location || "").trim();
  const parsedOrigin = parseOriginKey(originKey) || (location ? parseOriginKeyFromLocation(location) : null);
  if (!parsedOrigin) return null;

  const scheme = parsedOrigin.scheme;
  const isHttp =
    scheme === "http" ||
    scheme === "https" ||
    scheme === "ws" ||
    scheme === "wss" ||
    String(row.kind || "").toLowerCase() === "url";

  let pathKey = String(row.path_key ?? "").trim();
  if (isHttp) {
    if (!pathKey && location) {
      try {
        const u = new URL(location.includes("://") ? location : `http://x${location.startsWith("/") ? location : `/${location}`}`);
        pathKey = u.pathname || "/";
      } catch {
        pathKey = pathKey || "/";
      }
    }
    pathKey = pathKey || "/";
    if (pathKey.length > 1) pathKey = pathKey.replace(/\/+$/, "") || "/";
    if (!pathKey.startsWith("/")) pathKey = `/${pathKey}`;
  } else {
    pathKey = "";
  }

  const service = isHttp
    ? "web"
    : normalizeServiceName(String(row.kind || scheme || "unknown")) || scheme || "unknown";

  const methods = Array.isArray(row.methods)
    ? mergeMethodList(...row.methods.map((m) => String(m || "")))
    : [];
  const methodStr = methods.join(",");
  const originDisplay = parsedOrigin.port
    ? `${parsedOrigin.host}:${parsedOrigin.port}`
    : parsedOrigin.host;
  const originKeyNorm =
    originKey ||
    (parsedOrigin.port
      ? `${scheme}://${parsedOrigin.host}:${parsedOrigin.port}`
      : `${scheme}://${parsedOrigin.host}`);
  const entry = toSurfaceEntry(
    {
      host: parsedOrigin.host,
      port: parsedOrigin.port,
      origin: originDisplay,
      path: isHttp ? pathKey || "/" : "",
      service,
      method: methods[0] || "",
    },
    {
      source: String(row.source || "ledger"),
      title: location || undefined,
    },
  );
  if (methodStr) entry.method = methodStr;
  entry.scheme = scheme;
  entry.originKey = originKeyNorm.toLowerCase();
  // Tree root identity = origin_key (scheme://host:port), not bare host.
  entry.assetKey = entry.originKey;
  entry.assetLabel = originKeyNorm;
  // Spec #384: project v2 internal status; map legacy open/in_probe/probed.
  // Operator chips (TESTED / quiet / no BOOK) apply at display via surfaceStatusLabel (#409).
  const status = normalizeSurfaceStatus(row.status);
  if (status) entry.status = status;
  // Spec #409: NEW only when ledger/join explicitly flags first inventory admit (false-safe).
  if (isSurfaceNew(row)) entry.isNew = true;
  return entry;
}

/** Parse `scheme://host:port` origin_key (port always explicit per D2). */
function parseOriginKey(originKey: string): { scheme: string; host: string; port: string } | null {
  const raw = String(originKey || "").trim();
  if (!raw) return null;
  const m = raw.match(/^([a-z][a-z0-9+.-]*):\/\/(\[[^\]]+\]|[^/:]+):(\d{1,5})$/i);
  if (m) {
    let host = m[2];
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
    return { scheme: m[1].toLowerCase(), host, port: m[3] };
  }
  try {
    const u = new URL(raw);
    const scheme = (u.protocol || "").replace(":", "").toLowerCase();
    const host = u.hostname || "";
    const port = u.port || "";
    if (!scheme || !host) return null;
    return { scheme, host, port };
  } catch {
    return null;
  }
}

function parseOriginKeyFromLocation(location: string): { scheme: string; host: string; port: string } | null {
  try {
    const u = new URL(String(location || "").trim());
    const scheme = (u.protocol || "").replace(":", "").toLowerCase();
    const host = u.hostname || "";
    if (!scheme || !host) return null;
    let port = u.port || "";
    if (!port) {
      if (scheme === "https" || scheme === "wss") port = "443";
      else if (scheme === "http" || scheme === "ws") port = "80";
      else if (scheme === "ssh") port = "22";
      else if (scheme === "redis") port = "6379";
      else if (scheme === "mysql") port = "3306";
    }
    return { scheme, host, port };
  } catch {
    return null;
  }
}

/** Parsed engagement targets for Surface classification. */
export type EngagementTarget = {
  raw: string;
  host: string;
  port: string;
  origin: string;
};

export type ParsedSurfaceRef = {
  host: string;
  port: string;
  origin: string;
  path: string;
  service: string;
  method: string;
};

/** Legacy adapter for kanban totals (counts inventory size). */
export function attackSurfaceItems(nodes: PlanNode[], findings: Array<Record<string, unknown>> = []): PlanNode[] {
  return collectSurfaceEntries(nodes, [], findings, []).map((e) => ({
    endpoint: e.key,
    method: e.method,
    title: e.title || e.key,
    kind: "surface",
    level: "work_item",
    source: e.source,
  }));
}

export function parseEngagementTargets(taskContext?: Record<string, unknown>): EngagementTarget[] {
  if (!taskContext) return [];
  const values: string[] = [];
  const target = taskContext.target;
  if (typeof target === "string" && target.trim()) values.push(target.trim());
  if (target && typeof target === "object") {
    const v = String((target as Record<string, unknown>).value || (target as Record<string, unknown>).url || "").trim();
    if (v) values.push(v);
  }
  const scope = taskContext.scope;
  if (scope && typeof scope === "object") {
    const allow = (scope as Record<string, unknown>).allow;
    if (Array.isArray(allow)) {
      for (const a of allow) if (typeof a === "string" && a.trim()) values.push(a.trim());
    }
  }
  // Per host: keep every distinct port; host-only collapses when a ported form exists.
  // Distinct ports must all remain so assetPortAllowed does not drop legitimate ports.
  const byHost = new Map<string, EngagementTarget[]>();
  for (const raw of values) {
    const parsed = parseSurfaceRef(raw);
    if (!parsed || !parsed.host) continue;
    const origin = parsed.port ? `${parsed.host}:${parsed.port}` : parsed.host;
    const hostKey = parsed.host.toLowerCase();
    const next: EngagementTarget = { raw, host: parsed.host, port: parsed.port, origin };
    const list = byHost.get(hostKey) || [];
    if (!next.port) {
      // Host-only: keep only if we have no ported target yet.
      if (list.some((t) => t.port)) continue;
      if (list.some((t) => !t.port)) continue;
      list.push(next);
      byHost.set(hostKey, list);
      continue;
    }
    // Ported: drop any host-only rows, then add if this port is new.
    const withoutHostOnly = list.filter((t) => t.port);
    if (withoutHostOnly.some((t) => t.port === next.port)) {
      byHost.set(hostKey, withoutHostOnly);
      continue;
    }
    withoutHostOnly.push(next);
    byHost.set(hostKey, withoutHostOnly);
  }
  return Array.from(byHost.values()).flat();
}

function isEngagementTargetHost(host: string, port: string, targets: EngagementTarget[]): boolean {
  if (!targets.length || !host) return false;
  const h = host.toLowerCase();
  for (const t of targets) {
    if (t.host.toLowerCase() !== h) continue;
    // Port match when both known; host-only target matches any port on that host.
    if (!t.port || !port || t.port === port) return true;
  }
  return false;
}

function isEngagementTargetOrigin(origin: string, targets: EngagementTarget[]): boolean {
  if (!targets.length || !origin) return false;
  const o = origin.toLowerCase();
  return targets.some((t) => t.origin.toLowerCase() === o || t.host.toLowerCase() === o.split(":")[0]);
}

/**
 * Inventory hosts, ports/services, and web routes.
 * Roots are assets; engagement TARGET is preferred and badge-marked.
 */
export function collectSurfaceEntries(
  nodes: PlanNode[],
  assets: Array<Record<string, unknown>> = [],
  findings: Array<Record<string, unknown>> = [],
  engagementTargets: EngagementTarget[] = [],
): SurfaceEntry[] {
  const byKey = new Map<string, SurfaceEntry>();

  const pushParsed = (parsed: ParsedSurfaceRef | null, extra?: Partial<SurfaceEntry>) => {
    if (!parsed) return;
    const entry = toSurfaceEntry(parsed, extra);
    const existing = byKey.get(entry.key.toLowerCase());
    if (!existing) {
      byKey.set(entry.key.toLowerCase(), entry);
      return;
    }
    const methods = mergeMethodList(existing.method, entry.method);
    byKey.set(entry.key.toLowerCase(), {
      ...existing,
      method: methods.length ? methods.join(",") : existing.method,
      source: existing.source || entry.source,
    });
  };

  const considerRaw = (raw: string, method?: string | null, source?: string, serviceHint?: string) => {
    const parsed = parseSurfaceRef(raw, method, serviceHint);
    pushParsed(parsed, { source });
  };

  for (const node of nodes) {
    if ((node.level || "work_item") !== "work_item") continue;
    const kind = String(node.kind || "");
    const blob = `${node.title || ""} ${node.notes || ""} ${node.endpoint || ""}`;
    const serviceHint = inferServiceFromText(blob);
    if (kind === "surface" || kind === "request") {
      considerRaw(String(node.endpoint || node.title || ""), node.method, node.source || "plan", serviceHint);
      continue;
    }
    if (node.endpoint && ["test", "http", "browser", "scan", "traffic", "worker"].includes(kind)) {
      considerRaw(String(node.endpoint), node.method, kind, serviceHint);
    }
    // Port-only discoveries from scan notes: "open 6379/tcp redis"
    for (const m of blob.matchAll(/\b(\d{2,5})\s*\/\s*tcp\b/gi)) {
      const port = m[1];
      const hostMatch = blob.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/) || blob.match(/\b([a-z0-9.-]+\.[a-z]{2,})\b/i);
      const host = hostMatch ? hostMatch[1] : "";
      if (!host) continue;
      const svc = inferServiceFromText(blob) || serviceFromPort(port);
      pushParsed(
        {
          host,
          port,
          origin: `${host}:${port}`,
          path: svc === "web" ? "/" : "",
          service: svc,
          method: "",
        },
        { source: "scan" },
      );
    }
  }

  // Ports declared on the engagement for a host (if any). Stale asset inventory on
  // the same host (e.g. old :8080 DVWA URLs while testing :3000) must not pollute the tree.
  const engagementPortsByHost = new Map<string, Set<string>>();
  for (const t of engagementTargets) {
    const h = String(t.host || "").toLowerCase();
    if (!h) continue;
    if (!engagementPortsByHost.has(h)) engagementPortsByHost.set(h, new Set());
    if (t.port) engagementPortsByHost.get(h)!.add(String(t.port));
  }
  const assetPortAllowed = (host: string, port: string): boolean => {
    const locked = engagementPortsByHost.get(host.toLowerCase());
    if (!locked || locked.size === 0) return true;
    if (!port) return true;
    return locked.has(port);
  };

  // Assets: host + open ports / services + known URLs
  for (const asset of assets) {
    const host = normalizeAssetHost(String(asset.address || asset.name || ""));
    if (!host) continue;
    const props = (asset.properties as Record<string, unknown> | undefined) || {};
    const ports = Array.isArray(asset.open_ports)
      ? asset.open_ports
      : Array.isArray(props.open_ports)
        ? (props.open_ports as unknown[])
        : [];
    const services = Array.isArray(asset.services)
      ? asset.services
      : Array.isArray(props.services)
        ? (props.services as unknown[])
        : [];

    for (const p of ports) {
      const port = String(p).replace(/\/.*$/, "").trim();
      if (!/^\d{1,5}$/.test(port)) continue;
      if (!assetPortAllowed(host, port)) continue;
      let svc = serviceFromPort(port);
      for (const s of services) {
        const rec = s && typeof s === "object" ? (s as Record<string, unknown>) : {};
        const sp = String(rec.port || rec.port_id || "").trim();
        const name = String(rec.name || rec.service || rec.product || "").toLowerCase();
        if (sp === port && name) {
          svc = normalizeServiceName(name) || svc;
        } else if (!sp && name && normalizeServiceName(name) === "web" && serviceFromPort(port) === "web") {
          svc = "web";
        }
      }
      pushParsed(
        {
          host,
          port,
          origin: `${host}:${port}`,
          path: svc === "web" ? "/" : "",
          service: svc,
          method: "",
        },
        { source: "asset" },
      );
    }
    // URLs recorded on the asset (path inventory) — avoid path-only findings forming a second tree.
    const urls = Array.isArray(props.urls) ? props.urls : Array.isArray(asset.urls) ? (asset.urls as unknown[]) : [];
    for (const u of urls) {
      if (typeof u !== "string" || !u.trim()) continue;
      const parsed = parseSurfaceRef(u.trim(), null, "web");
      if (parsed && !assetPortAllowed(parsed.host || host, parsed.port || "")) continue;
      considerRaw(u.trim(), null, "asset-url", "web");
    }
    // Service-level URL notes (e.g. DVWA module links)
    for (const s of services) {
      const rec = s && typeof s === "object" ? (s as Record<string, unknown>) : {};
      const url = String(rec.url || "").trim();
      if (!url) continue;
      const parsed = parseSurfaceRef(url, null, "web");
      if (parsed && !assetPortAllowed(parsed.host || host, parsed.port || "")) continue;
      considerRaw(url, null, "asset-url", "web");
    }
  }

  for (const finding of findings) {
    for (const ref of extractSurfaceRefsFromFinding(finding)) {
      pushParsed(ref, { source: "finding" });
    }
  }

  // Always seed authorized engagement targets so TARGET root exists even before recon.
  for (const t of engagementTargets) {
    pushParsed(
      {
        host: t.host,
        port: t.port,
        origin: t.origin,
        path: "/",
        service: "web",
        method: "",
      },
      { source: "target" },
    );
  }

  // Collapse (target) / public IP / private IP / docker aliases into asset roots.
  return canonicalizeSurfaceEntries(Array.from(byKey.values()), assets, engagementTargets);
}

export function toSurfaceEntry(parsed: ParsedSurfaceRef, extra?: Partial<SurfaceEntry>): SurfaceEntry {
  const path = parsed.service === "web" ? parsed.path || "/" : parsed.path || "";
  const key =
    parsed.service === "web"
      ? `${parsed.origin}|web|${path}`
      : `${parsed.origin}|${parsed.service}`;
  return {
    key,
    host: parsed.host,
    port: parsed.port,
    origin: parsed.origin,
    service: parsed.service,
    path,
    method: parsed.method || null,
    source: extra?.source,
    title:
      parsed.service === "web"
        ? `${parsed.origin}${path === "/" ? "" : path}`
        : `${parsed.origin} (${parsed.service})`,
    assetKey: extra?.assetKey,
    assetLabel: extra?.assetLabel,
    hostAliases: extra?.hostAliases,
  };
}

/**
 * Prefer one root per logical asset so Surface does not splinter into
 * (target) + public IP + junk filenames for the same engagement.
 */
/**
 * Assign stable assetKey/assetLabel roots and fold path-only / alias hosts.
 * Call again after attaching finding-only leaves so they join the same host root
 * (avoids dual trees: asset:uuid vs host:hostname for the same site).
 */
export function canonicalizeSurfaceEntries(
  entries: SurfaceEntry[],
  assets: Array<Record<string, unknown>>,
  engagementTargets: EngagementTarget[] = [],
): SurfaceEntry[] {
  if (!entries.length) return entries;

  type AssetMeta = {
    key: string;
    label: string;
    hosts: Set<string>;
    primaryHost: string;
    primaryPort: string;
  };

  const assetMetas: AssetMeta[] = [];
  const hostToAsset = new Map<string, string>();

  const rememberHost = (host: string, assetKey: string) => {
    const h = host.toLowerCase();
    if (!h || isBogusHostLabel(h)) return;
    hostToAsset.set(h, assetKey);
  };

  for (const asset of assets) {
    const id = String(asset.id || asset.asset_id || asset.address || asset.name || "").trim();
    if (!id) continue;
    const rawAddr = String(asset.address || asset.name || "").trim();
    const host = normalizeAssetHost(rawAddr);
    if (!host) continue;
    let port = "";
    try {
      const withScheme = /^https?:\/\//i.test(rawAddr) ? rawAddr : `http://${rawAddr}`;
      const u = new URL(withScheme);
      port = u.port || "";
    } catch {
      const m = rawAddr.match(/:(\d{2,5})(?:\/|$)/);
      if (m) port = m[1];
    }
    if (!port) {
      // Prefer a known web open_port so path-only findings do not create a second "service" tree.
      port = pickPrimaryWebPortFromAsset(asset);
    }
    // Host tree root is hostname only — ports live under :port children, never on the root label.
    // Do not bake historical asset URL ports (e.g. stale :8080) into the asset display name.
    assetMetas.push({
      key: id,
      label: host,
      hosts: new Set([host.toLowerCase()]),
      primaryHost: host,
      primaryPort: port,
    });
    rememberHost(host, id);
  }

  const pairMerge = maybeMergePairedHosts(entries);
  for (const [secondary, primary] of pairMerge) {
    rememberHost(secondary, hostToAsset.get(primary) || `host:${primary}`);
    if (!hostToAsset.has(primary)) rememberHost(primary, `host:${primary}`);
  }

  // Dominant host by entry count — path-only rows should fold into it.
  const hostCounts = new Map<string, number>();
  let pathOnlyCount = 0;
  for (const e of entries) {
    const h = (e.host || "").toLowerCase();
    if (!h || h === "(target)" || isBogusHostLabel(h)) {
      pathOnlyCount += 1;
      continue;
    }
    const mapped = pairMerge.get(h) || h;
    if (isLocalAliasHost(mapped)) continue;
    hostCounts.set(mapped, (hostCounts.get(mapped) || 0) + 1);
  }
  let dominantHost = "";
  let dominantCount = 0;
  for (const [h, c] of hostCounts) {
    if (c > dominantCount) {
      dominantHost = h;
      dominantCount = c;
    }
  }
  const totalHosted = [...hostCounts.values()].reduce((a, b) => a + b, 0);
  const dominantIsClear =
    Boolean(dominantHost) &&
    (hostCounts.size === 1 ||
      dominantCount >= Math.max(3, Math.ceil(totalHosted * 0.55)) ||
      (pathOnlyCount > 0 && dominantCount >= 1 && hostCounts.size <= 3));

  const localHosts = new Set(
    entries.map((e) => e.host.toLowerCase()).filter((h) => h && isLocalAliasHost(h)),
  );

  let defaultAssetKey = "";
  let defaultAssetLabel = "";
  let defaultPrimaryHost = "";
  let defaultPrimaryPort = "";

  // Engagement TARGET always wins as the default root when present.
  if (engagementTargets.length > 0) {
    const t = engagementTargets[0]!;
    const ak = hostToAsset.get(t.host.toLowerCase());
    const meta = ak ? assetMetas.find((m) => m.key === ak) : undefined;
    if (meta) {
      defaultAssetKey = meta.key;
      defaultAssetLabel = meta.primaryHost || meta.label; // hostname only
      defaultPrimaryHost = meta.primaryHost;
      // This engagement's port wins over stale asset inventory (e.g. old :8080 URLs on same host).
      defaultPrimaryPort = t.port || meta.primaryPort;
    } else {
      defaultAssetKey = `target:${t.host.toLowerCase()}`;
      defaultPrimaryHost = t.host;
      defaultPrimaryPort = t.port;
      defaultAssetLabel = t.host; // hostname only — not origin with :port
    }
    for (const et of engagementTargets) {
      rememberHost(et.host, defaultAssetKey);
    }
    for (const h of localHosts) rememberHost(h, defaultAssetKey);
    // Dominant host that matches target host also maps here.
    if (dominantHost && dominantHost === t.host.toLowerCase()) {
      rememberHost(dominantHost, defaultAssetKey);
    }
  } else if (dominantIsClear) {
    const ak = hostToAsset.get(dominantHost);
    const meta = ak ? assetMetas.find((m) => m.key === ak) : undefined;
    if (meta) {
      defaultAssetKey = meta.key;
      defaultAssetLabel = meta.primaryHost || meta.label;
      defaultPrimaryHost = meta.primaryHost;
      defaultPrimaryPort = meta.primaryPort;
    } else {
      defaultAssetKey = `host:${dominantHost}`;
      defaultPrimaryHost = dominantHost;
      const ports = entries
        .filter((e) => (pairMerge.get(e.host.toLowerCase()) || e.host.toLowerCase()) === dominantHost && e.port)
        .map((e) => e.port);
      defaultPrimaryPort = mostCommon(ports) || "";
      defaultAssetLabel = dominantHost; // hostname only
    }
    for (const h of localHosts) rememberHost(h, defaultAssetKey);
    rememberHost(dominantHost, defaultAssetKey);
  } else if (assetMetas.length === 1) {
    defaultAssetKey = assetMetas[0]!.key;
    defaultAssetLabel = assetMetas[0]!.primaryHost || assetMetas[0]!.label;
    defaultPrimaryHost = assetMetas[0]!.primaryHost;
    defaultPrimaryPort = assetMetas[0]!.primaryPort;
    for (const h of localHosts) rememberHost(h, defaultAssetKey);
  } else if (hostCounts.size === 0 && localHosts.size > 0) {
    const only = [...localHosts][0]!;
    defaultAssetKey = `host:${only}`;
    defaultAssetLabel = only;
    defaultPrimaryHost = only;
    for (const h of localHosts) rememberHost(h, defaultAssetKey);
  }

  const resolveAsset = (
    host: string,
    entryPort?: string,
  ): { key: string; label: string; primaryHost: string; primaryPort: string } => {
    let h = (host || "").toLowerCase();
    if (isBogusHostLabel(h)) h = "";
    if (pairMerge.has(h)) h = pairMerge.get(h)!;

    if (h && hostToAsset.has(h)) {
      const ak = hostToAsset.get(h)!;
      const meta = assetMetas.find((m) => m.key === ak);
      if (meta) {
        // Prefer engagement/default primaryPort over stale asset ports when both exist.
        const port =
          defaultPrimaryPort ||
          entryPort ||
          meta.primaryPort ||
          "";
        return {
          key: meta.key,
          label: meta.primaryHost || meta.label, // hostname only
          primaryHost: meta.primaryHost,
          primaryPort: port,
        };
      }
      if (ak.startsWith("host:") || ak.startsWith("target:")) {
        const ph = ak.includes(":") ? ak.slice(ak.indexOf(":") + 1) : h;
        const hostOnly = ph.split(":")[0] || ph;
        return {
          key: ak,
          label: defaultAssetLabel || hostOnly,
          primaryHost: defaultPrimaryHost || hostOnly,
          primaryPort: defaultPrimaryPort || entryPort || "",
        };
      }
      return { key: ak, label: h, primaryHost: h, primaryPort: entryPort || defaultPrimaryPort || "" };
    }

    if ((!h || h === "(target)" || isLocalAliasHost(h)) && defaultAssetKey) {
      return {
        key: defaultAssetKey,
        label: defaultAssetLabel,
        primaryHost: defaultPrimaryHost,
        primaryPort: defaultPrimaryPort || entryPort || "",
      };
    }

    if (h) {
      if (defaultAssetKey && (isLocalAliasHost(h) || isBogusHostLabel(h))) {
        return {
          key: defaultAssetKey,
          label: defaultAssetLabel,
          primaryHost: defaultPrimaryHost,
          primaryPort: defaultPrimaryPort || entryPort || "",
        };
      }
      // Authorized target host always maps to TARGET asset.
      if (defaultAssetKey && isEngagementTargetHost(h, entryPort || "", engagementTargets)) {
        return {
          key: defaultAssetKey,
          label: defaultAssetLabel,
          primaryHost: defaultPrimaryHost || h,
          primaryPort: defaultPrimaryPort || entryPort || "",
        };
      }
      // With an explicit engagement target, keep other real hosts as discovered (SSRF/out-of-scope).
      // Do not fold 192.x / 172.x into TARGET just because they are sparse.
      if (engagementTargets.length > 0) {
        return {
          key: `discovered:${h}`,
          label: host || h,
          primaryHost: host || h,
          primaryPort: entryPort || "",
        };
      }
      // No engagement target: sparse secondaries may fold into dominant host.
      if (defaultAssetKey && dominantIsClear && (hostCounts.get(h) || 0) <= 2 && dominantCount >= 5) {
        return {
          key: defaultAssetKey,
          label: defaultAssetLabel,
          primaryHost: defaultPrimaryHost,
          primaryPort: defaultPrimaryPort || entryPort || "",
        };
      }
      return { key: `host:${h}`, label: host || h, primaryHost: host || h, primaryPort: entryPort || "" };
    }

    if (defaultAssetKey) {
      return {
        key: defaultAssetKey,
        label: defaultAssetLabel,
        primaryHost: defaultPrimaryHost,
        primaryPort: defaultPrimaryPort || entryPort || "",
      };
    }
    return { key: "host:(target)", label: "(target)", primaryHost: "", primaryPort: "" };
  };

  const aliasesByAsset = new Map<string, Set<string>>();
  const rewritten: SurfaceEntry[] = [];

  for (const e of entries) {
    if (e.host && isBogusHostLabel(e.host)) {
      // Treat filename-like hosts as path-only under default asset.
      const asset = resolveAsset("", e.port);
      const primaryHost = asset.primaryHost;
      const port = e.port || asset.primaryPort;
      const origin = port ? `${primaryHost}:${port}` : primaryHost;
      const path = e.service === "web" ? (e.path && e.path !== "/" ? e.path : `/${e.host}`) : e.path || "";
      const key = e.service === "web" ? `${origin}|web|${path || "/"}` : `${origin}|${e.service}`;
      rewritten.push({
        ...e,
        host: primaryHost,
        port,
        origin,
        path: path || (e.service === "web" ? "/" : ""),
        key,
        assetKey: asset.key,
        assetLabel: asset.label,
      });
      continue;
    }

    const asset = resolveAsset(e.host, e.port);
    if (e.host) {
      const set = aliasesByAsset.get(asset.key) || new Set<string>();
      set.add(e.host);
      aliasesByAsset.set(asset.key, set);
    }
    const primaryHost = asset.primaryHost || e.host || "";
    // Path-only web rows inherit the engagement's primary port when known (e.g. :52799).
    const port =
      e.port ||
      (e.service === "web" && !e.host ? asset.primaryPort : "") ||
      (e.service === "web" && primaryHost === asset.primaryHost ? asset.primaryPort : "") ||
      "";
    const origin = port ? `${primaryHost}:${port}` : primaryHost || e.origin;
    const path = e.service === "web" ? e.path || "/" : e.path || "";
    const key = e.service === "web" ? `${origin}|web|${path}` : `${origin}|${e.service}`;
    const isTarget =
      Boolean(engagementTargets.length) &&
      (isEngagementTargetHost(primaryHost, port, engagementTargets) ||
        isEngagementTargetOrigin(origin, engagementTargets) ||
        asset.key === defaultAssetKey ||
        asset.key.startsWith("target:"));
    const isDiscovered = Boolean(engagementTargets.length) && !isTarget && Boolean(primaryHost);

    rewritten.push({
      ...e,
      host: primaryHost,
      port,
      origin,
      path,
      key,
      assetKey: asset.key,
      assetLabel: asset.label,
      isTarget,
      isDiscovered,
      title:
        e.service === "web"
          ? `${origin}${path === "/" ? "" : path}`
          : `${origin} (${e.service})`,
    });
  }

  const merged = new Map<string, SurfaceEntry>();
  for (const e of rewritten) {
    const k = e.key.toLowerCase();
    const prev = merged.get(k);
    const aliases = [...(aliasesByAsset.get(e.assetKey || "") || new Set())].filter(
      (h) => h && h.toLowerCase() !== (e.host || "").toLowerCase() && !isBogusHostLabel(h),
    );
    if (!prev) {
      merged.set(k, { ...e, hostAliases: aliases });
      continue;
    }
    const methods = mergeMethodList(prev.method, e.method);
    const aliasSet = new Set([...(prev.hostAliases || []), ...aliases]);
    merged.set(k, {
      ...prev,
      method: methods.length ? methods.join(",") : prev.method,
      source: prev.source || e.source,
      hostAliases: [...aliasSet],
      isTarget: prev.isTarget || e.isTarget,
      isDiscovered: (prev.isDiscovered || e.isDiscovered) && !(prev.isTarget || e.isTarget),
    });
  }

  // Collapse empty / scheme-default (80/443) web rows onto the host's dominant
  // explicit web port (e.g. :8080) so host.docker.internal and :80 do not fork
  // a second tree next to host.docker.internal:8080.
  return collapseRedundantWebPorts(Array.from(merged.values()));
}

/** Scheme-default ports invented by URL parse when no :port is written. */
const SCHEME_DEFAULT_PORTS = new Set(["80", "443"]);

function isKnownSurfaceService(name: string): boolean {
  const n = String(name || "").toLowerCase();
  return (
    n === "web" ||
    n === "redis" ||
    n === "ssh" ||
    n === "ftp" ||
    n === "smtp" ||
    n === "mysql" ||
    n === "postgres" ||
    n === "mongodb" ||
    n === "memcached" ||
    n === "elasticsearch" ||
    n === "rabbitmq" ||
    n === "rdp" ||
    n === "smb"
  );
}

/**
 * Path-only / host-only / scheme-default (80/443) web rows split the Surface tree
 * into parallel branches next to :8080 / :3000. Fold them onto the host's
 * dominant explicit web port when one is known.
 *
 * Also reclassifies junk non-web "host-only" rows (service polluted by free-text
 * title blobs) as web roots so they can fold.
 */
function collapseRedundantWebPorts(entries: SurfaceEntry[]): SurfaceEntry[] {
  // Promote host-only junk services → web so they participate in port collapse.
  const normalized = entries.map((e) => {
    if (
      e.host &&
      !e.port &&
      e.service !== "web" &&
      !isKnownSurfaceService(e.service) &&
      (!e.path || e.path === "/")
    ) {
      return {
        ...e,
        service: "web",
        path: "/",
        origin: e.host,
        key: `${e.host}|web|/`,
        title: e.host,
      };
    }
    return e;
  });

  const webPortsByHost = new Map<string, Map<string, number>>();
  for (const e of normalized) {
    if (e.service !== "web" || !e.host || !e.port) continue;
    const h = e.host.toLowerCase();
    const ports = webPortsByHost.get(h) || new Map<string, number>();
    // Prefer ports that already have real paths over bare roots.
    // Explicit non-80/443 ports get a small bonus so docker :8080 beats scheme-default :80.
    const pathWeight = e.path && e.path !== "/" ? 3 : 1;
    const explicitBonus = SCHEME_DEFAULT_PORTS.has(e.port) ? 0 : 2;
    ports.set(e.port, (ports.get(e.port) || 0) + pathWeight + explicitBonus);
    webPortsByHost.set(h, ports);
  }

  const pickDominantPort = (host: string): string => {
    const ports = webPortsByHost.get(host.toLowerCase());
    if (!ports || !ports.size) return "";
    let best = "";
    let n = -1;
    for (const [p, c] of ports) {
      if (c > n) {
        best = p;
        n = c;
      }
    }
    // Prefer common docker/dev web ports when counts are close.
    if (ports.has("8080") && (ports.get("8080") || 0) >= n - 1) return "8080";
    if (ports.has("8000") && (ports.get("8000") || 0) >= n - 1) return "8000";
    if (ports.has("3000") && (ports.get("3000") || 0) >= n - 1) return "3000";
    if (ports.has("80") && (ports.get("80") || 0) >= n - 1) return "80";
    if (ports.has("443") && (ports.get("443") || 0) >= n - 1) return "443";
    return best;
  };

  /** Prefer folding empty / 80 / 443 onto a stronger explicit port when present. */
  const pickFoldTarget = (host: string, currentPort: string): string => {
    const ports = webPortsByHost.get(host.toLowerCase());
    if (!ports || !ports.size) return "";
    const dominant = pickDominantPort(host);
    if (!dominant) return "";
    // Empty → always fold onto dominant when known.
    if (!currentPort) return dominant;
    // Scheme-default only folds when dominant is a different, non-default port
    // with at least as much weight (avoids collapsing real dual 80+443 sites alone).
    if (SCHEME_DEFAULT_PORTS.has(currentPort) && !SCHEME_DEFAULT_PORTS.has(dominant) && dominant !== currentPort) {
      const domW = ports.get(dominant) || 0;
      const curW = ports.get(currentPort) || 0;
      if (domW >= curW) return dominant;
    }
    return "";
  };

  const out = new Map<string, SurfaceEntry>();
  for (const e of normalized) {
    let next = e;
    if (e.service === "web" && e.host) {
      const foldTo = pickFoldTarget(e.host, e.port || "");
      if (foldTo && foldTo !== e.port) {
        const origin = `${e.host}:${foldTo}`;
        const path = e.path || "/";
        next = {
          ...e,
          port: foldTo,
          origin,
          path,
          key: `${origin}|web|${path}`,
          title: `${origin}${path === "/" ? "" : path}`,
        };
      }
    }
    const k = next.key.toLowerCase();
    const prev = out.get(k);
    if (!prev) {
      out.set(k, next);
      continue;
    }
    const methods = mergeMethodList(prev.method, next.method);
    out.set(k, {
      ...prev,
      method: methods.length ? methods.join(",") : prev.method,
      source: prev.source || next.source,
      hostAliases: [...new Set([...(prev.hostAliases || []), ...(next.hostAliases || [])])],
      isTarget: prev.isTarget || next.isTarget,
      isDiscovered: (prev.isDiscovered || next.isDiscovered) && !(prev.isTarget || next.isTarget),
    });
  }
  return Array.from(out.values());
}
function pickPrimaryWebPortFromAsset(asset: Record<string, unknown>): string {
  const props = (asset.properties as Record<string, unknown> | undefined) || {};
  const ports = Array.isArray(asset.open_ports)
    ? asset.open_ports
    : Array.isArray(props.open_ports)
      ? (props.open_ports as unknown[])
      : [];
  const services = Array.isArray(asset.services)
    ? asset.services
    : Array.isArray(props.services)
      ? (props.services as unknown[])
      : [];
  const webPorts: string[] = [];
  for (const p of ports) {
    const port = String(p).replace(/\/.*$/, "").trim();
    if (!/^\d{1,5}$/.test(port)) continue;
    let svc = serviceFromPort(port);
    for (const s of services) {
      const rec = s && typeof s === "object" ? (s as Record<string, unknown>) : {};
      if (String(rec.port || "") === port) {
        const name = String(rec.name || rec.service || "").toLowerCase();
        if (name) svc = normalizeServiceName(name) || svc;
      }
    }
    if (svc === "web") webPorts.push(port);
  }
  // URLs on the asset often identify the engagement web port (e.g. DVWA :8080).
  for (const u of Array.isArray(props.urls) ? props.urls : []) {
    if (typeof u !== "string") continue;
    try {
      const parsed = new URL(/^https?:\/\//i.test(u) ? u : `http://${u}`);
      if (parsed.port) webPorts.push(parsed.port);
      else if (parsed.protocol === "https:") webPorts.push("443");
      else webPorts.push("80");
    } catch {
      /* ignore */
    }
  }
  if (!webPorts.length) return "";
  // Prefer the port that appears most in URL inventory, then common web ports.
  const counts = new Map<string, number>();
  for (const p of webPorts) counts.set(p, (counts.get(p) || 0) + 1);
  let best = "";
  let n = 0;
  for (const [p, c] of counts) {
    if (c > n) {
      best = p;
      n = c;
    }
  }
  if (counts.has("8080") && (counts.get("8080") || 0) >= n - 2) return "8080";
  return best;
}

function normalizeAssetHost(raw: string): string {
  let s = String(raw || "").trim();
  if (!s) return "";
  try {
    if (/^https?:\/\//i.test(s) || s.includes("/")) {
      const withScheme = /^https?:\/\//i.test(s) ? s : `http://${s}`;
      const u = new URL(withScheme);
      s = u.hostname || "";
    }
  } catch {
    s = s.replace(/^https?:\/\//i, "").split("/")[0].split(":")[0];
  }
  s = s.split(":")[0].trim();
  if (!s || isBogusHostLabel(s)) return "";
  if (!/^[\w.-]+$/.test(s)) return "";
  return s;
}

function isBogusHostLabel(host: string): boolean {
  const h = host.toLowerCase();
  if (!h || h === "(target)") return true;
  // Filenames mistaken as hosts (e.g. reflected.php from bad asset records).
  if (/\.(php|phtml|asp|aspx|jsp|html?|js|css|map|json|txt|bak|swp|git|env|xml|svg|png|jpe?g|gif|ico|woff2?|ttf|eot)$/i.test(h)) {
    return true;
  }
  if (h.includes("/") || h.includes("\\") || h.includes("?")) return true;
  return false;
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  let best = "";
  let n = 0;
  for (const [v, c] of counts) {
    if (c > n) {
      best = v;
      n = c;
    }
  }
  return best;
}

/** Loopback / docker DNS only — not LAN privates (those may be distinct targets). */
function isLocalAliasHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "localhost"
    || h === "127.0.0.1"
    || h === "0.0.0.0"
    || h === "::1"
    || h === "host.docker.internal"
    || h === "gateway.docker.internal"
    || h.endsWith(".localhost")
  );
}

/**
 * When exactly one "primary" host exists alongside another host that only
 * differs as a known alias pair (e.g. public + docker name already handled),
 * or path-only rows — folding is done in canonicalize. Additionally, if two
 * hosts share the exact same open port set and one is private while the other
 * is public, prefer merging under the public address for display.
 */
function maybeMergePairedHosts(entries: SurfaceEntry[]): Map<string, string> {
  const map = new Map<string, string>(); // host -> primaryHost
  const byHost = new Map<string, Set<string>>(); // host -> ports
  for (const e of entries) {
    if (!e.host || !e.port) continue;
    const h = e.host.toLowerCase();
    const set = byHost.get(h) || new Set<string>();
    set.add(e.port);
    byHost.set(h, set);
  }
  const hosts = [...byHost.keys()];
  if (hosts.length !== 2) return map;
  const [a, b] = hosts as [string, string];
  const portsA = byHost.get(a)!;
  const portsB = byHost.get(b)!;
  const samePorts =
    portsA.size === portsB.size && [...portsA].every((p) => portsB.has(p));
  if (!samePorts || portsA.size === 0) return map;
  const aPriv = isPrivateIp(a);
  const bPriv = isPrivateIp(b);
  // public + private with identical port inventory → one asset (common dual-address host)
  if (aPriv !== bPriv) {
    const primary = aPriv ? b : a;
    const secondary = aPriv ? a : b;
    map.set(secondary, primary);
  }
  return map;
}

function isPrivateIp(host: string): boolean {
  const h = host.toLowerCase();
  return (
    /^10\.\d+\.\d+\.\d+$/.test(h)
    || /^192\.168\.\d+\.\d+$/.test(h)
    || /^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(h)
  );
}

function serviceFromPort(port: string): string {
  const p = Number(port);
  if ([80, 443, 8080, 8000, 8008, 8081, 8443, 8888, 3000, 5000, 9000, 9443].includes(p)) return "web";
  if (p === 6379) return "redis";
  if (p === 22) return "ssh";
  if (p === 21) return "ftp";
  if (p === 25 || p === 587 || p === 465) return "smtp";
  if (p === 3306) return "mysql";
  if (p === 5432) return "postgres";
  if (p === 27017) return "mongodb";
  if (p === 11211) return "memcached";
  if (p === 9200 || p === 9300) return "elasticsearch";
  if (p === 5672 || p === 15672) return "rabbitmq";
  if (p === 3389) return "rdp";
  if (p === 445 || p === 139) return "smb";
  return "unknown";
}

function normalizeServiceName(name: string): string {
  const n = name.toLowerCase().trim();
  if (!n) return "unknown";
  if (/http|https|www|nginx|apache|iis|tomcat|web/.test(n)) return "web";
  if (/redis/.test(n)) return "redis";
  if (/ssh|openssh/.test(n)) return "ssh";
  if (/mysql|mariadb/.test(n)) return "mysql";
  if (/postgres|pgsql/.test(n)) return "postgres";
  if (/mongo/.test(n)) return "mongodb";
  if (/elastic/.test(n)) return "elasticsearch";
  if (/memcache/.test(n)) return "memcached";
  if (/ftp/.test(n)) return "ftp";
  if (/smtp|mail/.test(n)) return "smtp";
  if (/rdp|ms-wbt/.test(n)) return "rdp";
  if (/smb|microsoft-ds/.test(n)) return "smb";
  // Free-text plan titles / host blobs must not become service labels (that
  // forked a "host only host.docker…" sibling under the Surface tree).
  // Only compact product tokens are kept as custom service names.
  if (/^[a-z0-9][a-z0-9._+-]{0,23}$/i.test(n) && !/\s/.test(n)) return n.slice(0, 24);
  return "unknown";
}
function inferServiceFromText(text: string): string {
  return normalizeServiceName(text);
}

/**
 * Parse host:port, URL, path-only, or "METHOD url" into a structured surface ref.
 */
export function parseSurfaceRef(raw: string, methodHint?: string | null, serviceHint?: string): ParsedSurfaceRef | null {
  let text = String(raw || "").trim();
  if (!text || text === "-") return null;
  if (/^\s*[{[]/.test(text) || /"traffic_id"|"evidence_id"/.test(text)) return null;
  if (text.length > 300) return null;

  let method = normalizeHttpMethod(methodHint, text);
  const methodMatch = text.match(/^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/i);
  if (methodMatch) {
    method = methodMatch[1].toUpperCase();
    text = methodMatch[2];
  }

  // Full URL (trim at first whitespace so "http://h/p?id=1 UNION…" still parses)
  try {
    if (/^https?:\/\//i.test(text)) {
      const urlToken = text.match(/^https?:\/\/\S+/i)?.[0] || text;
      const cleaned = urlToken.replace(/[.,;:]+$/, "");
      const u = new URL(cleaned);
      const host = u.hostname;
      const port = u.port || (u.protocol === "https:" ? "443" : "80");
      let path = u.pathname || "/";
      path = path.split(/[?#]/)[0] || "/";
      if (path.length > 1) path = path.replace(/\/+$/, "");
      if (isNoiseSurfacePath(path) && path !== "/") return null;
      return {
        host,
        port,
        origin: `${host}:${port}`,
        path: path || "/",
        service: "web",
        method,
      };
    }
  } catch {
    // Fall through — may still extract path via regex below.
  }

  // host:port/path or host:port
  const hostPort = text.match(
    /^(?:\/\/)?([\w.-]+|\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?(\/[^?#\s]*)?$/i,
  );
  if (hostPort && !text.startsWith("/")) {
    const host = hostPort[1];
    const port = hostPort[2] || "";
    let path = hostPort[3] || "";
    if (path) {
      path = path.split(/[?#]/)[0] || path;
      if (path.length > 1) path = path.replace(/\/+$/, "");
      if (isNoiseSurfacePath(path) && path !== "/") return null;
    }
    // Only trust compact known/custom service tokens as hints — free-text
    // plan titles would otherwise create non-web host-only siblings.
    const hint = String(serviceHint || "").trim();
    const hintOk = hint && (isKnownSurfaceService(hint) || /^[a-z0-9][a-z0-9._+-]{0,23}$/i.test(hint));
    const svc = (hintOk ? hint : "") || (port ? serviceFromPort(port) : "web");
    const origin = port ? `${host}:${port}` : host;
    // Host-only with unknown service → web root (fold later onto :port).
    if (svc !== "web" && !path && !port && !isKnownSurfaceService(svc)) {
      return { host, port: "", origin: host, path: "/", service: "web", method };
    }
    if (svc !== "web" && !path) {
      return { host, port: port || "", origin, path: "", service: svc, method };
    }
    return {
      host,
      port: port || (svc === "web" ? "" : ""),
      origin: port ? `${host}:${port}` : host,
      path: path || "/",
      service: path || !port || serviceFromPort(port) === "web" ? "web" : svc,
      method,
    };
  }

  // Path-only (legacy single-target web) — keep under implicit origin ""
  if (text.startsWith("/") || looksLikeUrlPath(text)) {
    const path = normalizeSurfacePath(text);
    if (!path) return null;
    return {
      host: "",
      port: "",
      origin: "",
      path,
      service: "web",
      method,
    };
  }

  return null;
}


function extractSurfaceRefsFromFinding(finding: Record<string, unknown>): ParsedSurfaceRef[] {
  const fields = [
    finding.location,
    finding.url,
    finding.endpoint,
    finding.poc,
    finding.reproduction,
    finding.title,
    finding.description,
    finding.impact,
    finding.affected_asset,
  ];
  const found: ParsedSurfaceRef[] = [];
  const seen = new Set<string>();

  const consider = (raw: string) => {
    const parsed = parseSurfaceRef(raw);
    if (!parsed) return;
    // Host-only / site root is a weak candidate — keep but rank lower.
    const entry = toSurfaceEntry(parsed);
    if (seen.has(entry.key.toLowerCase())) return;
    seen.add(entry.key.toLowerCase());
    found.push(parsed);
  };

  for (const field of fields) {
    const text = String(field || "").trim();
    if (!text) continue;
    consider(text);
    // Absolute URLs (stop at whitespace so SQL payloads in query don't break parsing)
    for (const m of text.matchAll(/https?:\/\/[^\s"'<>)}\]]+/gi)) {
      consider(m[0].replace(/[.,;:]+$/, ""));
    }
    // "at /level1/index.php", "via /login", plain paths
    for (const m of text.matchAll(
      /(?:^|[\s"'=(]|(?:at|via|on|to|from)\s+)(\/(?:[A-Za-z0-9._~%+\-{}[\]]+\/?)+)/gi,
    )) {
      consider(m[1]);
    }
    // METHOD /path or METHOD http://...
    for (const m of text.matchAll(/\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/gi)) {
      consider(m[1]);
    }
    // filename.php mentioned in title when no leading slash
    for (const m of text.matchAll(
      /(?:^|[\s/])((?:level\d+\/)?[A-Za-z0-9_.-]+\.(?:php|phtml|asp|aspx|jsp|html?))(?:\b|$|\?)/gi,
    )) {
      consider(`/${m[1].replace(/^\//, "")}`);
    }
  }

  // Prefer specific paths over bare site roots.
  return found.sort((a, b) => {
    const ap = a.path === "/" ? 0 : a.path.length;
    const bp = b.path === "/" ? 0 : b.path.length;
    if (bp !== ap) return bp - ap;
    return (b.origin?.length || 0) - (a.origin?.length || 0);
  });
}

/** @deprecated path-only helper kept for soft matching segments */
function extractPathsFromFinding(finding: Record<string, unknown>): string[] {
  return extractSurfaceRefsFromFinding(finding).map((r) => {
    const e = toSurfaceEntry(r);
    return e.key;
  });
}

export function attachFindingsToSurface(
  findings: Array<Record<string, unknown>>,
  surfaceKeys: string[],
  surfaceEntries: SurfaceEntry[] = [],
): {
  byPath: Map<string, SurfaceFindingTag[]>;
  unlinked: SurfaceFindingTag[];
  total: number;
  linkedUnique: number;
  kindCounts: { vuln: number; flag: number; key: number };
} {
  const surfaceSet = new Set(surfaceKeys.map((p) => p.toLowerCase()));
  const byPath = new Map<string, SurfaceFindingTag[]>();
  const unlinked: SurfaceFindingTag[] = [];
  const kindCounts = { vuln: 0, flag: 0, key: 0 };
  let linkedUnique = 0;

  findings.forEach((finding, index) => {
    const resolved = resolveFindingSurfaceKey(finding, surfaceKeys, surfaceSet, surfaceEntries);
    const kindId = classifyFindingKind(finding);
    const tag = toSurfaceFindingTagForKind(finding, resolved || "", index, kindId, 0);
    if (tag.kind === "flag") kindCounts.flag += 1;
    else if (tag.kind === "key") kindCounts.key += 1;
    else kindCounts.vuln += 1;

    // Spec #375 D10: badge only onto existing ledger inventory keys — never invent a second tree.
    if (!resolved || !surfaceSet.has(resolved.toLowerCase())) {
      unlinked.push(tag);
      return;
    }
    linkedUnique += 1;
    const key = resolved.toLowerCase();
    tag.finding = {
      ...tag.finding,
      __surface_path: resolved,
      // Human path aligned with Surface tree (host:port/path)
      __surface_display: surfaceKeyToDisplay(resolved),
    };
    const list = byPath.get(key) || [];
    list.push(tag);
    byPath.set(key, list);
  });

  return {
    byPath,
    unlinked,
    total: findings.length,
    linkedUnique,
    kindCounts,
  };
}

/**
 * Hang a finding on the most specific web path that exists in the surface inventory.
 * Never prefer bare origin root ("/") when a deeper path is available.
 */
export function resolveFindingSurfaceKey(
  finding: Record<string, unknown>,
  _surfaceKeys: string[],
  surfaceSet: Set<string>,
  surfaceEntries: SurfaceEntry[],
): string {
  const webEntries = surfaceEntries.filter((e) => e.service === "web");
  const refs = extractSurfaceRefsFromFinding(finding);

  // 1) Exact key match (path-only keys rewritten against known origins)
  for (const r of refs) {
    const direct = toSurfaceEntry(r).key;
    if (surfaceSet.has(direct.toLowerCase())) return direct;
    if (!r.origin) {
      for (const e of webEntries) {
        if (normalizeWebPath(e.path) === normalizeWebPath(r.path)) return e.key;
      }
    }
  }

  // 2) Exact path match (ignore origin), longest path wins — skip bare "/"
  let bestExact = "";
  let bestExactLen = -1;
  for (const r of refs) {
    const pl = normalizeWebPath(r.path);
    if (!pl || pl === "/") continue;
    for (const e of webEntries) {
      if (normalizeWebPath(e.path) !== pl) continue;
      if (pl.length > bestExactLen) {
        bestExact = e.key;
        bestExactLen = pl.length;
      }
    }
  }
  if (bestExact) return bestExact;

  // 3) Longest surface path that is a prefix of a finding path (finding deeper than inventory leaf)
  let bestPrefix = "";
  let bestPrefixLen = -1;
  for (const r of refs) {
    const pl = normalizeWebPath(r.path);
    if (!pl || pl === "/") continue;
    for (const e of webEntries) {
      const el = normalizeWebPath(e.path);
      if (!el || el === "/") continue;
      if (pl === el || pl.startsWith(`${el}/`)) {
        if (el.length > bestPrefixLen) {
          bestPrefix = e.key;
          bestPrefixLen = el.length;
        }
      }
    }
  }
  if (bestPrefix) return bestPrefix;

  // 4) Soft segment match — never return bare "/"
  const soft = softMatchSurfacePath(
    finding,
    webEntries.map((e) => e.path).filter((p) => p && p !== "/"),
  );
  if (soft) {
    const hit = webEntries.find((e) => normalizeWebPath(e.path) === normalizeWebPath(soft));
    if (hit) return hit.key;
  }

  // 5) Specific path candidate not yet in inventory → create leaf under target origin if possible
  for (const r of refs) {
    const pl = normalizeWebPath(r.path);
    if (!pl || pl === "/") continue;
    // Directory-only hints like /level3 are handled in step 5b (do not pick a sibling leaf).
    if (/^\/level\d+$/i.test(pl)) continue;
    if (r.origin) return toSurfaceEntry(r).key;
    const bound = bindPathToDominantOrigin(pl, r.method || "", webEntries);
    if (bound) return bound;
    return toSurfaceEntry(r).key;
  }

  // 5b) Level-only signal (title "L3 …", "Level 3", blob "level3") with no file path.
  // Hang on /levelN under the dominant web origin — never invent a sibling leaf file.
  const levelDirs = extractLevelDirectoryPaths(finding);
  for (const levelPath of levelDirs) {
    const bound = bindPathToDominantOrigin(levelPath, "", webEntries);
    if (bound) return bound;
  }

  // 6) Only site-root candidates left — attach to origin root ONLY if we truly have no path signal.
  // (Flags/vulns with a path in title/poc should have been caught above.)
  const hasSpecificPath =
    refs.some((r) => {
      const pl = normalizeWebPath(r.path);
      return Boolean(pl && pl !== "/");
    }) || levelDirs.length > 0;
  if (!hasSpecificPath) {
    for (const r of refs) {
      if (normalizeWebPath(r.path) !== "/") continue;
      if (r.origin) {
        const k = toSurfaceEntry({ ...r, path: "/" }).key;
        if (surfaceSet.has(k.toLowerCase())) return k;
        const hit = webEntries.find(
          (e) => e.origin.toLowerCase() === r.origin.toLowerCase() && normalizeWebPath(e.path) === "/",
        );
        if (hit) return hit.key;
      }
    }
    // Prefer any web root under the dominant origin rather than inventing keys.
    const root = webEntries.find((e) => normalizeWebPath(e.path) === "/");
    if (root) return root.key;
  }

  return "";
}

/** Bind a path-only web route onto the most common origin in the inventory. */
function bindPathToDominantOrigin(
  path: string,
  method: string,
  webEntries: SurfaceEntry[],
): string {
  const pl = normalizeWebPath(path);
  if (!pl || pl === "/") return "";
  const originCounts = new Map<string, number>();
  for (const e of webEntries) {
    if (!e.origin) continue;
    originCounts.set(e.origin, (originCounts.get(e.origin) || 0) + 1);
  }
  let topOrigin = "";
  let topN = 0;
  for (const [o, n] of originCounts) {
    if (n > topN) {
      topOrigin = o;
      topN = n;
    }
  }
  if (!topOrigin) return "";
  const host = topOrigin.split(":")[0] || "";
  const port = topOrigin.includes(":") ? topOrigin.split(":").slice(1).join(":") : "";
  return toSurfaceEntry({
    host,
    port,
    origin: topOrigin,
    path: pl,
    service: "web",
    method,
  }).key;
}

/**
 * Infer CTF-style level directories from free text when no concrete file path is known.
 * "L3 Challenge", "Level 3", "level3" → ["/level3"]
 */
function extractLevelDirectoryPaths(finding: Record<string, unknown>): string[] {
  const blob = [
    finding.title,
    finding.location,
    finding.url,
    finding.endpoint,
    finding.description,
    finding.poc,
    finding.reproduction,
    finding.impact,
  ]
    .map((v) => String(v || ""))
    .join("\n");
  const levels = new Set<number>();
  for (const m of blob.matchAll(/\bL(\d{1,2})\b/gi)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 30) levels.add(n);
  }
  for (const m of blob.matchAll(/\bLevel\s*(\d{1,2})\b/gi)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 30) levels.add(n);
  }
  for (const m of blob.matchAll(/\blevel(\d{1,2})\b/gi)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 30) levels.add(n);
  }
  return [...levels].sort((a, b) => a - b).map((n) => `/level${n}`);
}

function normalizeWebPath(path: string): string {
  let p = String(path || "").trim() || "/";
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p.toLowerCase();
}

/** Convert inventory key `host:port|web|/path` → `host:port/path` for detail UI. */
export function surfaceKeyToDisplay(key: string): string {
  const parts = String(key || "").split("|");
  if (parts.length >= 3 && parts[1] === "web") {
    const origin = parts[0] || "";
    const path = parts.slice(2).join("|") || "/";
    if (!origin) return path;
    return path === "/" ? origin : `${origin}${path.startsWith("/") ? path : `/${path}`}`;
  }
  if (parts.length >= 2) {
    // host:port|redis
    return parts[0] ? `${parts[0]} (${parts[1]})` : key;
  }
  return key;
}

/** Parse inventory key produced by toSurfaceEntry back into a surface ref. */
export function parseSurfaceInventoryKey(key: string): ParsedSurfaceRef | null {
  const parts = String(key || "").split("|");
  if (parts.length >= 3 && parts[1] === "web") {
    const origin = parts[0] || "";
    const path = parts.slice(2).join("|") || "/";
    if (!origin && !path) return null;
    const host = origin.includes(":") ? origin.split(":")[0] || "" : origin;
    const port = origin.includes(":") ? origin.split(":").slice(1).join(":") : "";
    return {
      host,
      port,
      origin: origin || "",
      path: path || "/",
      service: "web",
      method: "",
    };
  }
  if (parts.length === 2 && parts[0] && parts[1] && parts[1] !== "web") {
    const origin = parts[0];
    const host = origin.includes(":") ? origin.split(":")[0] || "" : origin;
    const port = origin.includes(":") ? origin.split(":").slice(1).join(":") : "";
    return {
      host,
      port,
      origin,
      path: "",
      service: parts[1],
      method: "",
    };
  }
  return null;
}

const SURFACE_SOFT_STOPWORDS = new Set([
  "api", "rest", "v1", "v2", "v3", "http", "https", "www", "com", "org", "net",
  "user", "users", "admin", "login", "index", "home", "page", "test", "data",
  "null", "true", "false", "json", "html", "php", "asp", "jsp", "static",
  "assets", "public", "file", "files", "img", "images", "css", "js",
]);

function softMatchSurfacePath(finding: Record<string, unknown>, surfaceKeys: string[]): string {
  const blob = [
    finding.title,
    finding.location,
    finding.url,
    finding.endpoint,
    finding.description,
    finding.poc,
    finding.reproduction,
    finding.impact,
  ]
    .map((v) => String(v || "").toLowerCase())
    .join("\n");
  if (!blob.trim()) return "";

  // Expand "L3" / "Level 3" so they can match inventory segment "level3".
  const levelAliases = new Set<string>();
  for (const m of blob.matchAll(/\bl(\d{1,2})\b/gi)) levelAliases.add(`level${m[1]}`);
  for (const m of blob.matchAll(/\blevel\s*(\d{1,2})\b/gi)) levelAliases.add(`level${m[1]}`);
  for (const m of blob.matchAll(/\blevel(\d{1,2})\b/gi)) levelAliases.add(`level${m[1]}`);

  let best = "";
  let bestScore = 0;
  let bestFileScore = 0;
  let secondScore = 0;
  for (const surface of surfaceKeys) {
    const sl = surface.toLowerCase();
    const segments = sl.split("/").filter(Boolean);
    if (segments.length === 0) continue;
    let score = 0;
    let fileScore = 0;
    // Full path mention
    if (blob.includes(sl)) score += 100 + sl.length;
    // Distinctive segments (skip stopwords / short tokens)
    for (const seg of segments) {
      if (seg.length < 4 || SURFACE_SOFT_STOPWORDS.has(seg)) continue;
      if (/^level\d+$/i.test(seg)) continue;
      if (blob.includes(seg)) {
        const add = 10 + seg.length;
        score += add;
        fileScore += add;
      }
    }
    // levelN style CTF paths are supportive, not alone sufficient to pick a sibling file
    for (const seg of segments) {
      if (!/^level\d+$/i.test(seg)) continue;
      if (blob.includes(seg) || levelAliases.has(seg)) score += 30;
    }
    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      bestFileScore = fileScore;
      best = surface;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }
  // Require a file/path signal (not level-only). Level-only hang uses /levelN directories.
  if (bestFileScore < 14 && bestScore < 100) return "";
  // Ambiguous: two surfaces scored the same → do not soft-pick.
  if (bestScore > 0 && bestScore === secondScore) return "";
  return bestScore >= 14 ? best : "";
}


function looksLikeUrlPath(value: string): boolean {
  const raw = String(value || "").trim();
  if (!raw || raw === "-") return false;
  if (raw.length > 220) return false;
  // JSON / tool dumps
  if (/^\s*[{[]/.test(raw) || /"traffic_id"|"evidence_id"|"runner"\s*:/.test(raw)) return false;
  // host:port or host:port/path
  if (/^(?:https?:\/\/)?[\w.-]+(?::\d{1,5})?(?:\/\S*)?$/i.test(raw) && !/\s/.test(raw)) return true;
  // Multi-word English prose (the main source of dirty surface rows).
  if (/\s/.test(raw)) {
    // Allow "GET /path" or "POST http://x/y" only.
    if (!/^\s*(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+/i.test(raw)) return false;
    const rest = raw.replace(/^\s*(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i, "");
    if (/\s/.test(rest.split(/[?#]/)[0])) return false;
  }
  // Sentence-ish titles
  if (/\b(allows|with|using|file|directive|executed|vulnerability|injection|detected|found)\b/i.test(raw)
    && !/^https?:\/\//i.test(raw)
    && !/^\s*(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\//i.test(raw)
    && !raw.startsWith("/")
    && !/^[\w.-]+(?::\d{1,5})?(?:\/\S*)?$/i.test(raw)) {
    return false;
  }
  return true;
}

function normalizeSurfacePath(endpoint: string): string {
  let path = String(endpoint || "").trim();
  if (!path || path === "-" || !looksLikeUrlPath(path)) return "";
  // Titles like "GET /level9/.git/config" → path only.
  const titled = path.match(/^\s*(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S+)/i);
  if (titled) path = titled[1];
  try {
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname || path;
  } catch {
    return "";
  }
  path = (path.split(/[?#]/)[0] || path).trim();
  if (!path || path === "-") return "";
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/{2,}/g, "/");
  // Drop trailing slash except root: /upload/ → /upload
  if (path.length > 1) path = path.replace(/\/+$/, "");
  // Segment check: no spaces, no sentence punctuation runs, reasonable length.
  const segments = path.split("/").filter(Boolean);
  for (const seg of segments) {
    if (!seg || seg.length > 96) return "";
    if (/\s/.test(seg)) return "";
    // Path tokens only (supports .htaccess, file.php, {id}, %20, etc.)
    if (!/^[A-Za-z0-9._~!$&'()*+,;=:@%{}\[\]-]+$/.test(seg)) return "";
    // Reject "word.word.word ..." that is clearly prose glued (multiple spaces already rejected)
    if (seg.split(".").length > 6 && seg.length > 40) return "";
  }
  // Entire path still looks like prose somehow (e.g. "/.htaccess file..." if spaces slipped through)
  if (/\s/.test(path)) return "";
  if (isNoiseSurfacePath(path)) return "";
  return path;
}

/**
 * Scanner placeholders and non-resources that should not appear in the Surface tree.
 * Aligns with node2 isNoiseEndpoint intent (FUZZ, bare API roots, static assets).
 */
function isNoiseSurfacePath(path: string): boolean {
  const p = String(path || "").trim().toLowerCase();
  if (!p || p === "/" || p === "-" || p === "/.") return true;
  if (/\.(?:css|js|mjs|map|png|jpe?g|gif|ico|svg|woff2?|ttf|eot|mp4|webm|webp|avif)(?:$)/i.test(p)) return true;
  // FUZZ / placeholder tokens (common ffuf/dirsearch markers).
  if (/(?:^|\/)(?:fuzz|\{fuzz\}|wfuzz|placeholder|wordlist|null|undefined|\*|%2a)(?:\/|$)/i.test(p)) return true;
  // Bare API framework roots without a resource.
  if (/^\/(?:api|rest|graphql|v\d+)\/?$/i.test(p)) return true;
  const segments = p.split("/").filter(Boolean);
  if (segments.length === 0) return true;
  if (segments.some((seg) => /^(?:fuzz|\{fuzz\}|wfuzz|placeholder|wordlist|null|undefined|\*|%2a)$/i.test(seg))) {
    return true;
  }
  // Single ultra-short junk segments from truncated scanners.
  if (segments.length === 1 && segments[0]!.length <= 1) return true;
  return false;
}

/** Prefer stable lowercase path when merging case variants of the same route. */
function preferCanonicalPath(a: string, b: string): string {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al === bl) {
    // Prefer all-lowercase display form.
    if (a === al) return a;
    if (b === bl) return b;
    return a.length <= b.length ? a : b;
  }
  return a.length <= b.length ? a : b;
}

function normalizeHttpMethod(method: unknown, title?: unknown): string {
  let raw = String(method || "").trim().toUpperCase();
  if (!raw || ["SURFACE", "REQUEST", "ENDPOINT", "TEST", "HTTP", "WORKER", "SCAN", "TRAFFIC", "BROWSER"].includes(raw)) {
    const fromTitle = String(title || "").match(/^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/i);
    raw = fromTitle ? fromTitle[1].toUpperCase() : "";
  }
  if (!raw) return "";
  return raw
    .split(/[,\s|/]+/)
    .map((m) => m.trim().toUpperCase())
    .filter((m) => ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(m))
    .join(",");
}

function mergeMethodList(...parts: Array<string | null | undefined>): string[] {
  const set = new Set<string>();
  for (const part of parts) {
    for (const m of String(part || "").split(/[,\s|/]+/)) {
      const up = m.trim().toUpperCase();
      if (["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(up)) set.add(up);
    }
  }
  const order = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
  return order.filter((m) => set.has(m));
}

function mergeStringList(...lists: Array<string[] | undefined | null>): string[] {
  const set = new Set<string>();
  for (const list of lists) {
    for (const item of list || []) {
      const v = String(item || "").trim();
      if (v) set.add(v);
    }
  }
  return Array.from(set);
}

export function surfaceMethodChips(method: unknown): string[] {
  return mergeMethodList(String(method || ""));
}

