/**
 * Spec #368 / #380 / #412 / #413 — Traffic complete → Surface settle (D6 / D6.1).
 *
 * Pure decision + Node integration:
 *   HTTP(S) exchange complete/fail → identity (origin_key + path_key)
 *   → L2 noise gates: engagement scope, garbage path, static denylist,
 *     optional collapsed OS-probe paths
 *   → purpose classify (#413): purpose=test → case_tested sticky + status touched
 *     (single test request enough for operator TESTED)
 *   → non-test settle: first seen, later multi-hit touched (Graph internal);
 *     case_tested stays false unless a prior test hit
 *   → SQLite working store + async Platform dual-write (#374)
 *
 * Does not implement TARGET seed (#381) or finding confirm booked (#382).
 */

import type { ToolRuntime } from "../types.js";
import {
  mergeMethods,
  mergeParams,
  parseLocation,
  type ParsedLocationOk,
} from "../stores/surface-identity.js";
import type { SurfaceRow, SurfaceUpsertResult } from "../stores/surface-sqlite.js";
import { scopeHostsFromTask, scopeOriginsFromTask } from "./attack-surface.js";
import {
  enqueueSurfacePlatformSync,
  isSurfacePlatformOnline,
} from "./surface-platform-sync.js";
import type { TrafficExchange } from "./traffic-collect.js";
import {
  classifyTrafficPurpose,
  purposeMarksCaseTested,
  type TrafficPurpose,
} from "./traffic-purpose.js";

/**
 * Conservative static asset path suffixes (D6.1).
 * Paths ending with these (case-insensitive) do not become Surface rows.
 * Implementation knob — keep conservative; 4xx/5xx on non-static paths still settle.
 */
export const STATIC_PATH_SUFFIX_DENYLIST: readonly string[] = [
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".map",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".ico",
  ".bmp",
  ".avif",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp4",
  ".webm",
  ".mp3",
  ".wav",
  ".ogg",
] as const;

export type TrafficSettleSkip = {
  settle: false;
  reason: string;
};

export type TrafficSettlePlan = {
  settle: true;
  location: string;
  origin_key: string;
  path_key: string;
  kind: string;
  /** Requested status for ordinary upsert (never booked). */
  status: "seen" | "touched";
  methods: string[];
  params: string[];
  source: "traffic";
  /** Spec #413 L3 — classified exchange purpose. */
  purpose: TrafficPurpose;
  /**
   * Spec #413 L4 — sticky flag to set on Surface when purpose=test.
   * False means "do not set" (never clears an existing case_tested).
   */
  case_tested: boolean;
};

export type TrafficSettleDecision = TrafficSettleSkip | TrafficSettlePlan;

export type TrafficSettleApplyResult =
  | { ok: true; skipped: true; reason: string }
  | { ok: true; skipped: false; created: number; updated: number; row: SurfaceRow | null }
  | { ok: false; error: string };

/**
 * Optional engagement-scope context for L2 noise filter (#412).
 * When omitted, or when allowedHosts is empty, origin scope gate is off
 * (lab / no TARGET+allow → keep prior settle behaviour).
 */
export type TrafficSettleScopeContext = {
  /**
   * Lowercase hostnames from task TARGET + scope.allow
   * (same set as scopeHostsFromTask). Empty/missing = no origin filter.
   */
  allowedHosts?: ReadonlySet<string> | readonly string[] | null;
  /**
   * host:port when TARGET / scope.allow named an explicit port.
   * When non-empty, settle requires this origin (same host other ports are out).
   */
  allowedOrigins?: ReadonlySet<string> | readonly string[] | null;
};

/**
 * Well-known OS probe paths after URL/path normalization collapses `..`.
 * Only used when the raw URL contained traversal (`..` / `%2e%2e`).
 */
const COLLAPSED_OS_PROBE_PATHS: ReadonlySet<string> = new Set([
  "/etc/passwd",
  "/etc/shadow",
  "/etc/hosts",
  "/etc/group",
  "/windows/win.ini",
  "/win.ini",
  "/boot.ini",
  "/windows/system32/drivers/etc/hosts",
]);

