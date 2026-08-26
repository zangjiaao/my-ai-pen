/**
 * Spec #413 / L3 — Traffic exchange purpose classification.
 *
 * purpose = test | browse | setup | noise | unknown
 * Audit axis only — does not write operator TESTED / coverage work-state (#518).
 *
 * Order: explicit declaration → tool-family defaults → heuristics.
 */

import { parseLocation } from "../stores/surface-identity.js";

export const TRAFFIC_PURPOSES = [
  "test",
  "browse",
  "setup",
  "noise",
  "unknown",
] as const;

export type TrafficPurpose = (typeof TRAFFIC_PURPOSES)[number];

/** Optional engagement hosts for OOS → noise (same shape as settle scope). */
export type TrafficPurposeScope = {
  allowedHosts?: ReadonlySet<string> | readonly string[] | null;
};

/** True when value is a known purpose enum (case-insensitive). */
export function isTrafficPurpose(value: unknown): value is TrafficPurpose {
  if (value == null) return false;
  const s = String(value).trim().toLowerCase();
  return (TRAFFIC_PURPOSES as readonly string[]).includes(s);
}

/** Normalize to enum or null when invalid/empty. */
export function normalizeTrafficPurpose(value: unknown): TrafficPurpose | null {
  if (!isTrafficPurpose(value)) return null;
  return String(value).trim().toLowerCase() as TrafficPurpose;
}

/** HTTP methods that are inherently probe/mutate (heuristic → test). */
const WRITE_METHODS = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "CONNECT",
  "TRACE",
]);

/**
 * Path shapes that look like security probes even on GET (heuristic → test).
 * Conservative — tool declaration / shell default already covers most curls.
 */
const PROBE_PATH_RE =
  /(?:^|\/)(?:etc\/passwd|windows\/win\.ini|win\.ini|boot\.ini|proc\/self|cgi-bin|\.git(?:\/|$)|wp-config|\.env(?:\.|$)|phpinfo|actuator|jolokia|server-status|server-info)(?:\/|$)/i;

const TRAVERSAL_IN_PATH_RE = /(?:\.\.|%2e%2e)/i;

export type ClassifyTrafficPurposeInput = {
  /** Explicit declaration (highest priority when valid). */
  purpose?: string | null;
  /** Traffic source: http | browser | shell | mitm | (session acts use http). */
  source?: string | null;
  method?: string | null;
  url?: string | null;
  /** Browser resource class (document/xhr/…); navigation docs stay browse. */
  browser_resource_class?: string | null;
  /**
   * When true, tool family default is setup (TARGET seed).
   * Prefer explicit purpose=setup; this is a convenience for seed emitters.
   */
  is_target_seed?: boolean | null;
  /** Optional L2 scope for OOS → noise heuristic. */
  scope?: TrafficPurposeScope | null;
};

function normalizeHost(host: string): string {
  let h = String(host || "").trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h;
}

function hasGarbageToolPathLocal(pathOrUrl: string): boolean {
  return pathOrUrl.includes("${") || pathOrUrl.includes("{{");
}

function isHostInScope(
  host: string,
  scope?: TrafficPurposeScope | null,
): boolean {
  if (!scope) return true;
  const raw = scope.allowedHosts;
  if (raw == null) return true;
  const set =
    raw instanceof Set
      ? new Set([...raw].map((h) => normalizeHost(String(h))).filter(Boolean))
      : new Set([...raw].map((h) => normalizeHost(String(h))).filter(Boolean));
  if (set.size === 0) return true;
  const h = normalizeHost(host);
  if (!h) return false;
  if (set.has(h)) return true;
  if (h.includes(":") && set.has(`[${h}]`)) return true;
  return false;
}

/**
 * Tool-family default when purpose is not declared.
 * - shell / http / mitm / session → test (pentest seat act traffic)
 * - browser ordinary navigation → browse
 * - TARGET seed → setup
 * - unknown source → null (caller applies heuristics → unknown)
 */
export function toolFamilyPurposeDefault(
  source?: string | null,
  opts?: {
    browser_resource_class?: string | null;
    is_target_seed?: boolean | null;
  },
): TrafficPurpose | null {
  if (opts?.is_target_seed) return "setup";
  const src = String(source || "")
    .trim()
    .toLowerCase();
  if (src === "shell" || src === "http" || src === "mitm" || src === "session") {
    return "test";
  }
  if (src === "browser") {
    // Ordinary navigation / resource loads default to browse.
    // XHR/fetch stay browse unless heuristics upgrade to test.
    return "browse";
  }
  if (src === "target_seed" || src === "seed") return "setup";
  return null;
}

