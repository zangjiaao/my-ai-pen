/**
 * Session cookie / auth header merge for multi-step http/verifier/traffic probes.
 * Pulls from traffic snapshot + captured Set-Cookie responses so authenticated
 * high-security checks preserve cookies without target-specific profiles.
 */

import type { CapturedTraffic, ToolRuntime } from "../types.js";

/**
 * Merge auth material for the next request.
 * - actorId string: pin that actor only (no cross-actor snapshot pollution)
 * - actorId undefined: active actor + global snapshot/traffic (legacy single-session flow)
 * - actorId null: force unauthenticated
 * Explicit request headers always win over stored material.
 */
export function mergeSessionHeaders(
  runtime: ToolRuntime,
  headers: Record<string, string> = {},
  actorId?: string | null,
): Record<string, string> {
  const out = lowerKeyCopy(headers);
  const unauthenticated = actorId === null;
  const pinnedActor = typeof actorId === "string" && actorId.length > 0;

  if (!unauthenticated) {
    const actorHeaders = runtime.actors?.headersFor(pinnedActor ? actorId : undefined) || {};
    if (!out.cookie && !out.Cookie && actorHeaders.cookie) out.cookie = actorHeaders.cookie;
    if (!out.authorization && !out.Authorization && actorHeaders.authorization) out.authorization = actorHeaders.authorization;
    for (const [key, value] of Object.entries(actorHeaders)) {
      const lower = key.toLowerCase();
      if (lower === "cookie" || lower === "authorization") continue;
      if (out[key] === undefined && out[lower] === undefined) out[key] = value;
    }
  }

  // Only blend global snapshot/traffic when not pinning a named actor (avoids A/B cookie bleed).
  if (!unauthenticated && !pinnedActor) {
    const snapshotCookie = cookieFromSnapshot(runtime.traffic.snapshot());
    const trafficCookie = cookieFromTraffic(runtime.traffic.list({ limit: 100 }));
    const mergedCookie = mergeCookieHeader(snapshotCookie, trafficCookie, out.cookie || out.Cookie);
    if (mergedCookie) {
      out.cookie = mergedCookie;
      delete out.Cookie;
    }
    const auth =
      out.authorization ||
      out.Authorization ||
      authorizationFromSnapshot(runtime.traffic.snapshot()) ||
      authorizationFromTraffic(runtime.traffic.list({ limit: 50 }));
    if (auth && !out.authorization && !out.Authorization) {
      out.authorization = auth;
    }
  }

  if (unauthenticated) {
    if (!headers.authorization && !headers.Authorization) {
      delete out.authorization;
      delete out.Authorization;
    }
    if (!headers.cookie && !headers.Cookie) {
      delete out.cookie;
      delete out.Cookie;
    }
  }

  return out;
}

/** After a response, fold Set-Cookie values into the traffic snapshot cookie jar and active actor. */
export function rememberResponseCookies(
  runtime: ToolRuntime,
  responseHeaders: Record<string, string> | undefined,
  actorId?: string | null,
): void {
  if (!responseHeaders) return;
  const setCookie = responseHeaders["set-cookie"] || responseHeaders["Set-Cookie"];
  if (!setCookie) return;
  const incoming = parseSetCookieHeader(setCookie);
  if (!Object.keys(incoming).length) return;
  const snapshot = { ...(runtime.traffic.snapshot() || {}) };
  const existing = cookieMapFromHeader(String(snapshot.cookie || snapshot.cookies || ""));
  const next = { ...existing, ...incoming };
  snapshot.cookie = serializeCookieMap(next);
  snapshot.cookies = snapshot.cookie;
  runtime.traffic.setSnapshot(snapshot);

  // Keep the active/named actor cookie jar in sync so multi-actor state survives.
  const targetActorId = actorId === undefined ? runtime.actors?.activeIdValue() : actorId || undefined;
  if (targetActorId && runtime.actors) {
    const actor = runtime.actors.get(targetActorId);
    if (actor) {
      const actorCookies = cookieMapFromHeader(String(actor.headers.cookie || ""));
      const merged = { ...actorCookies, ...incoming };
      runtime.actors.upsert({
        id: targetActorId,
        headers: { ...actor.headers, cookie: serializeCookieMap(merged) },
      });
    }
  }
}

