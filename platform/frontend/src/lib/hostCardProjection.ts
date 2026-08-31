/**
 * Spec #541 — Case Surface Host-card projection.
 *
 * Pure: Workset t_host + Owner/Case Hosts ∩ Scope + surface_ledger + findings + Host-hung Intel
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

/** Same-machine identity: primary + aliases. Ambiguous keys do not pick the first Host. */
export type HostIdentity = {
  hostId?: string;
  address: string;
  aliases: string[];
};

export type HostCard = HostIdentity & {
  id: string;
  admission: HostCardAdmission;
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
  /** Case snapshot assets — not admission by themselves. */
  assets?: Array<Record<string, unknown>>;
  /** Owner ledger Hosts (Scope asset_ids / unique identity). */
  ownerAssets?: Array<Record<string, unknown>>;
  /** Structured task: target + scope.allow / scope.asset_ids. */
  taskContext?: Record<string, unknown> | null;
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

export function hostIdentityKeys(id: Pick<HostIdentity, "address" | "aliases">): Set<string> {
  const keys = new Set<string>();
  const addr = normalizeHostKey(id.address);
  if (addr) keys.add(addr);
  for (const a of id.aliases || []) {
    const k = normalizeHostKey(a);
    if (k) keys.add(k);
  }
  return keys;
}

/** Unique catalog row for one identity key. Zero or 2+ hits → null (never first-match). */
export function uniqueIdentityMatch<T extends HostIdentity>(catalog: T[], key: string): T | null {
  const k = normalizeHostKey(key);
  if (!k) return null;
  const hits = catalog.filter((row) => hostIdentityKeys(row).has(k));
  return hits.length === 1 ? hits[0]! : null;
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
    if (h && isValidLedgerAddress(h)) out.push(h);
  }
  return [...new Set(out)];
}

function parseHostRow(asset: Record<string, unknown>): HostIdentity | null {
  const hostId = assetIdOf(asset);
  const address = assetAddressOf(asset);
  if (!hostId || !address || !isValidLedgerAddress(address)) return null;
  const aliases = assetAliasesOf(asset).filter((a) => a !== address);
  return { hostId, address, aliases };
}

function taskRecord(taskContext?: Record<string, unknown> | null): Record<string, unknown> {
  if (!taskContext || typeof taskContext !== "object") return {};
  const nested = taskContext.task;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return taskContext;
}

