/**
 * Product Agent Runtime seam (Graph × Pi core-only).
 *
 * pi-ai + pi-agent-core only — no pi-coding-agent.
 * Prefer createBoundNode4Session for Main / subagent / Hard Graph stages.
 */

import {
  Agent,
  type AgentEvent,
  type AfterToolCallContext,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { Node4Config } from "../config.js";
import type { RolePack } from "../roles/types.js";
import type { ToolRuntime } from "../types.js";
import { createNode4Tools } from "../tools/index.js";
import {
  createMidRunTodoTracker,
  noteToolForMidRunTodoNudge,
} from "./todo-harness.js";

export type Node4AgentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Minimal session handle used by idle pool and runners. */
export type Node4AgentSession = {
  prompt: (text: string, opts?: { source?: string }) => Promise<void>;
  abort: () => void;
  dispose: () => void | Promise<void>;
  subscribe: (listener: (event: AgentEvent) => void | Promise<void>) => () => void;
  /** Inject a user follow-up for the next turn (mid-run product nudges). */
  followUp: (text: string) => void;
  readonly messages: readonly unknown[];
};

export type RunNode4AgentOptions = {
  systemPrompt: string;
  tools: AgentTool<any>[];
  model: Model<any>;
  thinkingLevel?: Node4AgentThinkingLevel;
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
  sessionId?: string;
  beforeToolCall?: Agent["beforeToolCall"];
  afterToolCall?: Agent["afterToolCall"];
  /** Test seam: inject a prebuilt session (skips Agent construction). */
  sessionFactory?: () => Node4AgentSession | Promise<Node4AgentSession>;
};

export type BoundNode4SessionOptions = {
  config: Node4Config;
  runtime: ToolRuntime;
  pack?: RolePack;
  systemPrompt: string;
  thinkingLevel?: Node4AgentThinkingLevel;
};

export type BoundNode4Session = {
  session: Node4AgentSession;
  /** Shared mutable counter (outer-continue + subagent tools_this_package). */
  segmentCounter: { tools: number };
};

/**
 * Resolve model: prefer pi-ai builtin catalog; apply llmBaseUrl override when set;
 * synthesize OpenAI-compatible model only for unknown provider/id pairs.
 */
export function resolveNode4Model(config: Node4Config): Model<any> {
  const provider = String(config.modelProvider || "openai").trim() || "openai";
  const id = String(config.modelId || "gpt-5").trim() || "gpt-5";
  const overrideBase = String(
    config.llmBaseUrl || process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || "",
  ).trim();

  const builtin = tryBuiltinModel(provider, id);
  if (builtin) {
    if (overrideBase) {
      return { ...builtin, baseUrl: overrideBase };
    }
    return builtin;
  }

  const api =
    (process.env.LLM_API as Model<any>["api"] | undefined) || ("openai-completions" as const);
  const contextWindow = Math.max(1024, Number(process.env.LLM_CONTEXT_WINDOW || 128_000) || 128_000);
  const maxTokens = Math.max(256, Number(process.env.LLM_MAX_TOKENS || 8192) || 8192);

  return {
    id,
    name: id,
    api,
    provider,
    baseUrl: overrideBase || defaultBaseUrl(provider),
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

function tryBuiltinModel(provider: string, id: string): Model<any> | undefined {
  try {
    const m = getBuiltinModel(provider as never, id as never) as Model<any> | undefined;
    if (m && typeof m === "object" && m.id && m.api) return m;
  } catch {
    /* not in catalog */
  }
  return undefined;
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
 * Low-level session factory. Prefer {@link createBoundNode4Session} for product paths.
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
    // streamSimple is the stable Agent streamFn today (pi-ai Models.streamSimple is equivalent once providers are registered).
    streamFn: streamSimple,
    getApiKey: options.getApiKey ?? ((provider: string) => resolveNode4ApiKey(provider)),
    beforeToolCall: options.beforeToolCall,
    afterToolCall: options.afterToolCall,
    sessionId: options.sessionId,
  });

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
    followUp: (text: string) => {
      agent.followUp({
        role: "user",
        content: text,
        timestamp: Date.now(),
      });
    },
    get messages() {
      return agent.state.messages;
    },
  };
}

