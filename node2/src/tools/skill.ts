import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";

export function createSkillTool(runtime: ToolRuntime): ToolDefinition<any> {
  const skillRoot = resolve("skills");
  return {
    name: "skill",
    label: "Skill",
    description: "List or read pentest skill packages. A skill is a directory with SKILL.md and optional payloads, scripts, references, and recipes.",
    promptSnippet: "Load pentest skill packages and auxiliary files",
    promptGuidelines: [
      "Use skill(list) before choosing a vulnerability methodology; use skill(read) when a target suggests that class.",
      "Prefer skill-provided payloads and references over ad hoc memory when available.",
    ],
    parameters: Type.Object({
      action: Type.String(),
      name: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId: string, params: any) {
      if (params.action === "list") {
        const names = await readdir(skillRoot, { withFileTypes: true }).catch(() => []);
        return jsonResult(names.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name));
      }
      if (!params.name) return textResult("error: name is required");
      const base = safeJoin(skillRoot, params.name);
      if (params.action === "read") return textResult(await readFile(safeJoin(base, params.path || "SKILL.md"), "utf8"));
      if (params.action === "files") {
        return jsonResult(await listFiles(base));
      }
      return textResult("error: action must be list, read, or files");
    },
  };
}

function safeJoin(base: string, child: string): string {
  const resolved = resolve(base, child);
  if (!resolved.startsWith(resolve(base))) throw new Error("path escapes skill root");
  return resolved;
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await listFiles(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}
