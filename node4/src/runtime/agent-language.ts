/**
 * Agent output-language registry + template-based policy formatter (#134 / #135).
 *
 * Extending languages is a **registry row only** — no new per-locale inject
 * branches and no session-path edits. Policy body uses the existing small
 * Jinja-like `{{ key }}` substitution (no full Jinja2 control flow).
 *
 * Intentionally does not import `./prompt.js` (prompt re-exports this module).
 * Substitution regex matches `renderPromptTemplate` in prompt.ts.
 */

/** Wire codes shipped in this epic (plus auto). */
export type AgentLanguageCode = "auto" | "zh-CN" | "zh-TW" | "en" | "ja";

export type AgentLanguageRegistryEntry = {
  /** Canonical wire / Node config value. */
  code: AgentLanguageCode;
  /** Operator-facing UI label (without wire code). */
  uiLabel: string;
  /**
   * English (or locale-neutral) name used inside the forced-language system
   * prompt template as `{{ language_prompt_name }}`. Absent for `auto`.
   */
  promptName?: string;
  /**
   * Case-insensitive aliases that normalize to this code.
   * Exact code match always wins before alias lookup.
   */
  aliases: string[];
};

/**
 * Single shipped catalog. Adding a language later = append a row here
 * (and keep Platform/FE allowlists in lockstep — see #136).
 */
export const AGENT_LANGUAGE_REGISTRY: readonly AgentLanguageRegistryEntry[] = [
  {
    code: "auto",
    uiLabel: "跟随用户",
    aliases: ["follow", "match", "跟随用户", "跟随"],
  },
  {
    code: "zh-CN",
    uiLabel: "简体中文",
    promptName: "Simplified Chinese",
    aliases: [
      "zh",
      "zh-cn",
      "zh_cn",
      "chinese",
      "simplified",
      "simplified-chinese",
      "simplified chinese",
      "中文",
      "简体",
      "简体中文",
    ],
  },
  {
    code: "zh-TW",
    uiLabel: "繁體中文",
    promptName: "Traditional Chinese",
    aliases: [
      "zh-tw",
      "zh_tw",
      "zh-hant",
      "zh-hk",
      "traditional",
      "traditional-chinese",
      "traditional chinese",
      "繁體",
      "繁体",
      "繁體中文",
      "繁体中文",
    ],
  },
  {
    code: "en",
    uiLabel: "English",
    promptName: "English",
    aliases: ["en-us", "en_us", "en-gb", "english"],
  },
  {
    code: "ja",
    uiLabel: "日本語",
    promptName: "Japanese",
    aliases: ["jp", "ja-jp", "ja_jp", "japanese", "日本語"],
  },
] as const;

export const DEFAULT_AGENT_LANGUAGE: AgentLanguageCode = "auto";

/** Forced (non-auto) codes only. */
export const FORCED_AGENT_LANGUAGE_CODES: readonly AgentLanguageCode[] =
  AGENT_LANGUAGE_REGISTRY.filter((e) => e.code !== "auto").map((e) => e.code);

/** All accepted wire codes including auto. */
export const AGENT_LANGUAGE_CODES: readonly AgentLanguageCode[] =
  AGENT_LANGUAGE_REGISTRY.map((e) => e.code);

const CODE_SET = new Set<string>(AGENT_LANGUAGE_CODES);

/** Alias → code (lowercased keys; CJK aliases stored as-is). */
const ALIAS_TO_CODE = new Map<string, AgentLanguageCode>();
for (const entry of AGENT_LANGUAGE_REGISTRY) {
  for (const alias of entry.aliases) {
    ALIAS_TO_CODE.set(aliasKey(alias), entry.code);
  }
}

function aliasKey(raw: string): string {
  // Keep CJK as-is; normalize latin with lower + underscore→hyphen.
  const s = raw.trim();
  if (/[\u3040-\u30ff\u3400-\u9fff]/.test(s)) return s;
  return s.toLowerCase().replace(/_/g, "-");
}

