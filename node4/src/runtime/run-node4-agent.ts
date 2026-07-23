/**
 * Product Agent Runtime seam (Graph × Pi core-only).
 *
 * Uses pi-ai + pi-agent-core only — no pi-coding-agent.
 * Main, subagent, and Hard Graph stages should enter here.
 */

import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Node4Config } from "../config.js";

export type Node4AgentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Minimal session handle used by idle pool and runners. */
export type Node4AgentSession = {
  prompt: (text: string, opts?: { source?: string }) => Promise<void>;
  abort: () => void;
  dispose: () => void | Promise<void>;
  subscribe: (listener: (event: AgentEvent) => void | Promise<void>) => () => void;
  /** Messages visible after runs (product may project; not SOT). */
  readonly messages: readonly unknown[];
};

export type RunNode4AgentOptions = {
  systemPrompt: string;
  tools: AgentTool<any>[];
  model: Model<any>;
  thinkingLevel?: Node4AgentThinkingLevel;
  /** Optional API key resolver for streamSimple. */
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
  sessionId?: string;
  beforeToolCall?: Agent["beforeToolCall"];
  afterToolCall?: Agent["afterToolCall"];
  /**
   * Test seam: inject a prebuilt session instead of constructing Agent.
   * When set, model/tools/systemPrompt are ignored for construction.
   */
  sessionFactory?: () => Node4AgentSession | Promise<Node4AgentSession>;
  /** Access the underlying Agent (e.g. mid-run followUp). Not called for sessionFactory. */
  onAgent?: (agent: Agent) => void;
};

/**
 * Resolve a pi-ai Model for Node4 config (OpenAI-compatible override friendly).
 * Prefer explicit base URL + openai-completions for lab/self-hosted endpoints.
 */
export function resolveNode4Model(config: Node4Config): Model<any> {
  const provider = String(config.modelProvider || "openai").trim() || "openai";
  const id = String(config.modelId || "gpt-5").trim() || "gpt-5";
  const baseUrl =
    String(config.llmBaseUrl || process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || "").trim() ||
    defaultBaseUrl(provider);
  const api =
    (process.env.LLM_API as Model<any>["api"] | undefined) ||
    ("openai-completions" as const);
  const contextWindow = Math.max(1024, Number(process.env.LLM_CONTEXT_WINDOW || 128_000) || 128_000);
  const maxTokens = Math.max(256, Number(process.env.LLM_MAX_TOKENS || 8192) || 8192);

  return {
    id,
    name: id,
    api,
    provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

function defaultBaseUrl(provider: string): string {
  const p = provider.toLowerCase();
  if (p === "deepseek") return "https://api.deepseek.com";
  if (p === "anthropic") return "https://api.anthropic.com";
  if (p === "openai") return "https://api.openai.com/v1";
  return "https://api.openai.com/v1";
}

export function resolveNode4ApiKey(provider: string): string | undefined {
  const p = String(provider || "").trim().toLowerCase();
  if (p === "deepseek") {
    return process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY || undefined;
  }
  if (p === "openai") {
    return process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || undefined;
  }
  if (p === "anthropic") {
    return process.env.ANTHROPIC_API_KEY || process.env.LLM_API_KEY || undefined;
  }
  return (
    process.env.LLM_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    undefined
  );
}

/**
 * Create a product Agent Runtime session (core-only).
 */
export async function runNode4Agent(options: RunNode4AgentOptions): Promise<Node4AgentSession> {
  if (options.sessionFactory) {
    return options.sessionFactory();
  }

  const thinkingLevel = options.thinkingLevel ?? "medium";
  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model: options.model,
      thinkingLevel,
      tools: options.tools,
    },
    streamFn: streamSimple,
    getApiKey: options.getApiKey ?? ((provider: string) => resolveNode4ApiKey(provider)),
    beforeToolCall: options.beforeToolCall,
    afterToolCall: options.afterToolCall,
    sessionId: options.sessionId,
  });
  options.onAgent?.(agent);

  return wrapAgentAsSession(agent);
}

export function wrapAgentAsSession(agent: Agent): Node4AgentSession {
  return {
    prompt: async (text: string, _opts?: { source?: string }) => {
      await agent.prompt(text);
    },
    abort: () => {
      agent.abort();
    },
    dispose: () => {
      try {
        agent.abort();
      } catch {
        /* ignore */
      }
      try {
        agent.clearAllQueues();
      } catch {
        /* ignore */
      }
    },
    subscribe: (listener) =>
      agent.subscribe(async (event, _signal) => {
        await listener(event);
      }),
    get messages() {
      return agent.state.messages;
    },
  };
}

/**
 * Product hooks: tool activity counters + optional platform fan-out via after/before.
 * Callers that need full obs still use session.subscribe → handleNode4SessionEvent.
 */
export function createToolActivityHooks(segmentCounter?: { tools: number }): {
  beforeToolCall: NonNullable<RunNode4AgentOptions["beforeToolCall"]>;
} {
  return {
    beforeToolCall: async () => {
      if (segmentCounter) segmentCounter.tools += 1;
      return undefined;
    },
  };
}
