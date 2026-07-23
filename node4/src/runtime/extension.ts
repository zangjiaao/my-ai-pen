/**
 * Product Runtime bindings: tools + tool_output / mid-run todo hooks.
 * Replaces pi-coding-agent ExtensionAPI registration.
 */

import type { Agent, AgentTool, AfterToolCallContext, BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import type { RolePack } from "../roles/index.js";
import type { ToolRuntime } from "../types.js";
import { createNode4Tools } from "../tools/index.js";
import {
  createMidRunTodoTracker,
  noteToolForMidRunTodoNudge,
  resetMidRunTodoCycle,
} from "./todo-harness.js";

export type SegmentCounter = { tools: number };

export type Node4RuntimeBindings = {
  tools: AgentTool<any>[];
  beforeToolCall: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<undefined>;
  afterToolCall: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<undefined>;
  /** Attach after session is created so mid-run nudges can followUp. */
  attachAgent?: (agent: Agent) => void;
};

/**
 * Build tools and Agent hooks for a ToolRuntime (Main / child / stage).
 */
export function createNode4RuntimeBindings(
  runtime: ToolRuntime,
  segmentCounter?: SegmentCounter,
  pack?: RolePack,
): Node4RuntimeBindings {
  const tools = createNode4Tools(runtime, pack);
  if (!runtime.lifecycle.midRunTodo) {
    runtime.lifecycle.midRunTodo = createMidRunTodoTracker();
  }

  let agentRef: Agent | undefined;

  return {
    tools,
    beforeToolCall: async (context) => {
      if (segmentCounter) segmentCounter.tools += 1;
      runtime.lifecycle.toolsInLastSegment = (runtime.lifecycle.toolsInLastSegment || 0) + 1;
      const name = context.toolCall.name;
      const id = context.toolCall.id;
      await runtime.platform.send({
        type: "tool_output",
        conversation_id: runtime.task.conversationId,
        task_id: runtime.task.taskId,
        tool_name: name,
        tool_run_id: id,
        status: "running",
        summary: `${name} running`,
        args: (context.args as Record<string, unknown>) || context.toolCall.arguments || {},
      });
      return undefined;
    },
    afterToolCall: async (context) => {
      const content = context.result?.content || [];
      const text = content
        .filter((item: { type: string; text?: string }) => item.type === "text")
        .map((item: { type: string; text?: string }) => ("text" in item ? item.text || "" : ""))
        .join("\n")
        .slice(0, 4000);
      const isError = Boolean(context.isError);
      await runtime.platform.send({
        type: "tool_output",
        conversation_id: runtime.task.conversationId,
        task_id: runtime.task.taskId,
        tool_name: context.toolCall.name,
        tool_run_id: context.toolCall.id,
        status: isError ? "error" : "done",
        summary: text.slice(0, 500),
        result_text: text,
      });

      const tracker = runtime.lifecycle.midRunTodo;
      if (tracker && agentRef) {
        const nudge = noteToolForMidRunTodoNudge(tracker, context.toolCall.name, {
          openTodoCount: runtime.todo.openCount(),
          isError,
        });
        if (nudge) {
          try {
            agentRef.followUp({
              role: "user",
              content: nudge,
              timestamp: Date.now(),
            } as any);
          } catch {
            /* non-fatal */
          }
        }
      }
      return undefined;
    },
    attachAgent: (agent) => {
      agentRef = agent;
    },
  };
}

/** @deprecated name — use createNode4RuntimeBindings */
export function createNode4Extension(
  runtime: ToolRuntime,
  segmentCounter?: SegmentCounter,
  pack?: RolePack,
): Node4RuntimeBindings {
  return createNode4RuntimeBindings(runtime, segmentCounter, pack);
}

export { resetMidRunTodoCycle };