/** Write / mutate methods → test heuristic. */
export function isWriteHttpMethod(method?: string | null): boolean {
  const m = String(method || "GET")
    .trim()
    .toUpperCase();
  return WRITE_METHODS.has(m);
}

/** Clear probe path shape (path traversal residue, well-known probe targets). */
export function hasProbePathShape(urlOrPath?: string | null): boolean {
  const raw = String(urlOrPath || "");
  if (!raw) return false;
  let path = raw;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      path = new URL(raw).pathname || raw;
    }
  } catch {
    /* use raw */
  }
  if (TRAVERSAL_IN_PATH_RE.test(path) || TRAVERSAL_IN_PATH_RE.test(raw)) return true;
  if (PROBE_PATH_RE.test(path)) return true;
  return false;
}

/**
 * Classify exchange purpose (pure).
 *
 * 1. Explicit valid purpose wins.
 * 2. Noise heuristics (OOS / garbage path) when detectable.
 * 3. Tool-family defaults (shell/http→test, browser→browse, seed→setup).
 * 4. Write methods / probe shapes → test (upgrade browse/unknown; not setup).
 * 5. Else default or unknown (fail-closed for TESTED).
 */
export function classifyTrafficPurpose(input: ClassifyTrafficPurposeInput): TrafficPurpose {
  const explicit = normalizeTrafficPurpose(input.purpose);
  if (explicit) return explicit;

  const url = String(input.url || "").trim();
  let pathKey = "";
  let host = "";
  if (url) {
    const parsed = parseLocation(url);
    if (parsed.ok) {
      pathKey = parsed.path_key || "";
      host = parsed.host || "";
    } else {
      try {
        const u = new URL(url);
        pathKey = u.pathname || "";
        host = u.hostname || "";
      } catch {
        pathKey = url;
      }
    }
  }

  // Noise heuristics (garbage path / OOS) before family default.
  if (pathKey && hasGarbageToolPathLocal(pathKey)) return "noise";
  if (url && hasGarbageToolPathLocal(url)) return "noise";
  if (host && input.scope) {
    const raw = input.scope.allowedHosts;
    const hasGate =
      raw != null &&
      (raw instanceof Set ? raw.size > 0 : Array.isArray(raw) && raw.length > 0);
    if (hasGate && !isHostInScope(host, input.scope)) {
      return "noise";
    }
  }

  const family = toolFamilyPurposeDefault(input.source, {
    browser_resource_class: input.browser_resource_class,
    is_target_seed: input.is_target_seed,
  });

  // Upgrade browse / unknown / missing family to test when shape is clearly a probe.
  if (isWriteHttpMethod(input.method) || hasProbePathShape(url) || hasProbePathShape(pathKey)) {
    // Seed stays setup unless explicitly overridden (already handled).
    if (family !== "setup") return "test";
  }

  if (family) return family;
  return "unknown";
}

/**
 * Attach purpose onto a traffic-shaped object.
 * Uses existing purpose if already valid; else classifies.
 */
export function withClassifiedPurpose<T extends Record<string, unknown>>(
  exchange: T,
  scope?: TrafficPurposeScope | null,
): T & { purpose: TrafficPurpose } {
  const purpose = classifyTrafficPurpose({
    purpose: (exchange as { purpose?: unknown }).purpose as string | null | undefined,
    source: (exchange as { source?: unknown }).source as string | null | undefined,
    method: (exchange as { method?: unknown }).method as string | null | undefined,
    url: (exchange as { url?: unknown }).url as string | null | undefined,
    browser_resource_class: (exchange as { browser_resource_class?: unknown })
      .browser_resource_class as string | null | undefined,
    is_target_seed: (exchange as { is_target_seed?: unknown }).is_target_seed as
      | boolean
      | null
      | undefined,
    scope,
  });
  return { ...exchange, purpose };
}

/** Audit: purpose=test historically marked case_tested. Does not write coverage (#518). */
export function purposeMarksCaseTested(
  purpose: TrafficPurpose | string | null | undefined,
): boolean {
  return normalizeTrafficPurpose(purpose) === "test";
}
