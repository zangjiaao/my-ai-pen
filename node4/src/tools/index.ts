import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RolePack } from "../roles/index.js";
import type { ToolRuntime } from "../types.js";
import { createBrowserTool } from "./browser.js";
import { createCaptchaTool } from "./captcha.js";
import { createFindingTool } from "./finding.js";
import { createEditTool, createReadTool, createWriteTool } from "./fs-tools.js";
import { createGoalTool } from "./goal.js";
import { createHttpTool } from "./http.js";
import { createScriptTool } from "./script.js";
import { createSessionTool } from "./session.js";
import { createShellTool } from "./shell.js";
import { createSkillTool } from "./skill.js";
import { createSubagentTool } from "./subagent.js";
import { createTodoTool } from "./todo.js";

/** Full registry of tool factories (role packs select a subset). */
export const ALL_NODE4_TOOL_FACTORIES: Record<string, (runtime: ToolRuntime) => ToolDefinition<any>> = {
  todo: createTodoTool,
  shell: createShellTool,
  write: createWriteTool,
  edit: createEditTool,
  read: createReadTool,
  http: createHttpTool,
  session: createSessionTool,
  browser: createBrowserTool,
  captcha: createCaptchaTool,
  script: createScriptTool,
  finding: createFindingTool,
  subagent: createSubagentTool,
  goal: createGoalTool,
  skill: createSkillTool,
};

/** Bare OMP runtime tool order (no expert pack). Expert packs pass their own toolNames. */
export const NODE4_TOOL_NAMES = [
  "todo",
  "shell",
  "write",
  "edit",
  "read",
  "http",
  "script",
  "finding",
  "subagent",
  "goal",
] as const;

export function createNode4Tools(runtime: ToolRuntime, pack?: RolePack): ToolDefinition<any>[] {
  const names = pack?.toolNames?.length ? pack.toolNames : NODE4_TOOL_NAMES;
  const tools: ToolDefinition<any>[] = [];
  for (const name of names) {
    const factory = ALL_NODE4_TOOL_FACTORIES[name];
    if (factory) tools.push(factory(runtime));
  }
  return tools;
}

export function toolNamesForPack(pack: RolePack): string[] {
  return [...pack.toolNames];
}