export type ResolvedAgentLanguage =
  | { mode: "auto"; code: "auto" }
  | {
      mode: "forced";
      code: Exclude<AgentLanguageCode, "auto">;
      promptName: string;
      uiLabel: string;
    };

/**
 * Look up a registry entry by exact code (case-sensitive wire form).
 */
export function getAgentLanguageEntry(
  code: string,
): AgentLanguageRegistryEntry | undefined {
  return AGENT_LANGUAGE_REGISTRY.find((e) => e.code === code);
}

/**
 * Normalize free-form operator / envelope input to a registry code.
 * Unknown values → `auto` (safe default for runtime inject).
 * `zh-CN` and `zh-TW` never collapse into one code.
 */
export function normalizeAgentLanguage(raw: unknown): AgentLanguageCode {
  const s = String(raw ?? "").trim();
  if (!s) return DEFAULT_AGENT_LANGUAGE;
  if (CODE_SET.has(s)) return s as AgentLanguageCode;

  const key = aliasKey(s);
  const fromAlias = ALIAS_TO_CODE.get(key);
  if (fromAlias) return fromAlias;

  // Loose latin: lowercased code forms (zh-cn already in aliases).
  if (CODE_SET.has(key)) {
    // e.g. someone passes "JA" → key "ja"
    return key as AgentLanguageCode;
  }
  // Title-case wire variants like "Zh-Cn" already handled via aliases;
  // try matching registry codes case-insensitively.
  for (const code of AGENT_LANGUAGE_CODES) {
    if (code.toLowerCase() === key) return code;
  }

  return DEFAULT_AGENT_LANGUAGE;
}

/**
 * Resolve raw config to auto vs forced with template vars ready.
 */
export function resolveAgentLanguage(raw: unknown): ResolvedAgentLanguage {
  const code = normalizeAgentLanguage(raw);
  if (code === "auto") return { mode: "auto", code: "auto" };
  const entry = getAgentLanguageEntry(code);
  if (!entry || !entry.promptName) {
    return { mode: "auto", code: "auto" };
  }
  return {
    mode: "forced",
    code: code as Exclude<AgentLanguageCode, "auto">,
    promptName: entry.promptName,
    uiLabel: entry.uiLabel,
  };
}

/**
 * Sanitize values substituted into the language policy template.
 * Same smuggle defenses as persona labels (no braces / controls / nested
 * templates) but **allows spaces** so prompt names like "Simplified Chinese"
 * survive substitution.
 */