function scopeAssetIds(taskContext?: Record<string, unknown> | null): string[] {
  const task = taskRecord(taskContext);
  const scope = task.scope && typeof task.scope === "object" ? (task.scope as Record<string, unknown>) : {};
  const raw = Array.isArray(scope.asset_ids)
    ? scope.asset_ids
    : Array.isArray(task.asset_ids)
      ? task.asset_ids
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const s = String(item || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function scopeHostKeys(taskContext?: Record<string, unknown> | null): string[] {
  const task = taskRecord(taskContext);
  const values: unknown[] = [];
  const target = task.target;
  if (typeof target === "string") values.push(target);
  if (target && typeof target === "object") {
    const rec = target as Record<string, unknown>;
    values.push(rec.value, rec.url, rec.host, rec.address);
  }
  const scope = task.scope && typeof task.scope === "object" ? (task.scope as Record<string, unknown>) : {};
  if (Array.isArray(scope.allow)) values.push(...scope.allow);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const h = extractHost(raw);
    if (!h || seen.has(h)) continue;
    seen.add(h);
    out.push(h);
  }
  return out;
}

function worksetMeta(item: WorksetItem): Pick<HostCard, "intelSource" | "attribution" | "confidence" | "scopeDecision"> {
  const payload = item.payload && typeof item.payload === "object" ? item.payload : {};
  return {
    intelSource: String(payload.intel_source || payload.source || "").trim() || undefined,
    attribution: String(payload.attribution || "").trim() || undefined,
    confidence: String(payload.confidence || "").trim() || undefined,
    scopeDecision: String(payload.scope_decision || "").trim() || undefined,
  };
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

function uniqueIndexFor(cards: HostCard[]): Map<string, HostCard> {
  const buckets = new Map<string, HostCard[]>();
  for (const card of cards) {
    for (const k of hostIdentityKeys(card)) {
      const list = buckets.get(k) || [];
      list.push(card);
      buckets.set(k, list);
    }
  }
  const unique = new Map<string, HostCard>();
  for (const [k, list] of buckets) {
    const ids = new Set(list.map((c) => c.id));
    if (ids.size === 1) unique.set(k, list[0]!);
  }
  return unique;
}

function admittedIdsFromScope(
  catalog: HostIdentity[],
  taskContext?: Record<string, unknown> | null,
): Set<string> {
  const ids = new Set<string>();
  for (const id of scopeAssetIds(taskContext)) {
    if (catalog.some((row) => row.hostId === id)) ids.add(id);
  }
  for (const key of scopeHostKeys(taskContext)) {
    const hit = uniqueIdentityMatch(catalog, key);
    if (hit?.hostId) ids.add(hit.hostId);
  }
  return ids;
}

export function uniqueCardForHost(cards: HostCard[], host: string): HostCard | null {
  const k = normalizeHostKey(extractHost(host) || host);
  if (!k) return null;
  return uniqueIdentityMatch(
    cards.filter((c) => c.admission === "admitted"),
    k,
  );
}

export function cardForFinding(cards: HostCard[], finding: Record<string, unknown>): HostCard | null {
  const aid = String(finding.asset_id || "").trim();
  if (aid) {
    const hits = cards.filter((c) => c.hostId === aid || c.id === aid);
    return hits.length === 1 ? hits[0]! : null;
  }
  const hits = new Set<HostCard>();
  for (const h of findingHostKeys(finding)) {
    const hit = uniqueIdentityMatch(cards, h);
    if (hit) hits.add(hit);
  }
  return hits.size === 1 ? [...hits][0]! : null;
}

export function projectHostCards(input: HostCardProjectionInput): HostCard[] {
  const workset = parseWorksetProjection(input.workset);
  const snapshotAssets = Array.isArray(input.assets) ? input.assets : [];
  const ownerAssets = Array.isArray(input.ownerAssets) ? input.ownerAssets : [];
  const catalogSource = ownerAssets.length ? ownerAssets : snapshotAssets;
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const intel = Array.isArray(input.intel) ? input.intel : [];
  const entries = projectSurfaceEntriesFromLedger(input.surfaceLedger);

  const catalog: HostIdentity[] = [];
  const seenHostIds = new Set<string>();
  for (const raw of catalogSource) {
    const row = parseHostRow(raw);
    if (!row?.hostId || seenHostIds.has(row.hostId)) continue;
    seenHostIds.add(row.hostId);
    catalog.push(row);
  }

  const admittedIds = admittedIdsFromScope(catalog, input.taskContext);

  const openItems = (workset.items || []).filter((i) => {
    const st = String(i.status || "");
    return st === "proposed" || st === "adopted";
  });
  for (const item of openItems) {
    if (String(item.family || "") !== "t_host") continue;
    if (String(item.status) !== "adopted") continue;
    const address = payloadHost(item);
    if (!address || !isValidLedgerAddress(address)) continue;
    const hit = uniqueIdentityMatch(catalog, address);
    if (hit?.hostId) admittedIds.add(hit.hostId);
  }

  const byId = new Map<string, HostCard>();
  for (const row of catalog) {
    if (!row.hostId || !admittedIds.has(row.hostId)) continue;
    byId.set(
      row.hostId,
      emptyCard({
        id: row.hostId,
        admission: "admitted",
        address: row.address,
        aliases: row.aliases,
        hostId: row.hostId,
      }),
    );
  }

  const mergeMeta = (card: HostCard, item: WorksetItem) => {
    const meta = worksetMeta(item);
    card.worksetItemId = item.id;
    card.intelSource = card.intelSource || meta.intelSource;
    card.attribution = card.attribution || meta.attribution;
    card.confidence = card.confidence || meta.confidence;
    card.scopeDecision = card.scopeDecision || meta.scopeDecision;
  };

  for (const item of openItems) {
    if (String(item.family || "") !== "t_host") continue;
    const address = payloadHost(item);
    if (!address || !isValidLedgerAddress(address)) continue;
    const adopted = String(item.status) === "adopted";
    const existing = [...byId.values()];
    const unique = uniqueIndexFor(existing);
    const hit = unique.get(address);
    if (hit) {
      mergeMeta(hit, item);
      continue;
    }
    const claimed = existing.filter((c) => hostIdentityKeys(c).has(address));
    if (claimed.length > 1) continue;
    if (adopted) {
      const catalogHit = uniqueIdentityMatch(catalog, address);
      if (catalogHit?.hostId && byId.has(catalogHit.hostId)) {
        mergeMeta(byId.get(catalogHit.hostId)!, item);
        continue;
      }
      byId.set(
        item.id,
        emptyCard({
          id: item.id,
          admission: "admitted",
          address,
          aliases: [],
          worksetItemId: item.id,
          ...worksetMeta(item),
        }),
      );
      continue;
    }
    byId.set(
      item.id,
      emptyCard({
        id: item.id,
        admission: "pending",
        address,
        aliases: [],
        worksetItemId: item.id,
        ...worksetMeta(item),
      }),
    );
  }

  const cards = [...byId.values()];
  const findingOwner = new Map<string, HostCard>();
  for (const finding of findings) {
    const owner = cardForFinding(cards, finding);
    if (!owner || owner.admission !== "admitted") continue;
    const fid = String(finding.id || "");
    if (fid && findingOwner.has(fid)) continue;
    if (fid) findingOwner.set(fid, owner);
    owner.findings.push(finding);
  }

  for (const entry of entries) {
    const owner = uniqueCardForHost(cards, entry.host);
    if (!owner || owner.admission !== "admitted") continue;
    owner.paths.push(entry);
  }

  for (const card of cards) {
    if (card.admission !== "admitted") continue;
    card.untestedCount = card.paths.filter((p) => (p.coverage || "untested") === "untested").length;
    card.isNew = card.paths.some((p) => p.isNew === true);
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
  return cardForFinding(cards, finding)?.id || null;
}
