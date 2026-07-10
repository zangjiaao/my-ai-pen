/**
 * Classify confirmed findings into high-value result kinds for the right panel.
 * Vuln = security vulnerability; auth = credentials/secrets; flag = CTF/challenge tokens.
 */

export type FindingKind = "vuln" | "auth" | "flag";

export function normalizeFindingKind(value: unknown): FindingKind | undefined {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw) return undefined;
  if (["vuln", "vulnerability", "vulns"].includes(raw)) return "vuln";
  if (["auth", "credential", "credentials", "secret", "secrets", "password", "apikey", "api_key", "aksk"].includes(raw)) {
    return "auth";
  }
  if (["flag", "flags", "ctf"].includes(raw)) return "flag";
  return undefined;
}

/** Infer kind from title/body when the agent did not set finding_kind explicitly. */
export function inferFindingKind(record: {
  title?: unknown;
  description?: unknown;
  impact?: unknown;
  poc?: unknown;
  reproduction?: unknown;
  location?: unknown;
  finding_kind?: unknown;
  kind?: unknown;
  category?: unknown;
}): FindingKind {
  const explicit = normalizeFindingKind(record.finding_kind || record.kind || record.category);
  if (explicit) return explicit;

  const blob = [
    record.title,
    record.description,
    record.impact,
    record.poc,
    record.reproduction,
    record.location,
  ]
    .map((v) => String(v || ""))
    .join("\n");

  // Flags first — CTF titles often embed flag{...} next to the vuln name.
  if (/flag\s*\{[^{}\n]{2,120}\}/i.test(blob) || /\bFLAG\s*\{[^{}\n]{2,120}\}/.test(blob)) {
    return "flag";
  }
  if (/\b(?:ctf\s*)?flag\b/i.test(String(record.title || "")) && /challenge|level\s*\d|通关|captured/i.test(blob)) {
    return "flag";
  }

  // Credentials / secrets
  if (
    /\b(api[_-]?key|access[_-]?key|secret[_-]?key|aws[_-]?secret|private[_-]?key|bearer\s+[a-z0-9._\-]{8,}|akia[0-9a-z]{12,})\b/i.test(
      blob,
    ) ||
    /\b(password|passwd|pwd|credential|credentials|username\s*[:=]|login\s*:\s*\w+\s+pass)/i.test(blob) ||
    /\b(ak\/sk|accesskeyid|secretaccesskey)\b/i.test(blob)
  ) {
    return "auth";
  }

  return "vuln";
}

/** Extract first flag{...} token for display. */
export function extractFlagToken(text: unknown): string | undefined {
  const m = String(text || "").match(/flag\{[^{}\n]{2,120}\}/i) || String(text || "").match(/FLAG\{[^{}\n]{2,120}\}/);
  return m ? m[0] : undefined;
}
