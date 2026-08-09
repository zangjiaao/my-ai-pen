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
  /**
   * pi-agent-core Agent.reset(): clear transcript + queues (in-place memory wipe).
   * Spec #354 Reset / pi /new-like reseed may call this before opening a new Agent.
   */
  reset?: () => void;
  subscribe: (listener: (event: AgentEvent) => void | Promise<void>) => () => void;
  /**
   * Mid-run user padding (pi Agent.steer) — after current tool batch / turn boundary.
   * Use for live user_steer (e.g. password hint) while the work burst is busy.
   */
  steer: (text: string) => void;
  /** Inject a user follow-up for the next turn (mid-run product nudges / after stop). */
  followUp: (text: string) => void;
  readonly messages: readonly unknown[];
  /**
   * pi-agent-core Agent.sessionId — provider cache-aware id; renews when a new
   * Agent is constructed (Reset reseed / cold start), not on package settle.
   */
  readonly sessionId?: string;
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
  /**
   * pi-agent-core sessionId. Omit → mint a new UUID (cold start / Reset reseed).
   * Pass prior id only when intentionally continuing the same Agent identity.
   */
  sessionId?: string;
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

  // Shared free + Graph path: do not force reasoning off for unknown models.
  // Opt out with PI_MODEL_REASONING=false when the provider cannot emit thinking blocks.
  const reasoningEnabled = String(process.env.PI_MODEL_REASONING || "true").toLowerCase() !== "false";
  return {
    id,
    name: id,
    api,
    provider,
    baseUrl: overrideBase || defaultBaseUrl(provider),
    reasoning: reasoningEnabled,
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
  // Always bind a concrete sessionId so Reset/Delete can prove a new pi Agent identity.
  const sessionId =
    String(options.sessionId || "").trim() ||
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `n4-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
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
    sessionId,
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
    /**
     * Tear down this pi-agent-core Agent instance (Delete / package end dispose).
     * Aligns with pi coding-agent teardown before SessionManager.newSession:
     * abort active run, clear queues, wipe transcript via Agent.reset().
     */
    dispose: () => {
      try {
        agent.abort();
      } catch {
        /* ignore */
      }
      try {
        agent.reset();
      } catch {
        /* ignore */
      }
      try {
        agent.clearAllQueues();
      } catch {
        /* ignore */
      }
    },
    /** In-place memory wipe without dropping the Agent object (optional). */
    reset: () => {
      try {
        agent.abort();
      } catch {
        /* ignore */
      }
      try {
        agent.reset();
      } catch {
        /* ignore */
      }
    },
    subscribe: (listener) =>
      agent.subscribe(async (event, _signal) => {
        await listener(event);
      }),
    steer: (text: string) => {
      agent.steer({
        role: "user",
        content: text,
        timestamp: Date.now(),
      });
    },
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
    get sessionId() {
      return agent.sessionId;
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
    sessionId: options.sessionId,
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

export type NamedToolInvocation = { toolCallId: string; toolName: string };

/**
 * Spec #350: extract tool invocations whose **name and id are both known** from an
 * assistant partial (toolcall_start / toolcall_delta snapshots).
 * Empty name or id is skipped — identity must match later tool_execution_* toolCallId.
 */
export function namedToolInvocationsFromPartial(message: unknown): NamedToolInvocation[] {
  if (!message || typeof message !== "object") return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const out: NamedToolInvocation[] = [];
  const seen = new Set<string>();
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; id?: string; name?: string; toolName?: string };
    const t = String(b.type || "");
    if (t !== "toolCall" && t !== "tool_use" && t !== "toolcall") continue;
    const toolName = String(b.name || b.toolName || "").trim();
    const toolCallId = String(b.id || "").trim();
    if (!toolName || !toolCallId) continue;
    if (seen.has(toolCallId)) continue;
    seen.add(toolCallId);
    out.push({ toolCallId, toolName });
  }
  return out;
}

/**
 * Sole product fan-out for tool progressive frames → platform tool_output + segment counters.
 * Panel/status for Main still goes through handleNode4SessionEvent on the same events.
 *
 * Spec #350 lifecycle: **tool name known** (streaming toolcall_* with id+name) → one running;
 * tool_execution_start emits running only if not already projected; end → done/error.
 * Segment counters still bump only on tool_execution_start (actual execution).
 * At most one progressive `running` frame per toolCallId (no execute re-emit after name-known).
 *
 * Product policy (A) + Spec #308: **subagent package sessions do not emit Main chat tool_output.**
 * When `lifecycle.subagentDepth > 0`, still count tools for salvage/settlement; if Worker audit
 * scope is set (`lifecycle.workerAudit`), emit parallel Worker-channel frames instead.
 * Lifecycle milestones (`subagent_started` / `subagent_finished`) remain parent-owned.
 */
export function attachProductToolEventBridge(
  session: Node4AgentSession,
  runtime: ToolRuntime,
  segmentCounter?: { tools: number },
): () => void {
  /** toolCallIds that already received a progressive running frame (name-known or execute). */
  const runningEmitted = new Set<string>();

  async function emitToolFrame(opts: {
    toolName: string;
    toolCallId: string;
    status: "running" | "done" | "error";
    summary?: string;
    args?: Record<string, unknown>;
    resultText?: string;
  }): Promise<void> {
    const toolName = opts.toolName || "tool";
    const summary =
      opts.summary != null
        ? String(opts.summary).slice(0, 500)
        : opts.status === "running"
          ? `${toolName} running`
          : "";
    if (isSubagentPackageSession(runtime)) {
      const { emitWorkerToolFrame } = await import("./worker-audit-channel.js");
      await emitWorkerToolFrame({
        runtime,
        toolName,
        toolCallId: opts.toolCallId,
        status: opts.status,
        summary,
        args: opts.args,
        resultText: opts.resultText,
      });
      return;
    }
    // Speaker = requesting Session (task persona). Never handoff destination.
    const speaker: Record<string, string> = {};
    if (runtime.task.expertId) speaker.expert_id = String(runtime.task.expertId);
    if (runtime.task.expertName) speaker.expert_name = String(runtime.task.expertName);
    await runtime.platform.send({
      type: "tool_output",
      conversation_id: runtime.task.conversationId,
      task_id: runtime.task.taskId,
      tool_name: toolName,
      tool_run_id: opts.toolCallId,
      status: opts.status,
      summary,
      args: opts.args,
      result_text: opts.resultText != null ? String(opts.resultText).slice(0, 4000) : undefined,
      ...speaker,
    });
  }

  async function emitRunningOnce(
    toolName: string,
    toolCallId: string,
    args?: Record<string, unknown>,
  ): Promise<void> {
    if (runningEmitted.has(toolCallId)) return;
    runningEmitted.add(toolCallId);
    // Args may be incomplete at name-known — do not dump streaming bodies (story 30).
    await emitToolFrame({
      toolName,
      toolCallId,
      status: "running",
      args: args || {},
    });
  }

  return session.subscribe(async (event: AgentEvent) => {
    // Spec #350 D1: project running as soon as name+id known while args may still stream.
    if (event.type === "message_update") {
      const msg = event.message;
      if (msg && typeof msg === "object" && "role" in msg && msg.role !== "assistant") return;
      const ame = event.assistantMessageEvent;
      const kind = String(ame?.type || "");
      if (!kind.startsWith("toolcall_")) return;
      // Streaming SoT is partial; fall back to message when partial is absent.
      const snapshot =
        ame && "partial" in ame && ame.partial != null ? ame.partial : msg;
      for (const inv of namedToolInvocationsFromPartial(snapshot)) {
        await emitRunningOnce(inv.toolName, inv.toolCallId);
      }
      return;
    }

    if (event.type === "tool_execution_start") {
      if (segmentCounter) segmentCounter.tools += 1;
      runtime.lifecycle.toolsInLastSegment = (runtime.lifecycle.toolsInLastSegment || 0) + 1;
      const toolName = String(event.toolName || "tool");
      const toolCallId = String(event.toolCallId || "");
      // Emit running only if name-known did not already project this id.
      const args =
        event.args && typeof event.args === "object" && !Array.isArray(event.args)
          ? (event.args as Record<string, unknown>)
          : {};
      await emitRunningOnce(toolName, toolCallId, args);
      return;
    }

    if (event.type === "tool_execution_end") {
      const toolName = String(event.toolName || "tool");
      const toolCallId = String(event.toolCallId || "");
      const result = event.result;
      const content =
        result && typeof result === "object" && Array.isArray(result.content)
          ? (result.content as Array<{ type?: string; text?: string }>)
          : [];
      const text = content
        .filter((item) => item?.type === "text")
        .map((item) => item.text || "")
        .join("\n")
        .slice(0, 4000);
      const isError = Boolean(event.isError);
      runningEmitted.delete(toolCallId);
      await emitToolFrame({
        toolName,
        toolCallId,
        status: isError ? "error" : "done",
        summary: text.slice(0, 500),
        resultText: text,
      });
    }
  });
}

/** True for Agent Graph package workers (not Hard Graph stage Main). */
export function isSubagentPackageSession(runtime: ToolRuntime): boolean {
  const depth = Number(runtime.lifecycle?.subagentDepth ?? 0);
  if (depth > 0) return true;
  // Belt-and-suspenders: child task ids look like `{taskId}/sub/{subId}`.
  const tid = String(runtime.task?.taskId || "");
  return /\/sub\//.test(tid);
}
