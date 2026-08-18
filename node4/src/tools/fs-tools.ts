import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolRuntime } from "../types.js";
import { recordActObservation, jsonResult, textResult } from "./common.js";

/** Session sandbox root: expertDir (`/workspace`), not the pi-instance dir. */
export function sessionWorkspaceRoot(runtime: Pick<ToolRuntime, "sessionDir" | "piDir">): string {
  const raw = String(runtime.sessionDir || runtime.piDir || "").trim();
  return resolve(raw || ".");
}

export function toSandboxPath(rel: string): string {
  const clean = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
  return `/workspace/${clean}`;
}

/** Strip /workspace/ or a known host root so agents can pass either style. */
export function normalizeWorkspaceRel(
  rawPath: string,
  roots: { sessionDir?: string; piDir?: string } = {},
): string {
  let p = String(rawPath || "").trim().replace(/\\/g, "/");
  if (p.startsWith("/workspace/")) p = p.slice("/workspace/".length);
  else if (p === "/workspace") p = "";
  for (const root of [roots.sessionDir, roots.piDir]) {
    if (!root) continue;
    const absRoot = resolve(root).replace(/\\/g, "/");
    const absP = p.startsWith("/") ? p : "";
    if (absP && (absP === absRoot || absP.startsWith(absRoot + "/"))) {
      p = relative(absRoot, absP).replace(/\\/g, "/");
      break;
    }
  }
  p = p.replace(/^\/+/, "");
  if (!p || p === ".") throw new Error("path required");
  if (p.split("/").includes("..")) throw new Error("path escape blocked");
  return p;
}

function safeUnderTask(root: string, rawPath: string): string {
  const base = resolve(root);
  const rel = normalizeWorkspaceRel(rawPath, { piDir: root });
  const target = resolve(root, rel);
  const check = relative(base, target);
  if (check.startsWith("..") || check === "..") throw new Error("path escape blocked");
  return target;
}

function looksLikeSourceMaterial(relPath: string, content: string): boolean {
  const p = relPath.replace(/\\/g, "/").toLowerCase();
  // Agent probe/exploit scripts are process artifacts, not target source for code-audit.
  if (p.startsWith("scripts/") || p.includes("/scripts/") || /_probe\.(py|js|mjs)$/.test(p)) {
    return false;
  }
  if (
    p.includes("source_dump") ||
    p.includes("notes/") ||
    p.includes("leak") ||
    p.includes("/source/") ||
    p.endsWith(".java") ||
    p.endsWith(".php") ||
    p.endsWith(".jsp") ||
    p.endsWith(".aspx") ||
    p.endsWith(".go") ||
    p.endsWith(".rb") ||
    p.endsWith(".cs") ||
    p.endsWith(".c") ||
    p.endsWith(".cpp") ||
    p.endsWith(".h") ||
    // .py/.js only when under material-ish dirs (not scripts/)
    ((p.endsWith(".py") || p.endsWith(".js") || p.endsWith(".ts") || p.endsWith(".html")) &&
      (p.includes("notes/") || p.includes("dump") || p.includes("source")))
  ) {
    return content.length >= 20;
  }
  return content.length >= 200;
}

export function createWriteTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "write",
    label: "Write",
    description:
      "Create or overwrite a file under the Session workspace (sandbox /workspace — scripts/, notes/). Prefer path like scripts/probe.py. Shell cwd is /workspace. To share as Case proof, quote path+preview in finding(confirm) proof after writing.",
    parameters: Type.Object({
      path: Type.String(),
      content: Type.String(),
    }),
    async execute(_id: string, params: any) {
      const root = sessionWorkspaceRoot(runtime);
      const rel = normalizeWorkspaceRel(String(params.path || ""), {
        sessionDir: runtime.sessionDir,
        piDir: runtime.piDir,
      });
      const file = safeUnderTask(root, rel);
      const content = String(params.content ?? "");
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content, "utf8");
      const st = await stat(file);
      const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
      const preview = content.slice(0, 2500);
      const material = looksLikeSourceMaterial(rel, content);
      recordActObservation(
        runtime,
        "write",
        material ? `source/material ${rel}` : `file write ${rel}`,
        {
          kind: material ? "source_excerpt" : "file",
          path: rel,
          file,
          hash: `sha256:${hash}`,
          bytes: st.size,
          preview,
          content: preview,
        },
        { role: material || content.length >= 40 ? "proof" : "trace" },
      );
      return jsonResult({
        ok: true,
        path: toSandboxPath(rel),
        relative_path: rel,
        bytes: st.size,
      });
    },
  };
}

export function createReadTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "read",
    label: "Read",
    description: "Read a file under the Session workspace (sandbox /workspace). Optional offset/limit lines.",
    parameters: Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: any) {
      const file = safeUnderTask(
        sessionWorkspaceRoot(runtime),
        normalizeWorkspaceRel(String(params.path || ""), {
          sessionDir: runtime.sessionDir,
          piDir: runtime.piDir,
        }),
      );
      let text = await readFile(file, "utf8");
      const lines = text.split(/\n/);
      const offset = Math.max(0, Number(params.offset || 0));
      const limit = params.limit != null ? Math.max(1, Number(params.limit)) : undefined;
      const slice = limit != null ? lines.slice(offset, offset + limit) : lines.slice(offset);
      // Intentionally does NOT emit Case evidence (Phase D: read is not proof booking).
      return textResult(slice.join("\n"), { path: file, lines: slice.length, total_lines: lines.length });
    },
  };
}

export function createEditTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "edit",
    label: "Edit",
    description: "Replace an exact old_string with new_string in a Session workspace file (sandbox /workspace).",
    parameters: Type.Object({
      path: Type.String(),
      old_string: Type.String(),
      new_string: Type.String(),
    }),
    async execute(_id: string, params: any) {
      const file = safeUnderTask(
        sessionWorkspaceRoot(runtime),
        normalizeWorkspaceRel(String(params.path || ""), {
          sessionDir: runtime.sessionDir,
          piDir: runtime.piDir,
        }),
      );
      const oldStr = String(params.old_string ?? "");
      const newStr = String(params.new_string ?? "");
      if (!oldStr) return textResult("error: old_string required");
      const text = await readFile(file, "utf8");
      const count = text.split(oldStr).length - 1;
      if (count === 0) return textResult("error: old_string not found");
      if (count > 1) return textResult(`error: old_string matched ${count} times; make it unique`);
      await writeFile(file, text.replace(oldStr, newStr), "utf8");
      const st = await stat(file);
      return jsonResult({
        ok: true,
        path: toSandboxPath(
          normalizeWorkspaceRel(String(params.path || ""), {
            sessionDir: runtime.sessionDir,
            piDir: runtime.piDir,
          }),
        ),
        bytes: st.size,
      });
    },
  };
}

/** Helper for smokes / listing */
export function taskRelative(taskDir: string, abs: string): string {
  return relative(taskDir, abs) || ".";
}

export { safeUnderTask, join };
