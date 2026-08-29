/**
 * Spec #541 — Case Surface Host-card projection.
 *
 * Pure: Workset t_host + Case assets + surface_ledger + findings + Host-hung Intel
 * → operator Host cards. Tool-platform ledger origins are omitted.
 */
import type { IntelRow } from "./intelView.ts";
import {
  projectSurfaceEntriesFromLedger,
  type SurfaceEntry,
  type SurfaceLedger,
} from "./surfaceModel.ts";
import { parseWorksetProjection, type WorksetItem, type WorksetProjection } from "./workset.ts";

export type HostCardAdmission = "pending" | "admitted";

export type HostCardViewFilter = "all" | "pending" | "admitted" | "untested" | "findings";

export type HostCard = {
  id: string;
  admission: HostCardAdmission;
  address: string;
  aliases: string[];
  hostId?: string;
  worksetItemId?: string;
  intelSource?: string;
  attribution?: string;
  confidence?: string;
  scopeDecision?: string;
  findingCount: number;
  untestedCount: number;
  isNew: boolean;
  paths: SurfaceEntry[];
  findings: Array<Record<string, unknown>>;
  intel: IntelRow[];
};

export type HostCardProjectionInput = {
  workset?: WorksetProjection | Record<string, unknown> | null;
  surfaceLedger?: SurfaceLedger | null;
  assets?: Array<Record<string, unknown>>;
  findings?: Array<Record<string, unknown>>;
  intel?: IntelRow[];
};

const REJECT_TOKENS = new Set([
  "unknown",
  "n/a",
  "na",
  "none",
  "null",
  "-",
  "undefined",
  "localhost.localdomain",
]);
const FILE_LIKE_EXT =
  /\.(?:php|phtml|asp|aspx|jsp|jspx|cgi|pl|py|rb|js|mjs|ts|css|html?|htm|shtml|json|xml|txt|map|woff2?|ttf|eot|svg|png|jpe?g|gif|ico|pdf|zip|tar|gz|rar|sql|bak|old|swf|do|action)(?:\?.*)?$/i;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const HOSTISH =
  /^(?:localhost|host\.docker\.internal|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,})$/i;

export function normalizeHostKey(value: string): string {
  let h = String(value || "").trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

export function extractHost(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
      ? raw
      : raw.startsWith("//")
        ? `http:${raw}`
        : "";
    if (withScheme || raw.includes("://")) {
      const u = new URL(withScheme || raw);
      const host = normalizeHostKey(u.hostname || "");
      if (host) return host;
    }
  } catch {
    /* ignore */
  }
  const m = raw.match(
    /^(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}|localhost|host\.docker\.internal|\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?/i,
  );
  return m?.[1] ? normalizeHostKey(m[1]) : normalizeHostKey(raw.split("/")[0] || "");
}

