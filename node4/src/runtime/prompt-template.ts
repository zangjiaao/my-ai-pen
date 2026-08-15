/**
 * Small Jinja-like prompt substitution (intentionally not full Jinja2).
 * Shared by persona/pack lines and language policy injection — no dual engines.
 *
 * Syntax: {{ key }} / {{key}} only. No expressions, filters, or control flow.
 */

/** Max length of any single prompt-injected label (defense in depth). */
export const PROMPT_LABEL_MAX = 64;

/**
 * Characters allowed in prompt-injected persona / pack labels.
 * Aligns with platform EXPERT_NAME_RE (letters, digits, _ . : -).
 * No spaces, quotes, braces, or control characters.
 */
const PROMPT_LABEL_SAFE_RE = /^[\p{L}\p{N}_.:-]+$/u;
const PROMPT_LABEL_STRIP_RE = /[^\p{L}\p{N}_.:-]/gu;
const CONTROL_AND_INVISIBLE_RE =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/g;

/**
 * Sanitize a user- or pack-supplied string before it enters a system prompt.
 * - Strips controls / invisible chars
 * - Drops characters outside the safe alphabet (blocks prompt structure breaks)
 * - Truncates length
 * - Never returns empty when fallback is provided
 */
export function sanitizePromptLabel(raw: unknown, fallback = "Assistant"): string {
  let s = String(raw ?? "")
    .trim()
    .replace(/^@+/, "")
    .replace(CONTROL_AND_INVISIBLE_RE, "");
  if (s.length > PROMPT_LABEL_MAX) s = s.slice(0, PROMPT_LABEL_MAX);
  if (!PROMPT_LABEL_SAFE_RE.test(s)) {
    s = s.replace(PROMPT_LABEL_STRIP_RE, "");
  }
  // Block residual template delimiters even if alphabet drifts.
  s = s.replace(/[{}`$\\]/g, "");
  if (!s) return fallback;
  return s;
}

/**
 * Sanitize language prompt display names (allows spaces).
 * Same smuggle defenses as persona labels; spaces kept for "Simplified Chinese".
 */
export function sanitizeLanguageTemplateValue(raw: unknown, fallback = ""): string {
  let s = String(raw ?? "")
    .trim()
    .replace(CONTROL_AND_INVISIBLE_RE, "");
  if (s.length > PROMPT_LABEL_MAX) s = s.slice(0, PROMPT_LABEL_MAX);
  s = s.replace(/[{}`$\\]/g, "");
  s = s.replace(/[^\p{L}\p{N}_.:\-\s]/gu, "");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return fallback;
  return s;
}

/** JSON-string quote so the value is a single literal (structure-safe embedding). */
export function promptQuotedLabel(label: string): string {
  return JSON.stringify(sanitizePromptLabel(label, "Assistant"));
}

/**
 * Replace `{{ key }}` / `{{key}}` with vars[key]. Unknown keys → empty string.
 * Does not evaluate expressions (keep deterministic and safe).
 * Values are re-sanitized on substitution as a second belt (never re-expanded).
 */
export function renderPromptTemplate(
  text: string,
  vars: Record<string, string>,
  options?: { sanitizeValue?: (raw: unknown, fallback?: string) => string },
): string {
  return String(text || "").replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_m, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return "";
    if (options?.sanitizeValue) return options.sanitizeValue(vars[key], "");
    // Pack display labels may contain spaces (e.g. "Application security assessment").
    // Persona / ids stay on the strict alphabet (no spaces).
    if (key === "pack_label") return sanitizeLanguageTemplateValue(vars[key], "");
    return sanitizePromptLabel(vars[key], "");
  });
}