export function sanitizeLanguageTemplateValue(raw: unknown, fallback = ""): string {
  const CONTROL_AND_INVISIBLE_RE =
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/g;
  let s = String(raw ?? "")
    .trim()
    .replace(CONTROL_AND_INVISIBLE_RE, "");
  if (s.length > 64) s = s.slice(0, 64);
  // Block template / structure smuggling.
  s = s.replace(/[{}`$\\]/g, "");
  // Letters, numbers, spaces, and a few punctuation marks used in locale names.
  s = s.replace(/[^\p{L}\p{N}_.:\-\s]/gu, "");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return fallback;
  return s;
}

/**
 * One shared forced-language policy body. Variables:
 *   {{ language_code }}         e.g. ja
 *   {{ language_prompt_name }}  e.g. Japanese
 *
 * Covers **all agent-authored narrative** surfaces; raw tool stdout/stderr
 * is never rewritten.
 */
export const FORCED_LANGUAGE_POLICY_TEMPLATE = [
  "## Output language (node policy: {{ language_code }})",
  "Write **all agent-authored narrative** in **{{ language_prompt_name }}** when this node policy is set.",
  "Surfaces in scope: user-facing chat replies; thinking/reasoning text shown in Chat; todo/plan labels and updates you write; tool-call intent and progress narration; finding ledger fields (title, description, impact, remediation, PoC narrative); stage completion summaries and package/subagent handoff narration you write; report markdown you author.",
  "Do not default to another natural language for these surfaces — even if mission packs, tool output, or payloads are in English or another language.",
  "Keep technical tokens as-is when needed (paths, headers, CVE ids, code, shell stdout excerpts in proof).",
  "**Do not rewrite** raw tool stdout/stderr, HTTP bodies, or other protocol/machine identifiers; only your narration and booked finding/report text must follow this language.",
].join("\n");

export const AUTO_LANGUAGE_POLICY_TEMPLATE = [
  "## Output language (node policy: auto)",
  "Match the **user's language** for all agent-authored narrative (chat replies; thinking/reasoning text shown in Chat; todo/plan labels and updates you write; tool-call intent and progress narration; finding ledger fields; stage completion summaries and package/subagent handoff narration you write; report markdown you author).",
  "If the user writes Chinese, use Chinese; if English, use English; similarly follow other languages the user uses.",
  "Keep technical tokens as-is when needed (paths, headers, CVE ids, code, shell stdout excerpts in proof).",
  "**Do not rewrite** raw tool stdout/stderr, HTTP bodies, or other protocol/machine identifiers.",
].join("\n");

/**
 * Same `{{ key }}` / `{{key}}` contract as prompt.renderPromptTemplate:
 * unknown keys → empty; no expressions; substituted values never re-expanded.
 */
function renderLanguagePolicyTemplate(
  text: string,
  vars: Record<string, string>,
): string {
  return String(text || "").replace(
    /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g,
    (_m, key: string) => {
      if (!Object.prototype.hasOwnProperty.call(vars, key)) return "";
      return sanitizeLanguageTemplateValue(vars[key], "");
    },
  );
}

/**
 * Render the language policy block for a system prompt.
 * Shared by free OMP, Hard Graph stage, and subagent session builders.
 */
export function formatAgentLanguageInjection(language: unknown): string {
  const resolved = resolveAgentLanguage(language);
  if (resolved.mode === "auto") {
    return AUTO_LANGUAGE_POLICY_TEMPLATE;
  }
  return renderLanguagePolicyTemplate(FORCED_LANGUAGE_POLICY_TEMPLATE, {
    language_code: resolved.code,
    language_prompt_name: resolved.promptName,
  });
}

/**
 * UI option list derived from the registry (code + label).
 * Platform/FE should use the same codes (#136).
 */
export function agentLanguageUiOptions(): ReadonlyArray<{
  code: AgentLanguageCode;
  label: string;
}> {
  return AGENT_LANGUAGE_REGISTRY.map((e) => ({
    code: e.code,
    label: e.uiLabel,
  }));
}

/** True if the value is an accepted wire code (exact), not an alias. */
export function isAgentLanguageCode(raw: unknown): raw is AgentLanguageCode {
  return typeof raw === "string" && CODE_SET.has(raw);
}

/**
 * Extract agent language from a platform task_assign or user_steer message.
 * Accepts top-level agent_language / agentLanguage or worker_limits.* (#138).
 * Returns the raw wire string (callers may normalize); undefined if absent.
 */
export function extractAgentLanguageFromMessage(
  message: Record<string, unknown>,
): string | undefined {
  const limits =
    message.worker_limits &&
    typeof message.worker_limits === "object" &&
    !Array.isArray(message.worker_limits)
      ? (message.worker_limits as Record<string, unknown>)
      : message.workerLimits &&
          typeof message.workerLimits === "object" &&
          !Array.isArray(message.workerLimits)
        ? (message.workerLimits as Record<string, unknown>)
        : {};
  const raw =
    typeof message.agent_language === "string"
      ? message.agent_language
      : typeof message.agentLanguage === "string"
        ? message.agentLanguage
        : typeof limits.agent_language === "string"
          ? limits.agent_language
          : typeof limits.agentLanguage === "string"
            ? limits.agentLanguage
            : undefined;
  const trimmed = raw?.trim();
  return trimmed || undefined;
}