export function isValidLedgerAddress(value: unknown): boolean {
  const raw = String(value || "").trim().replace(/^['"]|['"]$/g, "");
  if (!raw) return false;
  if (raw.includes("*")) return false;
  if (REJECT_TOKENS.has(raw.toLowerCase())) return false;
  if (raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../")) return false;
  const bare = raw.split("?", 1)[0]!.replace(/\/+$/, "");
  if (!bare.includes("/") && !bare.includes("\\") && FILE_LIKE_EXT.test(bare)) return false;
  const host = extractHost(raw);
  if (!host || REJECT_TOKENS.has(host) || host.includes("*")) return false;
  if (FILE_LIKE_EXT.test(host)) return false;
  if (IPV4.test(host)) return host.split(".").every((p) => {
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
  return HOSTISH.test(host);
}

function payloadHost(item: WorksetItem): string {
  const payload = item.payload && typeof item.payload === "object" ? item.payload : {};
  for (const key of ["host", "address", "url", "location"] as const) {
    const h = extractHost(payload[key]);
    if (h) return h;
  }
  return extractHost(item.title);
}

function assetIdOf(asset: Record<string, unknown>): string {
  return String(asset.id || asset.asset_id || "").trim();
}

function assetAddressOf(asset: Record<string, unknown>): string {
  return extractHost(asset.address || asset.host || asset.value);
}

function assetAliasesOf(asset: Record<string, unknown>): string[] {
  const out: string[] = [];
  const props =
    asset.properties && typeof asset.properties === "object"
      ? (asset.properties as Record<string, unknown>)
      : {};
  const raw = asset.aliases || props.aliases;
  const list = Array.isArray(raw) ? raw : [];
  for (const item of list) {
    let v = "";
    if (typeof item === "string") v = item;
    else if (item && typeof item === "object") {
      const row = item as Record<string, unknown>;
      v = String(row.value || row.address || row.host || "").trim();
    }
    const h = extractHost(v);
    if (h) out.push(h);
  }
  return [...new Set(out)];
}

function identityKeys(address: string, aliases: string[]): Set<string> {
  const keys = new Set<string>();
  if (address) keys.add(address);
  for (const a of aliases) if (a) keys.add(a);
  return keys;
}

function findingHostKeys(finding: Record<string, unknown>): string[] {
  const keys: string[] = [];
  for (const key of ["host", "address", "location", "url", "poc"] as const) {
    const h = extractHost(finding[key]);
    if (h) keys.push(h);
  }
  return keys;
}

function emptyCard(partial: Omit<HostCard, "findingCount" | "untestedCount" | "isNew" | "paths" | "findings" | "intel"> & Partial<HostCard>): HostCard {
  return {
    findingCount: 0,
    untestedCount: 0,
    isNew: false,
    paths: [],
    findings: [],
    intel: [],
    ...partial,
    aliases: partial.aliases ?? [],
  };
}

export function projectHostCards(input: HostCardProjectionInput): HostCard[] {
  const workset = parseWorksetProjection(input.workset);
  const assets = Array.isArray(input.assets) ? input.assets : [];
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const intel = Array.isArray(input.intel) ? input.intel : [];
  const entries = projectSurfaceEntriesFromLedger(input.surfaceLedger);

  const byAddress = new Map<string, HostCard>();

  const put = (card: HostCard) => {
    const key = card.address;
    if (!key) return;
    const prev = byAddress.get(key);
    if (!prev) {
      byAddress.set(key, card);
      return;
    }
    if (prev.admission === "admitted" && card.admission === "pending") {
      byAddress.set(key, {
        ...prev,
        worksetItemId: card.worksetItemId || prev.worksetItemId,
        intelSource: prev.intelSource || card.intelSource,
        attribution: prev.attribution || card.attribution,
        confidence: prev.confidence || card.confidence,
        scopeDecision: prev.scopeDecision || card.scopeDecision,
      });
      return;
    }
    if (card.admission === "admitted") {
      byAddress.set(key, {
        ...card,
        worksetItemId: prev.worksetItemId || card.worksetItemId,
        intelSource: card.intelSource || prev.intelSource,
        attribution: card.attribution || prev.attribution,
        aliases: [...new Set([...card.aliases, ...prev.aliases])],
      });
    }
  };

  for (const asset of assets) {
    const id = assetIdOf(asset);
    const address = assetAddressOf(asset);
    if (!id || !address || !isValidLedgerAddress(address)) continue;
    const aliases = assetAliasesOf(asset).filter((a) => a !== address);
    put(
      emptyCard({
        id,
        admission: "admitted",
        address,
        aliases,
        hostId: id,
      }),
    );
  }

  const openItems = (workset.items || []).filter((i) => {
    const st = String(i.status || "");
    return st === "proposed" || st === "adopted";
  });
  for (const item of openItems) {
    if (String(item.family || "") !== "t_host") continue;
    const address = payloadHost(item);
    if (!address || !isValidLedgerAddress(address)) continue;
    const payload = item.payload && typeof item.payload === "object" ? item.payload : {};
    const adopted = String(item.status) === "adopted";
    const existing = byAddress.get(address);
    if (adopted && existing?.admission === "admitted") {
      put(
        emptyCard({
          ...existing,
          worksetItemId: item.id,
          intelSource: String(payload.intel_source || payload.source || "").trim() || undefined,
          attribution: String(payload.attribution || "").trim() || undefined,
          confidence: String(payload.confidence || "").trim() || undefined,
          scopeDecision: String(payload.scope_decision || "").trim() || undefined,
        }),
      );
      continue;
    }
    put(
      emptyCard({
        id: adopted && existing?.hostId ? existing.hostId : item.id,
        admission: adopted ? "admitted" : "pending",
        address,
        aliases: existing?.aliases || [],
        hostId: existing?.hostId,
        worksetItemId: item.id,
        intelSource: String(payload.intel_source || payload.source || "").trim() || undefined,
        attribution: String(payload.attribution || "").trim() || undefined,
        confidence: String(payload.confidence || "").trim() || undefined,
        scopeDecision: String(payload.scope_decision || "").trim() || undefined,
      }),
    );
  }

  const cards = [...byAddress.values()];

  for (const card of cards) {
    if (card.admission !== "admitted") continue;
    const keys = identityKeys(card.address, card.aliases);
    card.paths = entries.filter((e) => keys.has(normalizeHostKey(e.host)));
    card.untestedCount = card.paths.filter((p) => (p.coverage || "untested") === "untested").length;
    card.isNew = card.paths.some((p) => p.isNew === true);
    card.findings = findings.filter((f) => {
      const aid = String(f.asset_id || "").trim();
      if (card.hostId && aid && aid === card.hostId) return true;
      return findingHostKeys(f).some((h) => keys.has(h));
    });
    card.findingCount = card.findings.length;
    if (card.hostId) {
      card.intel = intel.filter((row) => String(row.asset_id || "").trim() === card.hostId);
    }
  }

  return cards.sort((a, b) => {
    if (a.admission !== b.admission) return a.admission === "pending" ? -1 : 1;
    return a.address.localeCompare(b.address);
  });
}

export function filterHostCards(
  cards: HostCard[],
  query: string,
  filter: HostCardViewFilter,
): HostCard[] {
  const q = query.trim().toLowerCase();
  return cards.filter((card) => {
    if (filter === "pending" && card.admission !== "pending") return false;
    if (filter === "admitted" && card.admission !== "admitted") return false;
    if (filter === "untested" && !(card.admission === "admitted" && card.untestedCount > 0)) return false;
    if (filter === "findings" && card.findingCount <= 0) return false;
    if (!q) return true;
    const blob = [card.address, ...card.aliases].join(" ").toLowerCase();
    return blob.includes(q);
  });
}

export function hostCardIdForFinding(cards: HostCard[], finding: Record<string, unknown>): string | null {
  const aid = String(finding.asset_id || "").trim();
  if (aid) {
    const byId = cards.find((c) => c.hostId === aid || c.id === aid);
    if (byId) return byId.id;
  }
  for (const h of findingHostKeys(finding)) {
    const hit = cards.find((c) => identityKeys(c.address, c.aliases).has(h));
    if (hit) return hit.id;
  }
  return null;
}
