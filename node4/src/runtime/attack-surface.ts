/**
 * Attack-surface candidates (out of current Scope) — not formal assets.
 * Used for post-task next-Scope selection; never auto-inserts ledger hosts.
 */

export type AttackSurfaceCandidate = {
  host: string;
  port?: string;
  urls: string[];
  source: string;
  in_scope: boolean;
};

function parseHostPort(raw: string): { host: string; port?: string } {
  const s = String(raw || "").trim();
  if (!s) return { host: "" };
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : s.startsWith("//") ? `http:${s}` : "";
    if (withScheme || s.includes("://")) {
      const u = new URL(withScheme || s);
      const host = (u.hostname || "").toLowerCase();
      if (host) return { host, port: u.port || undefined };
    }
  } catch {
    /* ignore */
  }
  const m = s.match(
    /(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}|localhost|host\.docker\.internal|\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?/i,
  );
  if (m) return { host: m[1]!.toLowerCase(), port: m[2] };
  return { host: "" };
}

export function scopeHostsFromTask(task: {
  target?: Record<string, unknown>;
  scope?: Record<string, unknown>;
}): Set<string> {
  const out = new Set<string>();
  const target = task.target && typeof task.target === "object" ? task.target : {};
  const tval = String(
    (target as { value?: unknown }).value
      ?? (target as { url?: unknown }).url
      ?? (target as { host?: unknown }).host
      ?? "",
  ).trim();
  const th = parseHostPort(tval).host;
  if (th) out.add(th);
  const allow = task.scope && typeof task.scope === "object"
    ? (task.scope as { allow?: unknown }).allow
    : undefined;
  if (Array.isArray(allow)) {
    for (const item of allow) {
      const h = parseHostPort(String(item || "")).host;
      if (h) out.add(h);
    }
  }
  return out;
}

/**
 * Build candidate list from finding locations / URLs seen this burst.
 * Hosts already in Scope are marked in_scope=true (UI may filter them out).
 */
export function buildAttackSurfaceCandidates(options: {
  task: { target?: Record<string, unknown>; scope?: Record<string, unknown> };
  locationStrings: string[];
}): AttackSurfaceCandidate[] {
  const scope = scopeHostsFromTask(options.task);
  const byKey = new Map<string, AttackSurfaceCandidate>();
  for (const raw of options.locationStrings) {
    const { host, port } = parseHostPort(raw);
    if (!host) continue;
    const key = `${host}|${port || ""}`;
    const inScope = scope.has(host);
    const prev = byKey.get(key);
    const url = String(raw || "").trim();
    if (prev) {
      if (url && url.includes("://") && !prev.urls.includes(url)) {
        prev.urls.push(url.slice(0, 300));
      }
      continue;
    }
    byKey.set(key, {
      host,
      port,
      urls: url.includes("://") ? [url.slice(0, 300)] : [],
      source: "finding_location",
      in_scope: inScope,
    });
  }
  return [...byKey.values()];
}
