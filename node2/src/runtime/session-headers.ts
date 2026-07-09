/**
 * Session cookie / auth header merge for multi-step http/verifier/traffic probes.
 * Pulls from traffic snapshot + captured Set-Cookie responses so authenticated
 * high-security checks preserve cookies without target-specific profiles.
 */

import type { CapturedTraffic, ToolRuntime } from "../types.js";

export function mergeSessionHeaders(
  runtime: ToolRuntime,
  headers: Record<string, string> = {},
): Record<string, string> {
  const out = lowerKeyCopy(headers);
  const snapshotCookie = cookieFromSnapshot(runtime.traffic.snapshot());
  const trafficCookie = cookieFromTraffic(runtime.traffic.list({ limit: 100 }));
  const mergedCookie = mergeCookieHeader(snapshotCookie, trafficCookie, out.cookie || out.Cookie);
  if (mergedCookie) {
    out.cookie = mergedCookie;
    delete out.Cookie;
  }
  const auth = authorizationFromSnapshot(runtime.traffic.snapshot()) || authorizationFromTraffic(runtime.traffic.list({ limit: 50 }));
  if (auth && !out.authorization && !out.Authorization) {
    out.authorization = auth;
  }
  return out;
}

/** After a response, fold Set-Cookie values into the traffic snapshot cookie jar. */
export function rememberResponseCookies(runtime: ToolRuntime, responseHeaders: Record<string, string> | undefined): void {
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