/**
 * Single product boot path for Main / subagent / Hard Graph stages.
 * - tools from pack
 * - mid-run todo via afterToolCall → session.followUp
 * - tool_output + segment counters via AgentEvent bridge only (no dual fan-out)
 */
export async function createBoundNode4Session(
  options: BoundNode4SessionOptions,
): Promise<BoundNode4Session> {
  const { config, runtime, pack, systemPrompt } = options;
  const segmentCounter = { tools: 0 };
  const model = resolveNode4Model(config);
  const tools = createNode4Tools(runtime, pack);

  if (!runtime.lifecycle.midRunTodo) {
    runtime.lifecycle.midRunTodo = createMidRunTodoTracker();
  }

  /** Filled after session wrap so afterToolCall can followUp without onAgent handshake. */
  const followUpHold: { fn?: (text: string) => void } = {};

  const session = await runNode4Agent({
    systemPrompt,
    tools,
    model,
    thinkingLevel: options.thinkingLevel ?? "medium",
    afterToolCall: async (context: AfterToolCallContext) => {
      const tracker = runtime.lifecycle.midRunTodo;
      if (!tracker) return undefined;
      const nudge = noteToolForMidRunTodoNudge(tracker, context.toolCall.name, {
        openTodoCount: runtime.todo.openCount(),
        isError: Boolean(context.isError),
      });
      if (nudge) {
        try {
          followUpHold.fn?.(nudge);
        } catch {
          /* non-fatal */
        }
      }
      return undefined;
    },
  });

  followUpHold.fn = (text) => session.followUp(text);
  attachProductToolEventBridge(session, runtime, segmentCounter);

  return { session, segmentCounter };
}

/**
 * Sole product fan-out for tool start/end → platform tool_output + segment counters.
 * Panel/status for Main still goes through handleNode4SessionEvent on the same events.
 */
export function attachProductToolEventBridge(
  session: Node4AgentSession,
  runtime: ToolRuntime,
  segmentCounter?: { tools: number },
): () => void {
  return session.subscribe(async (event) => {
    if (event.type === "tool_execution_start") {
      if (segmentCounter) segmentCounter.tools += 1;
      runtime.lifecycle.toolsInLastSegment = (runtime.lifecycle.toolsInLastSegment || 0) + 1;
      const toolName = String(event.toolName || "tool");
      const toolCallId = String(event.toolCallId || "");
      await runtime.platform.send({
        type: "tool_output",
        conversation_id: runtime.task.conversationId,
        task_id: runtime.task.taskId,
        tool_name: toolName,
        tool_run_id: toolCallId,
        status: "running",
        summary: `${toolName} running`,
        args: (event as { args?: Record<string, unknown> }).args || {},
      });
      return;
    }

    if (event.type === "tool_execution_end") {
      const toolName = String(event.toolName || "tool");
      const toolCallId = String(event.toolCallId || "");
      const result = (event as { result?: { content?: Array<{ type?: string; text?: string }> } }).result;
      const content = result?.content || [];
      const text = content
        .filter((item) => item?.type === "text")
        .map((item) => item.text || "")
        .join("\n")
        .slice(0, 4000);
      const isError = Boolean((event as { isError?: boolean }).isError);
      await runtime.platform.send({
        type: "tool_output",
        conversation_id: runtime.task.conversationId,
        task_id: runtime.task.taskId,
        tool_name: toolName,
        tool_run_id: toolCallId,
        status: isError ? "error" : "done",
        summary: text.slice(0, 500),
        result_text: text,
      });
    }
  });
}
