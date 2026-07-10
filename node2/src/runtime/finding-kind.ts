/**
 * Classify confirmed findings into exclusive high-value kinds.
 * Vuln, auth/key, and flag are independent objects — one record, one kind.
 * Agent must emit separate finding.confirm calls when both a vuln and a flag/key apply.
 */

export type FindingKind = "vuln" | "auth" | "flag";

export function normalizeFindingKind(value: unknown): FindingKind | undefined {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw) return undefined;
  if (["vuln", "vulnerability", "vulns"].includes(raw)) return "vuln";
  if (
    ["auth", "credential", "credentials", "secret", "secrets", "password", "apikey", "api_key", "aksk", "key"].includes(
      raw,
    )
  ) {
    return "auth";
  }
  if (["flag", "flags", "ctf"].includes(raw)) return "flag";
  return undefined;
}

/** True when text contains a CTF-style flag{...} token. */
export function hasFlagToken(text: unknown): boolean {
  return Boolean(extractFlagToken(text));
}

/** Extract first flag{...} token for display. */
export function extractFlagToken(text: unknown): string | undefined {
  const m = String(text || "").match(/flag\{[^{}\n]{2,120}\}/i) || String(text || "").match(/FLAG\{[^{}\n]{2,120}\}/);
  return m ? m[0] : undefined;
}

function blobOf(record: {
  title?: unknown;
  description?: unknown;
  impact?: unknown;
  poc?: unknown;
  reproduction?: unknown;
  location?: unknown;
}): string {
  return [record.title, record.description, record.impact, record.poc, record.reproduction, record.location]
    .map((v) => String(v || ""))
    .join("\n");
}

/** Vuln-shaped signals in title/body. */
export function hasVulnSignals(record: {
  title?: unknown;
  description?: unknown;
  impact?: unknown;
  poc?: unknown;
  reproduction?: unknown;
  location?: unknown;
  severity?: unknown;
  cwe?: unknown;
}): boolean {
  if (record.cwe && String(record.cwe).trim()) return true;
  const title = String(record.title || "");
  const blob = blobOf(record);
  if (
    /\b(sql\s*injection|sqli|xss|cross[- ]site|rce|remote\s*code|command\s*injection|ssrf|lfi|rfi|xxe|ssti|idor|path\s*traversal|file\s*upload|deserialization|csrf|open\s*redirect|auth(?:entication|orization)?\s*(?:bypass|flaw)|privilege\s*escalation|insecure|vulnerability|漏洞|注入|越权)\b/i.test(
      title,
    ) ||
    /\b(sql\s*injection|sqli|reflected\s*xss|stored\s*xss|rce|ssrf|cwe-\d+)\b/i.test(blob)
  ) {
    return true;
  }
  return false;
}

export function hasAuthSignals(text: unknown): boolean {
  const blob = String(text || "");
  return (
    /\b(api[_-]?key|access[_-]?key|secret[_-]?key|aws[_-]?secret|private[_-]?key|bearer\s+[a-z0-9._\-]{8,}|akia[0-9a-z]{12,})\b/i.test(
      blob,
    ) ||
    /\b(password|passwd|pwd|credential|credentials|username\s*[:=]|login\s*:\s*\w+\s+pass)\b/i.test(blob) ||
    /\b(ak\/sk|accesskeyid|secretaccesskey)\b/i.test(blob)
  );
}

/**
 * Exclusive kind for one finding record.
 * Explicit agent finding_kind wins. Inference never dual-lists.
 * Mixed vuln+flag body without explicit kind → vuln (agent should emit a second flag confirm).
 */
export function inferFindingKind(record: {
  title?: unknown;
  description?: unknown;
  impact?: unknown;
  poc?: unknown;
  reproduction?: unknown;
  location?: unknown;
  severity?: unknown;
  cwe?: unknown;
  finding_kind?: unknown;
  kind?: unknown;
  category?: unknown;
}): FindingKind {
  const explicit = normalizeFindingKind(record.finding_kind || record.kind || record.category);
  if (explicit) return explicit;

  const blob = blobOf(record);
  const flagPresent = hasFlagToken(blob);
  const vulnish = hasVulnSignals(record);
  const authish = hasAuthSignals(blob);

  // Pure flag capture (no vuln write-up language).
  if (flagPresent && !vulnish) {
    if (/\b(?:ctf\s*)?flag\b/i.test(String(record.title || "")) || /^flag\{/i.test(String(record.title || "").trim())) {
      return "flag";
    }
    if (!authish) return "flag";
  }

  // Pure credentials / secrets.
  if (authish && !vulnish) return "auth";

  // Default / mixed body → vuln only (do not also classify as flag here).
  return "vuln";
}

/**
 * Exclusive membership list (always length 1).
 * Kept for callers that historically expected an array; dual membership is removed.
 */
export function panelMemberships(record: Parameters<typeof inferFindingKind>[0] & { flag_value?: unknown }): FindingKind[] {
  return [inferFindingKind(record)];
}

/**
 * Detect mixed content where agent should have emitted two confirms.
 * Soft signal for tool feedback — does not auto-split records.
 */
export function looksLikeMixedVulnAndFlag(record: {
  title?: unknown;
  description?: unknown;
  impact?: unknown;
  poc?: unknown;
  reproduction?: unknown;
  location?: unknown;
  finding_kind?: unknown;
  kind?: unknown;
  category?: unknown;
  cwe?: unknown;
}): boolean {
  const explicit = normalizeFindingKind(record.finding_kind || record.kind || record.category);
  const blob = blobOf(record);
  if (!hasFlagToken(blob)) return false;
  // Flag record that also reads like a vuln write-up → should have been split.
  if (explicit === "flag") return hasVulnSignals(record);
  // Vuln (explicit or inferred) that embeds flag{...} → need a separate flag confirm.
  if (explicit === "vuln" || explicit === undefined) return true;
  return false;
}
