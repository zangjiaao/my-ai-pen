/**
 * Stable public prompt API for Node4 Agent Runtime.
 *
 * Layer builders live in prompt-layers.ts (Free / Stage / Worker).
 * This module re-exports that seam plus template + language helpers so
 * existing imports from `./prompt.js` stay valid.
 *
 * Spec: docs/specs/prompt-layers.md (#386 / #393).
 */

export {
  // Core types
  type PromptTemplateVars,
  type PromptLayers,
  type BuildSystemPromptOptions,
  type BaseLayerInput,
  type ProfessionLayerInput,
  type BuildSubagentPromptOptions,
  // Assembler + shared parts
  joinNonEmptyPromptParts,
  assembleSystemPrompt,
  promptTemplateVarsFromBase,
  promptTemplateVars,
  baseLayerInputFrom,
  professionLayerInputFrom,
  buildBaseLayer,
  buildProfessionLayer,
  compactProfessionLayerInput,
  buildCompactProfessionLayer,
  // Free Main
  buildPromptLayers,
  buildSystemPrompt,
  // Graph stage captains
  stageIntentPromptLines,
  buildStagePromptLayers,
  stageSystemPrompt,
  // Package workers
  buildSubagentPromptLayers,
  buildSubagentSystemPrompt,
} from "./prompt-layers.js";

// Template primitives live in prompt-template.ts (shared with language policy).
export {
  PROMPT_LABEL_MAX,
  promptQuotedLabel,
  renderPromptTemplate,
  sanitizeLanguageTemplateValue,
  sanitizePromptLabel,
} from "./prompt-template.js";

// Language registry + policy live in agent-language.ts.
export {
  normalizeAgentLanguage,
  formatAgentLanguageInjection,
  resolveAgentLanguage,
  AGENT_LANGUAGE_REGISTRY,
  AGENT_LANGUAGE_CODES,
  FORCED_AGENT_LANGUAGE_CODES,
  type AgentLanguageCode,
  type ResolvedAgentLanguage,
} from "./agent-language.js";
