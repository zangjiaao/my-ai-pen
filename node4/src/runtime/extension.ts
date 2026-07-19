import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { RolePack } from "../roles/index.js";
import type { ToolRuntime } from "../types.js";
import { createNode4Tools } from "../tools/index.js";
import {
  createMidRunTodoTracker,
  noteToolForMidRunTodoNudge,
  resetMidRunTodoCycle,
} from "./todo-harness.js";

export type SegmentCounter = { tools: number };

/**
 * Pi extension: tools + observability hooks.
 *
 * Wall-clock for the right panel is **task lifecycle** (`task_start` /
 * `task_complete` + checkpoint started_at/end_time in session-runner) — not
 * per-tool. These hooks only stream tool activity and mid-run todo nudges.
 */
export function createNode4Extension(
  runtime: ToolRuntime,
  segmentCounter?: SegmentCounter,
  pack?: RolePack,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    for (const tool of createNode4Tools(runtime, pack)) {
      pi.registerTool(tool);
    }

    // Mid-run todo tracker (lab / soft nudge). Outer continue cycles may reset it when enabled.
    if (!runtime.lifecycle.midRunTodo) {
      runtime.lifecycle.midRunTodo = createMidRunTodoTracker();
    }

    pi.on("tool_call", async (event) => {
      // Observability only — does not open/close the work-burst timer.
      if (segmentCounter) segmentCounter.tools += 1;
      runtime.lifecycle.toolsInLastSegment = (runtime.lifecycle.toolsInLastSegment || 0) + 1;
      await runtime.platform.send({
        type: "tool_output",
        conversation_id: runtime.task.conversationId,
        task_id: runtime.task.taskId,
        tool_name: event.toolName,
        tool_run_id: event.toolCallId,
        status: "running",
        summary: `${event.toolName} running`,
        args: event.input || {},
      });
      return undefined;
    });

    pi.on("tool_result", async (event) => {
      const text = event.content
        .filter((item: { type: string; text?: string }) => item.type === "text")
        .map((item: { type: string; text?: string }) => ("text" in item ? item.text || "" : ""))
        .join("\n")
        .slice(0, 4000);
      await runtime.platform.send({
        type: "tool_output",
        conversation_id: runtime.task.conversationId,
        task_id: runtime.task.taskId,
        tool_name: event.toolName,
        tool_run_id: event.toolCallId,
        status: event.isError ? "error" : "done",
        summary: text.slice(0, 500),
        result_text: text,
      });

      // OMP #3651: after enough act tools without todo, gently ask to mark finished categories.
      const tracker = runtime.lifecycle.midRunTodo;
      if (tracker) {
        const nudge = noteToolForMidRunTodoNudge(tracker, event.toolName, {
          openTodoCount: runtime.todo.openCount(),
          isError: Boolean(event.isError),
        });
        if (nudge) {
          try {
            pi.sendMessage(
              {
                customType: "mid-run-todo-nudge",
                content: nudge,
                display: false,
              },
              { deliverAs: "nextTurn" },
            );
          } catch {
            // Older pi / non-interactive: skip injection; continue-path still has midRunTodoNudge.
          }
        }
      }
    });
  };
}

export { resetMidRunTodoCycle };
