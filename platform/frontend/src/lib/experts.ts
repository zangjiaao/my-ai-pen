/**
 * Expert / role-pack catalog for multi-expert Node UI.
 * Structured engagement ids only — never derived from free-text NLP.
 * Mirrors platform expert_offers + Node4 role packs.
 */

export type ExpertId = "pentest" | "ctf" | "consult";

export type ExpertPackMeta = {
  id: ExpertId;
  /** Short label for chips / selects */
  label: string;
  /** One-line purpose */
  description: string;
  /** Whether this is the commercial default when offers is empty */
  isDefault?: boolean;
};

/** Catalog of installable expert packs (known to platform). */
export const EXPERT_PACKS: readonly ExpertPackMeta[] = [
  {
    id: "pentest",
    label: "Pentest",
    description: "Authorized penetration testing — recon, exploit, evidence-backed findings.",
    isDefault: true,
  },
  {
    id: "ctf",
    label: "CTF",
    description: "CTF web player — session/browser/captcha tools, maximize verified flags.",
  },
  {
    id: "consult",
    label: "Consult",
    description: "Security consult (stub) — explain/analyze; does not book product findings.",
  },
] as const;

export const DEFAULT_EXPERT_ID: ExpertId = "pentest";

const PACK_BY_ID: Record<string, ExpertPackMeta> = Object.fromEntries(
  EXPERT_PACKS.map((p) => [p.id, p]),
);

/** Engagement/role aliases → canonical pack id (same folding as backend). */
const ENGAGEMENT_ALIASES: Record<string, ExpertId> = {
  pentest: "pentest",
  assess: "pentest",
  verify: "pentest",
  retest: "pentest",
  ctf: "ctf",
  "ctf-web": "ctf",
  challenge: "ctf",
  consult: "consult",
};

export function isExpertId(value: unknown): value is ExpertId {
  return typeof value === "string" && value in PACK_BY_ID;
}

export function normalizeExpertId(value: unknown): ExpertId | null {
  if (value == null) return null;
  const key = String(value).trim().toLowerCase();
  if (!key) return null;
  if (key in ENGAGEMENT_ALIASES) return ENGAGEMENT_ALIASES[key]!;
  if (isExpertId(key)) return key;
  return null;
}

export function expertMeta(id: string | null | undefined): ExpertPackMeta | null {
  const pack = normalizeExpertId(id);
  return pack ? PACK_BY_ID[pack] ?? null : null;
}

export function expertLabel(id: string | null | undefined): string {
  return expertMeta(id)?.label ?? (id ? String(id) : DEFAULT_EXPERT_ID);
}

/**
 * Effective installed offers for a node (default pentest-only when missing/empty).
 * Matches backend `effective_offers`.
 */
export function effectiveOffers(offers: unknown): ExpertId[] {
  if (!Array.isArray(offers) || offers.length === 0) {
    return [DEFAULT_EXPERT_ID];
  }
  const out: ExpertId[] = [];
  const seen = new Set<ExpertId>();
  for (const item of offers) {
    const pack = normalizeExpertId(item);
    if (!pack || seen.has(pack)) continue;
    seen.add(pack);
    out.push(pack);
  }
  return out.length > 0 ? out : [DEFAULT_EXPERT_ID];
}

export function nodeOffersExpert(offers: unknown, expertId: unknown): boolean {
  const pack = normalizeExpertId(expertId) ?? DEFAULT_EXPERT_ID;
  return effectiveOffers(offers).includes(pack);
}

/** Prefer an installed expert; fall back to first offer / default. */
export function coerceEngagementToOffers(
  engagement: unknown,
  offers: unknown,
): ExpertId {
  const installed = effectiveOffers(offers);
  const pack = normalizeExpertId(engagement);
  if (pack && installed.includes(pack)) return pack;
  return installed[0] ?? DEFAULT_EXPERT_ID;
}