/** True when path_key is a denylisted static asset path (D6.1). */
export function isStaticSurfacePath(pathKey: string): boolean {
  const p = String(pathKey || "").trim().toLowerCase();
  if (!p) return false;
  // Only the final path segment's extension (ignore query — already stripped in path_key).
  for (const suffix of STATIC_PATH_SUFFIX_DENYLIST) {
    if (p.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * Unexpanded shell/tool template leftovers in path (#412 L2).
 * Matches `${…}` and `{{…}}` after path_key decode.
 */
export function hasGarbageToolPath(pathKey: string): boolean {
  const p = String(pathKey || "");
  return p.includes("${") || p.includes("{{");
}

/** Normalize host for scope compare (lowercase; strip IPv6 brackets). */
export function normalizeScopeHost(host: string): string {
  let h = String(host || "").trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h;
}

/**
 * Whether origin host is in engagement scope (TARGET + scope.allow hosts).
 * Empty/missing allowedHosts → true (no gate).
 */
export function isOriginInEngagementScope(
  host: string,
  scope?: TrafficSettleScopeContext | null,
): boolean {
  if (!scope) return true;
  const raw = scope.allowedHosts;
  if (raw == null) return true;
  const set =
    raw instanceof Set
      ? raw
      : new Set([...raw].map((h) => normalizeScopeHost(String(h))).filter(Boolean));
  if (set.size === 0) return true;
  const h = normalizeScopeHost(host);
  if (!h) return false;
  if (set.has(h)) return true;
  // Also accept bracketed form if callers put it in the set.
  if (h.includes(":") && set.has(`[${h}]`)) return true;
  return false;
}

/** Host+port gate when the engagement named an explicit port; else host-only. */
export function isUrlInEngagementScope(
  host: string,
  port: number | string | null | undefined,
  scope?: TrafficSettleScopeContext | null,
): boolean {
  if (!scope) return true;
  const rawOrigins = scope.allowedOrigins;
  if (rawOrigins != null) {
    const origins =
      rawOrigins instanceof Set
        ? rawOrigins
        : new Set([...rawOrigins].map((x) => String(x || "").trim().toLowerCase()).filter(Boolean));
    if (origins.size > 0) {
      const h = normalizeScopeHost(host);
      const p = String(port ?? "").trim();
      if (!h || !p) return false;
      return origins.has(`${h}:${p}`);
    }
  }
  return isOriginInEngagementScope(host, scope);
}

/**
 * Raw URL path (before URL class collapse) contains path traversal.
 * Detects `..` segments and common encodings.
 */
export function rawUrlHasPathTraversal(url: string): boolean {
  const s = String(url || "");
  // Path portion only when scheme present; else whole string.
  let pathPart = s;
  const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)/i);
  if (m?.[1]) pathPart = m[1];
  if (pathPart.includes("..")) return true;
  // %2e%2e / %2E%2E and mixed encodings
  if (/%2e%2e/i.test(pathPart)) return true;
  if (/\.%2e|%2e\./i.test(pathPart)) return true;
  return false;
}

/**
 * Normalized path looks like a collapsed OS-file probe (#412 optional L2).
 * Only true when raw URL had traversal **and** path_key is a known OS probe.
 */
export function isCollapsedOsProbePath(pathKey: string, rawUrl: string): boolean {
  if (!rawUrlHasPathTraversal(rawUrl)) return false;
  const p = String(pathKey || "").trim().toLowerCase();
  if (!p) return false;
  if (COLLAPSED_OS_PROBE_PATHS.has(p)) return true;
  // Trailing match after extra collapse noise, e.g. rare double-prefix.
  for (const probe of COLLAPSED_OS_PROBE_PATHS) {
    if (p.endsWith(probe)) return true;
  }
  return false;
}

/** Build settle scope context from task TARGET + scope.allow (host set). */
export function trafficSettleScopeFromTask(task: {
  target?: Record<string, unknown>;
  scope?: Record<string, unknown>;
}): TrafficSettleScopeContext {
  return {
    allowedHosts: scopeHostsFromTask(task),
    allowedOrigins: scopeOriginsFromTask(task),
  };
}

/** HTTP(S) only for v2 settle (D6). */
export function isHttpHttpsScheme(scheme: string): boolean {
  const s = String(scheme || "").trim().toLowerCase();
  return s === "http" || s === "https";
}

/** Terminal traffic phases that may settle; pending does not. */
export function isTrafficSettlePhase(phase: string | null | undefined): boolean {
  const p = String(phase || "").trim().toLowerCase();
  return p === "completed" || p === "failed";
}

/** Extract query param names from a full URL (empty if none / unparseable). */
export function extractUrlParamNames(url: string): string[] {
  try {
    const u = new URL(String(url || "").trim());
    const names: string[] = [];
    const seen = new Set<string>();
    for (const key of u.searchParams.keys()) {
      const k = String(key || "").trim();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      names.push(k);
    }
    return names;
  } catch {
    return [];
  }
}

/**
 * Pure S2 decision: whether this exchange should upsert Surface, and with what fields.
 *
 * @param exchange — traffic row (url/method/phase required for eligibility; optional purpose/source)
 * @param existing — prior Surface row for this identity, if any (null/undefined = first hit)
 * @param scope — optional L2 engagement hosts; omit/empty = no origin filter
 */
export function planTrafficSurfaceSettle(
  exchange: {
    url?: string | null;
    method?: string | null;
    phase?: string | null;
    source?: string | null;
    purpose?: string | null;
    browser_resource_class?: string | null;
  },
  existing?: {
    status?: string;
    methods?: readonly string[] | null;
    params?: readonly string[] | null;
    case_tested?: boolean | null;
  } | null,
  scope?: TrafficSettleScopeContext | null,
): TrafficSettleDecision {
  if (!isTrafficSettlePhase(exchange.phase)) {
    return { settle: false, reason: "phase_not_terminal" };
  }

  const url = String(exchange.url || "").trim();
  if (!url) return { settle: false, reason: "empty_url" };

  const parsed = parseLocation(url);
  if (!parsed.ok) {
    return { settle: false, reason: `unparseable_url:${parsed.error}` };
  }
  if (!isHttpHttpsScheme(parsed.scheme)) {
    return { settle: false, reason: "non_http_scheme" };
  }
  if (isStaticSurfacePath(parsed.path_key)) {
    return { settle: false, reason: "static_denylist" };
  }
  if (hasGarbageToolPath(parsed.path_key)) {
    return { settle: false, reason: "garbage_path" };
  }
  if (isCollapsedOsProbePath(parsed.path_key, url)) {
    return { settle: false, reason: "collapsed_os_probe" };
  }
  if (!isUrlInEngagementScope(parsed.host, parsed.port, scope)) {
    return { settle: false, reason: "out_of_scope" };
  }

  const method = String(exchange.method || "GET").trim().toUpperCase() || "GET";
  const methods = mergeMethods(existing?.methods, [method]);
  const params = mergeParams(existing?.params, extractUrlParamNames(url));

  // Spec #413: classify purpose (explicit > tool default > heuristics).
  const purpose = classifyTrafficPurpose({
    purpose: exchange.purpose,
    source: exchange.source,
    method,
    url,
    browser_resource_class: exchange.browser_resource_class,
    scope: scope ?? null,
  });
  const marksTested = purposeMarksCaseTested(purpose);
  // Operator TESTED: single purpose=test is enough → elevate to touched immediately.
  // Non-test: first→seen / later multi-hit→touched for Graph bookkeeping only
  // (operator chip uses case_tested, not multi-hit alone).
  const statusFinal: "seen" | "touched" = marksTested
    ? "touched"
    : existing
      ? "touched"
      : "seen";
  const case_tested = marksTested;

  // Prefer a clean location without query/fragment for display stability.
  const location = surfaceLocationFromParsed(parsed, url);

  return {
    settle: true,
    location,
    origin_key: parsed.origin_key,
    path_key: parsed.path_key,
    kind: parsed.kind || "url",
    status: statusFinal,
    methods,
    params,
    source: "traffic",
    purpose,
    case_tested,
  };
}

function surfaceLocationFromParsed(parsed: ParsedLocationOk, fallbackUrl: string): string {
  // origin_key already has scheme://host:port; path_key is normalized path.
  if (parsed.path_key) {
    return `${parsed.origin_key}${parsed.path_key.startsWith("/") ? "" : "/"}${parsed.path_key}`;
  }
  return parsed.location || fallbackUrl;
}

function resolveSourceAgentId(runtime: ToolRuntime): string {
  const wa = runtime.lifecycle?.workerAudit?.agentId;
  if (wa != null && String(wa).trim()) return String(wa).trim();
  if ((runtime.lifecycle?.subagentDepth || 0) >= 1) return "worker";
  return "main";
}

/**
 * Apply Traffic → Surface settle against the runtime SQLite store + dual-write.
 * Never throws into the traffic collect path; returns structured result.
 * No-op when surfaceSqlite is missing (lab runtimes without ledger).
 */
export async function settleTrafficToSurface(
  runtime: ToolRuntime,
  exchange: TrafficExchange,
): Promise<TrafficSettleApplyResult> {
  try {
    const store = runtime.surfaceSqlite;
    if (!store) {
      return { ok: true, skipped: true, reason: "no_surface_store" };
    }

    // L2 scope from task TARGET + scope.allow (host set). Empty → no origin gate.
    const scope = trafficSettleScopeFromTask(runtime.task || {});

    // Cheap pure pre-check without DB (skip static / garbage / OOS / pending).
    // existing=null only affects requested status — skip reasons are identity-independent.
    const pre = planTrafficSurfaceSettle(exchange, null, scope);
    if (!pre.settle) {
      return { ok: true, skipped: true, reason: pre.reason };
    }

    await store.open();

    // Re-plan with existing identity for seen → touched + method merge.
    const existing = await store.get({
      origin_key: pre.origin_key,
      path_key: pre.path_key,
    });
    const plan = planTrafficSurfaceSettle(exchange, existing, scope);
    if (!plan.settle) {
      return { ok: true, skipped: true, reason: plan.reason };
    }

    const platformOnline = isSurfacePlatformOnline(runtime);
    // Omit item.source so existing provenance (e.g. target_seed) is preserved;
    // new rows get meta.source = traffic.
    // Spec #413: purpose=test → case_tested sticky + allowTested (touched).
    const result = await store.upsert(
      [
        {
          location: plan.location,
          methods: plan.methods,
          params: plan.params.length ? plan.params : undefined,
          status: plan.status,
          kind: plan.kind,
          // Only set true; never clear via settle (sticky in store).
          ...(plan.case_tested ? { case_tested: true } : {}),
        },
      ],
      {
        source_agent_id: resolveSourceAgentId(runtime),
        source: "traffic",
        platformOnline,
        // Traffic settle may elevate touched; case_tested only when purpose=test.
        allowTested: true,
        allowCaseTested: plan.case_tested,
      },
    );

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    const okResult = result as SurfaceUpsertResult;
    if (platformOnline && okResult.upserted.length) {
      void enqueueSurfacePlatformSync(runtime, okResult.upserted);
    }

    return {
      ok: true,
      skipped: false,
      created: okResult.created,
      updated: okResult.updated,
      row: okResult.upserted[0] ?? null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[node4] surface settle from traffic failed: ${message}`);
    return { ok: false, error: message };
  }
}

/**
 * Fire-and-forget settle for collect hooks. Swallows all errors.
 * Prefer this from emitHttpComplete / shell / browser drain paths.
 */
export function settleTrafficToSurfaceSafe(
  runtime: ToolRuntime,
  exchange: TrafficExchange,
): void {
  void settleTrafficToSurface(runtime, exchange).catch(() => {});
}
