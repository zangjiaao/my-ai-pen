/**
 * Node agent output-language catalog (#134 / #136).
 *
 * Must stay in lockstep with:
 * - node4/src/runtime/agent-language.ts (AGENT_LANGUAGE_REGISTRY)
 * - platform/backend ALLOWED_AGENT_LANGUAGES / normalize_agent_language
 *
 * Adding a language = append a row here + Node registry + Platform allowlist.
 * Do not hardcode a divergent option list in NodePage.
 */

export type AgentLanguageCode = "auto" | "zh-CN" | "zh-TW" | "en" | "ja";

export type AgentLanguageOption = {
  code: AgentLanguageCode;
  /** Operator-facing label (without wire code). */
  label: string;
  /** Select option text. */
  optionLabel: string;
};

/** Shipped catalog — order is UI order. */
export const AGENT_LANGUAGE_OPTIONS: readonly AgentLanguageOption[] = [
  { code: "auto", label: "跟随用户", optionLabel: "跟随用户（auto）" },
  { code: "zh-CN", label: "简体中文", optionLabel: "简体中文（zh-CN）" },
  { code: "zh-TW", label: "繁體中文", optionLabel: "繁體中文（zh-TW）" },
  { code: "en", label: "English", optionLabel: "English（en）" },
  { code: "ja", label: "日本語", optionLabel: "日本語（ja）" },
] as const;

export const AGENT_LANGUAGE_CODES: readonly AgentLanguageCode[] =
  AGENT_LANGUAGE_OPTIONS.map((o) => o.code);

export const DEFAULT_AGENT_LANGUAGE: AgentLanguageCode = "auto";

export function isAgentLanguageCode(raw: string): raw is AgentLanguageCode {
  return (AGENT_LANGUAGE_CODES as readonly string[]).includes(raw);
}