export function extractHtmlToken(html: string, names: string[] = ["user_token", "csrf", "csrf_token", "token", "nonce"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`name=["']${escaped}["'][^>]*value=["']([^"']+)["']`, "i"),
      new RegExp(`value=["']([^"']+)["'][^>]*name=["']${escaped}["']`, "i"),
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(html);
      if (match?.[1]) {
        out[name] = match[1];
        break;
      }
    }
  }
  return out;
}

function cookieFromSnapshot(snapshot: Record<string, unknown> | undefined): string {
  if (!snapshot) return "";
  if (typeof snapshot.cookie === "string" && snapshot.cookie.trim()) return snapshot.cookie;
  if (typeof snapshot.cookies === "string" && snapshot.cookies.trim()) return snapshot.cookies;
  if (snapshot.cookies && typeof snapshot.cookies === "object" && !Array.isArray(snapshot.cookies)) {
    return serializeCookieMap(snapshot.cookies as Record<string, unknown>);
  }
  if (snapshot.headers && typeof snapshot.headers === "object" && !Array.isArray(snapshot.headers)) {
    const headers = snapshot.headers as Record<string, unknown>;
    const cookie = headers.cookie || headers.Cookie;
    if (typeof cookie === "string") return cookie;
  }
  return "";
}

function authorizationFromSnapshot(snapshot: Record<string, unknown> | undefined): string | undefined {
  if (!snapshot) return undefined;
  if (typeof snapshot.authorization === "string" && snapshot.authorization.trim()) return snapshot.authorization;
  if (snapshot.headers && typeof snapshot.headers === "object" && !Array.isArray(snapshot.headers)) {
    const headers = snapshot.headers as Record<string, unknown>;
    const auth = headers.authorization || headers.Authorization;
    if (typeof auth === "string" && auth.trim()) return auth;
  }
  return undefined;
}

function cookieFromTraffic(rows: CapturedTraffic[]): string {
  const map: Record<string, string> = {};
  for (const row of rows) {
    const req = row.requestHeaders?.cookie || row.requestHeaders?.Cookie;
    Object.assign(map, cookieMapFromHeader(req || ""));
    const setCookie = row.responseHeaders?.["set-cookie"] || row.responseHeaders?.["Set-Cookie"];
    if (setCookie) Object.assign(map, parseSetCookieHeader(setCookie));
  }
  return serializeCookieMap(map);
}

function authorizationFromTraffic(rows: CapturedTraffic[]): string | undefined {
  for (const row of rows) {
    const auth = row.requestHeaders?.authorization || row.requestHeaders?.Authorization;
    if (auth) return auth;
  }
  return undefined;
}

function mergeCookieHeader(...parts: Array<string | undefined>): string {
  const map: Record<string, string> = {};
  for (const part of parts) Object.assign(map, cookieMapFromHeader(part || ""));
  return serializeCookieMap(map);
}

function cookieMapFromHeader(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const piece of header.split(";")) {
    const trimmed = piece.trim();
    if (!trimmed || !trimmed.includes("=")) continue;
    const eq = trimmed.indexOf("=");
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!key || /^(Path|Domain|Expires|Max-Age|Secure|HttpOnly|SameSite)$/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

function parseSetCookieHeader(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Multiple cookies may be comma-joined; split carefully on comma only before a new name=
  const parts = header.split(/,(?=\s*[^;,\s]+=)/);
  for (const part of parts) {
    const first = part.split(";")[0] || "";
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const key = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function serializeCookieMap(map: Record<string, unknown>): string {
  return Object.entries(map)
    .filter(([key, value]) => key && value !== undefined && value !== null && String(value).length > 0)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("; ");
}

function lowerKeyCopy(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    out[key] = String(value);
  }
  return out;
}
