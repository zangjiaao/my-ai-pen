import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { createBrowserTool } from "./browser.js";
import { createCoverageTool } from "./coverage.js";
import { createFinishScanTool } from "./finish.js";
import { createFindingTool } from "./finding.js";
import { createHttpTool } from "./http.js";
import { createPocTool } from "./poc.js";
import { createScanTool } from "./scan.js";
import { createTrafficTool } from "./traffic.js";
import { createVerifierTool } from "./verifier.js";

export const PENTEST_TOOL_NAMES = [
  "read",
  "http",
  "browser",
  "traffic",
  "scan",
  "coverage",
  "poc",
  "verifier",
  "finding",
  "finish_scan",
  "workflow_list",
  "workflow_run",
  "workflow_dynamic",
] as const;

export function createPentestTools(runtime: ToolRuntime): ToolDefinition<any>[] {
  return [
    createHttpTool(runtime),
    createBrowserTool(runtime),
    createTrafficTool(runtime),
    createScanTool(runtime),
    createCoverageTool(runtime),
    createPocTool(runtime),
    createVerifierTool(runtime),
    createFindingTool(runtime),
    createFinishScanTool(runtime),
  ];
}
