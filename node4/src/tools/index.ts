import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { createFinishTool } from "./finish.js";
import { createFindingTool } from "./finding.js";
import { createHttpTool } from "./http.js";
import { createScriptTool } from "./script.js";
import { createTodoTool } from "./todo.js";

export const NODE4_TOOL_NAMES = ["todo", "http", "script", "finding", "finish_scan"] as const;

export function createNode4Tools(runtime: ToolRuntime): ToolDefinition<any>[] {
  return [
    createTodoTool(runtime),
    createHttpTool(runtime),
    createScriptTool(runtime),
    createFindingTool(runtime),
    createFinishTool(runtime),
  ];
}
