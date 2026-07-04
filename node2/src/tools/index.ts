import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { createBrowserTool } from "./browser.js";
import { createCoverageTool } from "./coverage.js";
import { createFindingTool } from "./finding.js";
import { createHttpTool } from "./http.js";
import { createPocTool } from "./poc.js";
import { createScanTool } from "./scan.js";
import { createSkillTool } from "./skill.js";
import { createTrafficTool } from "./traffic.js";

export const PENTEST_TOOL_NAMES = [
  "http",
  "browser",
  "traffic",
  "scan",
  "coverage",
  "skill",
  "poc",
  "finding",
] as const;

export function createPentestTools(runtime: ToolRuntime): ToolDefinition<any>[] {
  return [
    createHttpTool(runtime),
    createBrowserTool(runtime),
    createTrafficTool(runtime),
    createScanTool(runtime),
    createCoverageTool(runtime),
    createSkillTool(runtime),
    createPocTool(runtime),
    createFindingTool(runtime),
  ];
}
