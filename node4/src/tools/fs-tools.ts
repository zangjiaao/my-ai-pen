import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";

function safeUnderTask(taskDir: string, rawPath: string): string {
  const base = resolve(taskDir);
  const target = resolve(taskDir, rawPath.replace(/^\//, ""));
  const rel = relative(base, target);
  if (rel.startsWith("..") || rel === "..") throw new Error("path escape blocked");
  return target;
}

export function createWriteTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "write",
    label: "Write",
    description: "Create or overwrite a file under the task workspace (exploit scripts, notes).",
    parameters: Type.Object({
      path: Type.String(),
      content: Type.String(),
    }),
    async execute(_id: string, params: any) {
      const file = safeUnderTask(runtime.taskDir, String(params.path || ""));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, String(params.content ?? ""), "utf8");
      return jsonResult({ ok: true, path: file });
    },
  };
}

export function createReadTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "read",
    label: "Read",
    description: "Read a file under the task workspace (optional offset/limit lines).",
    parameters: Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: any) {
      const file = safeUnderTask(runtime.taskDir, String(params.path || ""));
      let text = await readFile(file, "utf8");
      const lines = text.split(/\n/);
      const offset = Math.max(0, Number(params.offset || 0));
      const limit = params.limit != null ? Math.max(1, Number(params.limit)) : undefined;
      const slice = limit != null ? lines.slice(offset, offset + limit) : lines.slice(offset);
      return textResult(slice.join("\n"), { path: file, lines: slice.length, total_lines: lines.length });
    },
  };
}

export function createEditTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "edit",
    label: "Edit",
    description: "Replace an exact old_string with new_string in a task workspace file (OMP-like surgical edit).",
    parameters: Type.Object({
      path: Type.String(),
      old_string: Type.String(),
      new_string: Type.String(),
    }),
    async execute(_id: string, params: any) {
      const file = safeUnderTask(runtime.taskDir, String(params.path || ""));
      const oldStr = String(params.old_string ?? "");
      const newStr = String(params.new_string ?? "");
      if (!oldStr) return textResult("error: old_string required");
      const text = await readFile(file, "utf8");
      const count = text.split(oldStr).length - 1;
      if (count === 0) return textResult("error: old_string not found");
      if (count > 1) return textResult(`error: old_string matched ${count} times; make it unique`);
      await writeFile(file, text.replace(oldStr, newStr), "utf8");
      const st = await stat(file);
      return jsonResult({ ok: true, path: file, bytes: st.size });
    },
  };
}

/** Helper for smokes / listing */
export function taskRelative(taskDir: string, abs: string): string {
  return relative(taskDir, abs) || ".";
}

export { safeUnderTask, join };
