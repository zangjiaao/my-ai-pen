/**
 * Severity integrity (Spec #139 D1 / NC-Severity S4).
 * Agent assigns; Store preserves; fail-closed if missing/invalid — no silent "medium".
 */

export const FINDING_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

const SEVERITY_SET = new Set<string>(FINDING_SEVERITIES);

/**
 * Parse severity enum. Empty/invalid → null (caller fail-closes).
 * Does **not** invent medium.
 */
export function parseFindingSeverity(value: unknown): FindingSeverity | null {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!raw) return null;
  return SEVERITY_SET.has(raw) ? (raw as FindingSeverity) : null;
}

/** True when value is a valid severity enum member. */
export function isValidFindingSeverity(value: unknown): value is FindingSeverity {
  return parseFindingSeverity(value) !== null;
}

/**
 * Resolve severity for book/confirm path.
 * Prefer explicit tool arg, then Store-held severity. Fail closed if neither is valid.
 * Never rewrites a present critical/high down to medium.
 */
export function resolveBookSeverity(input: {
  toolSeverity?: unknown;
  storeSeverity?: unknown;
}):
  | { ok: true; severity: FindingSeverity; source: "tool" | "store" }
  | { ok: false; error: string } {
  const fromTool = parseFindingSeverity(input.toolSeverity);
  if (fromTool) return { ok: true, severity: fromTool, source: "tool" };
  const fromStore = parseFindingSeverity(input.storeSeverity);
  if (fromStore) return { ok: true, severity: fromStore, source: "store" };
  const rawTool = String(input.toolSeverity ?? "").trim();
  const rawStore = String(input.storeSeverity ?? "").trim();
  if (rawTool || rawStore) {
    return {
      ok: false,
      error: `invalid severity (need critical|high|medium|low|info); got tool=${rawTool || "(empty)"} store=${rawStore || "(empty)"}`,
    };
  }
  return {
    ok: false,
    error: "severity required (critical|high|medium|low|info) — silent medium banned (Spec #139 D1)",
  };
}
