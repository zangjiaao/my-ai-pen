/**
 * Agent output-language registry + template-based policy formatter (#134 / #135).
 *
 * Catalog source: agent-language-catalog.json (shipped copy of shared/).
 * Extending languages = edit that JSON once and sync shipped copies — not
 * per-locale inject branches or session-path edits.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderPromptTemplate,
  sanitizeLanguageTemplateValue,
} from "./prompt-template.js";

/** Wire codes shipped in this epic (plus auto). */
export type AgentLanguageCode = "auto" | "zh-CN" | "zh-TW" | "en" | "ja";

export type AgentLanguageRegistryEntry = {
  code: AgentLanguageCode;
  uiLabel: string;
  optionLabel: string;
  promptName?: string;
  aliases: string[];
};

type CatalogFile = {
  default: string;
  languages: Array<{
    code: string;
    ui_label: string;
    option_label: string;
    prompt_name?: string;
    aliases?: string[];
  }>;
};

function loadCatalog(): CatalogFile {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "agent-language-catalog.json");
  return JSON.parse(readFileSync(path, "utf8")) as CatalogFile;
}

const CATALOG = loadCatalog();

/**
 * Registry built from the shipped JSON catalog.
 * Adding a language later = append a JSON row + sync copies (see shared/).
 */
export const AGENT_LANGUAGE_REGISTRY: readonly AgentLanguageRegistryEntry[] =
  CATALOG.languages.map((row) => ({
    code: row.code as AgentLanguageCode,
    uiLabel: row.ui_label,
    optionLabel: row.option_label,
    promptName: row.prompt_name,
    aliases: row.aliases ?? [],
  }));

export const DEFAULT_AGENT_LANGUAGE: AgentLanguageCode =
  (CATALOG.default as AgentLanguageCode) || "auto";

export const FORCED_AGENT_LANGUAGE_CODES: readonly AgentLanguageCode[] =
  AGENT_LANGUAGE_REGISTRY.filter((e) => e.code !== "auto").map((e) => e.code);

export const AGENT_LANGUAGE_CODES: readonly AgentLanguageCode[] =
  AGENT_LANGUAGE_REGISTRY.map((e) => e.code);

const CODE_SET = new Set<string>(AGENT_LANGUAGE_CODES);

const ALIAS_TO_CODE = new Map<string, AgentLanguageCode>();
for (const entry of AGENT_LANGUAGE_REGISTRY) {
  for (const alias of entry.aliases) {
    ALIAS_TO_CODE.set(aliasKey(alias), entry.code);
  }
}

function aliasKey(raw: string): string {
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

export function getAgentLanguageEntry(
  code: string,
): AgentLanguageRegistryEntry | undefined {
  return AGENT_LANGUAGE_REGISTRY.find((e) => e.code === code);
}

/**
 * Normalize free-form operator / envelope input to a registry code.
 * Unknown values → `auto` (safe default for runtime inject).
 */
export function normalizeAgentLanguage(raw: unknown): AgentLanguageCode {
  const s = String(raw ?? "").trim();
  if (!s) return DEFAULT_AGENT_LANGUAGE;
  if (CODE_SET.has(s)) return s as AgentLanguageCode;

  const key = aliasKey(s);
  const fromAlias = ALIAS_TO_CODE.get(key);
  if (fromAlias) return fromAlias;

  for (const code of AGENT_LANGUAGE_CODES) {
    if (code.toLowerCase() === key) return code;
  }

  return DEFAULT_AGENT_LANGUAGE;
}

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
 * Render the language policy block for a system prompt.
 * Shared by free OMP, Hard Graph stage, and subagent session builders.
 */
export function formatAgentLanguageInjection(language: unknown): string {
  const resolved = resolveAgentLanguage(language);
  if (resolved.mode === "auto") {
    return AUTO_LANGUAGE_POLICY_TEMPLATE;
  }
  return renderPromptTemplate(
    FORCED_LANGUAGE_POLICY_TEMPLATE,
    {
      language_code: resolved.code,
      language_prompt_name: resolved.promptName,
    },
    { sanitizeValue: sanitizeLanguageTemplateValue },
  );
}

export function isAgentLanguageCode(raw: unknown): raw is AgentLanguageCode {
  return typeof raw === "string" && CODE_SET.has(raw);
}

/**
 * Extract and normalize agent language from a platform task_assign or user_steer.
 * Always returns a registry wire code (unknown/missing → auto).
 */
export function extractAgentLanguageFromMessage(
  message: Record<string, unknown>,
): AgentLanguageCode {
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
  return normalizeAgentLanguage(raw);
}

/** Absolute path of the shipped catalog JSON (for cross-stack lock tests). */
export function agentLanguageCatalogPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "agent-language-catalog.json");
}

// Re-export language sanitize for tests that imported from agent-language before.
export { sanitizeLanguageTemplateValue } from "./prompt-template.js";
