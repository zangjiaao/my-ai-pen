/**
 * Spec #368 / #380 — Traffic complete → Surface settle (D6 / D6.1).
 *
 * Pure decision + Node integration:
 *   HTTP(S) exchange complete/fail → identity (origin_key + path_key)
 *   → first hit seen, later touched; merge methods
 *   → static suffix denylist skips asset paths
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
import {
  enqueueSurfacePlatformSync,
  isSurfacePlatformOnline,
} from "./surface-platform-sync.js";
import type { TrafficExchange } from "./traffic-collect.js";

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
};

export type TrafficSettleDecision = TrafficSettleSkip | TrafficSettlePlan;

export type TrafficSettleApplyResult =
  | { ok: true; skipped: true; reason: string }
  | { ok: true; skipped: false; created: number; updated: number; row: SurfaceRow | null }
  | { ok: false; error: string };

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
 * @param exchange — traffic row (url/method/phase required for eligibility)
 * @param existing — prior Surface row for this identity, if any (null/undefined = first hit)
 */
export function planTrafficSurfaceSettle(
  exchange: {
    url?: string | null;
    method?: string | null;
    phase?: string | null;
  },
  existing?: { status?: string; methods?: readonly string[] | null; params?: readonly string[] | null } | null,
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

  const method = String(exchange.method || "GET").trim().toUpperCase() || "GET";
  const methods = mergeMethods(existing?.methods, [method]);
  const params = mergeParams(existing?.params, extractUrlParamNames(url));
  const status: "seen" | "touched" = existing ? "touched" : "seen";

  // Prefer a clean location without query/fragment for display stability.
  const location = surfaceLocationFromParsed(parsed, url);

  return {
    settle: true,
    location,
    origin_key: parsed.origin_key,
    path_key: parsed.path_key,
    kind: parsed.kind || "url",
    status,
    methods,
    params,
    source: "traffic",
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

    // Cheap pure pre-check without DB (skip static / non-http / pending).
    // existing=null only affects requested status — skip reasons are identity-independent.
    const pre = planTrafficSurfaceSettle(exchange, null);
    if (!pre.settle) {
      return { ok: true, skipped: true, reason: pre.reason };
    }

    await store.open();

    // Re-plan with existing identity for seen → touched + method merge.
    const existing = await store.get({
      origin_key: pre.origin_key,
      path_key: pre.path_key,
    });
    const plan = planTrafficSurfaceSettle(exchange, existing);
    if (!plan.settle) {
      return { ok: true, skipped: true, reason: plan.reason };
    }

    const platformOnline = isSurfacePlatformOnline(runtime);
    // Omit item.source so existing provenance (e.g. target_seed) is preserved;
    // new rows get meta.source = traffic.
    const result = await store.upsert(
      [
        {
          location: plan.location,
          methods: plan.methods,
          params: plan.params.length ? plan.params : undefined,
          status: plan.status,
          kind: plan.kind,
        },
      ],
      {
        source_agent_id: resolveSourceAgentId(runtime),
        source: "traffic",
        platformOnline,
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
