/**
 * Node agent output-language catalog (#134 / #136).
 *
 * Source: agent-language-catalog.json (shipped copy of shared/).
 * Keep byte-identical with Node/Platform/shared copies — do not hardcode
 * a divergent option list in NodePage.
 */

import catalog from "./agent-language-catalog.json";

export type AgentLanguageCode = "auto" | "zh-CN" | "zh-TW" | "en" | "ja";

export type AgentLanguageOption = {
  code: AgentLanguageCode;
  label: string;
  optionLabel: string;
};

type CatalogRow = {
  code: string;
  ui_label: string;
  option_label: string;
  prompt_name?: string;
  aliases?: string[];
};

const rows = (catalog as { languages: CatalogRow[] }).languages;

/** Shipped catalog — order is UI order (JSON order). */
export const AGENT_LANGUAGE_OPTIONS: readonly AgentLanguageOption[] = rows.map((row) => ({
  code: row.code as AgentLanguageCode,
  label: row.ui_label,
  optionLabel: row.option_label,
}));

export const AGENT_LANGUAGE_CODES: readonly AgentLanguageCode[] =
  AGENT_LANGUAGE_OPTIONS.map((o) => o.code);

export const DEFAULT_AGENT_LANGUAGE: AgentLanguageCode =
  ((catalog as { default?: string }).default as AgentLanguageCode) || "auto";

export function isAgentLanguageCode(raw: string): raw is AgentLanguageCode {
  return (AGENT_LANGUAGE_CODES as readonly string[]).includes(raw);
}
