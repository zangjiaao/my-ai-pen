import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { createNode4Tools } from "../tools/index.js";

export function createNode4Extension(runtime: ToolRuntime): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    for (const tool of createNode4Tools(runtime)) {
      pi.registerTool(tool);
    }

    pi.on("tool_call", async (event) => {
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
        .map((item: { text?: string }) => item.text || "")
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
    });
  };
}
