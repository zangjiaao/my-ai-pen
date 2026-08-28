/**
 * Spec #311 — settle → Case Workset candidate emit (Free + Hard).
 *
 * Host mechanical gate lives on platform; Node emits proposed candidates only.
 * Families: t_surface (in-scope deepen), t_host (OOS host; human confirm).
 */

import {
  buildAttackSurfaceCandidates,
  type AttackSurfaceCandidate,
  scopeHostsFromTask,
} from "./attack-surface.js";
/** Minimal open-surface row for Workset emit (SQLite or legacy ledger). */
export type WorksetOpenSurface = {
  location: string;
  path_key: string;
  kind?: string;
  status: string;
  /** Legacy ledger fields (optional; not required for emit). */
  id?: string;
  updated_at?: string;
};

export type WorksetFamily = "t_surface" | "t_host";

export type WorksetCandidate = {
  family: WorksetFamily;
  title: string;
  summary?: string;
  host?: string;
  port?: string;
  urls?: string[];
  location?: string;
  path_key?: string;
  kind?: string;
  in_scope: boolean;
  source: string;
  suggested_expert?: string;
  /** Spec #532 — passive exposure provenance (CT/DNS/Shodan-class). */
  intel_source?: string;
  attribution?: string;
  confidence?: string;
  scope_decision?: string;
  passive?: boolean;
};

function hostFromLocation(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s)
      ? s
      : s.startsWith("//")
        ? `http:${s}`
        : "";
    if (withScheme || s.includes("://")) {
      const u = new URL(withScheme || s);
      return (u.hostname || "").toLowerCase();
    }
  } catch {
    /* ignore */
  }
  const m = s.match(
    /(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}|localhost|host\.docker\.internal|\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?/i,
  );
  return m?.[1]?.toLowerCase() || "";
}

/**
 * Map free-path attack-surface / next-scope candidates into Workset proposed rows.
 * OOS hosts → t_host; in-scope hosts with URLs can emit t_surface deepen rows.
 */
export function worksetCandidatesFromAttackSurface(
  candidates: AttackSurfaceCandidate[],
  options?: { source?: string },
): WorksetCandidate[] {
  const source = options?.source || "free_settle";
  const out: WorksetCandidate[] = [];
  for (const c of candidates) {
    if (!c?.host) continue;
    if (!c.in_scope) {
      out.push({
        family: "t_host",
        title: c.port ? `${c.host}:${c.port}` : c.host,
        summary: `Out-of-scope host ${c.host}`,
        host: c.host,
        port: c.port,
        urls: c.urls?.slice(0, 12),
        in_scope: false,
        source,
      });
      continue;
    }
    // In-scope: each URL/path as t_surface deepen candidate when present.
    const urls = c.urls?.length ? c.urls : [];
    if (urls.length === 0) {
      // Host-only in-scope row is not a deepen surface (no executable path).
      continue;
    }
    for (const url of urls.slice(0, 20)) {
      out.push({
        family: "t_surface",
        title: url.slice(0, 200),
        summary: `Deepen in-scope surface ${url}`.slice(0, 240),
        host: c.host,
        port: c.port,
        location: url,
        urls: [url],
        in_scope: true,
        source,
      });
    }
  }
  return out;
}

/**
 * Hard Graph settle: open/in_probe surface ledger → t_surface; OOS finding hosts → t_host.
 */
export function worksetCandidatesFromHardSettle(options: {
  task: { target?: Record<string, unknown>; scope?: Record<string, unknown> };
  openSurfaces?: WorksetOpenSurface[];
  locationStrings?: string[];
  source?: string;
}): WorksetCandidate[] {
  const source = options.source || "hard_settle";
  const scope = scopeHostsFromTask(options.task);
  const out: WorksetCandidate[] = [];
  const seen = new Set<string>();

  for (const s of options.openSurfaces || []) {
    const location = String(s.location || s.path_key || "").trim();
    if (!location) continue;
    const host = hostFromLocation(location);
    const inScope = !host || scope.has(host);
    if (!inScope) {
      // Surface ledger is normally in-scope; if host is OOS treat as t_host.
      const key = `t_host:${host}`;
      if (host && !seen.has(key)) {
        seen.add(key);
        out.push({
          family: "t_host",
          title: host,
          summary: `Out-of-scope host from surface ledger ${host}`,
          host,
          in_scope: false,
          source,
        });
      }
      continue;
    }
    const key = `t_surface:${s.path_key || location}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      family: "t_surface",
      title: (s.path_key || location).slice(0, 200),
      summary: `Untested surface (${s.status}) ${location}`.slice(0, 240),
      host: host || undefined,
      location,
      path_key: s.path_key,
      kind: s.kind,
      in_scope: true,
      source,
    });
  }

  // Finding locations may reveal OOS hosts Hard path previously dropped.
  if (options.locationStrings?.length) {
    const attack = buildAttackSurfaceCandidates({
      task: options.task,
      locationStrings: options.locationStrings,
    });
    for (const row of worksetCandidatesFromAttackSurface(attack, { source })) {
      const key =
        row.family === "t_host"
          ? `t_host:${row.host}|${row.port || ""}`
          : `t_surface:${row.location || row.path_key || ""}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  }

  return out;
}

/** Drop hollow / non-executable candidates before wire (platform re-gates). */
export function filterEmitableWorksetCandidates(
  candidates: WorksetCandidate[],
): WorksetCandidate[] {
  return candidates.filter((c) => {
    if (!c || (c.family !== "t_surface" && c.family !== "t_host")) return false;
    if (c.family === "t_host") {
      return Boolean(c.host && String(c.host).trim().length >= 2);
    }
    const loc = String(c.location || c.path_key || "").trim();
    return loc.length >= 2;
  });
}
