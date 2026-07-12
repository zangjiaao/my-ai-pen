/**
 * Browser tool — host agent-browser CLI (assistive eyes for SPA/login/captcha UI).
 * Cookies can be exported into session actor jars for dual-identity HTTP replay.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { parseCookiesJson, runAgentBrowser } from "../runtime/agent-browser-cli.js";
import type { ToolRuntime } from "../types.js";
import { emitEvidence, isInScope, jsonResult, resolveTargetUrl, textResult } from "./common.js";

const ACTIONS = [
  "open",
  "goto",
  "snapshot",
  "click",
  "fill",
  "type",
  "press",
  "read",
  "screenshot",
  "cookies",
  "export_cookies",
  "close",
] as const;

export function createBrowserTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "browser",
    label: "Browser",
    description: [
      "Real browser automation via agent-browser (host Chromium).",
      `Actions: ${ACTIONS.join(", ")}.`,
      "Use for JS-heavy pages, captcha UI, stored XSS verification, multi-step forms.",
      "Workflow: open → snapshot -i → click/fill @refs → re-snapshot.",
      "export_cookies: write browser cookies into session actor jar (default actor=browser) for dual-identity HTTP.",
      "Does not restrict you — when browser is unavailable the error explains install steps; shell remains available.",
    ].join(" "),
    parameters: Type.Object({
      action: Type.String(),
      url: Type.Optional(Type.String()),
      selector: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      key: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      /** Target session actor when exporting cookies (default: browser). */
      actor: Type.Optional(Type.String()),
      interactive: Type.Optional(Type.Boolean()),
      full_page: Type.Optional(Type.Boolean()),
    }),
    async execute(_id: string, params: any) {
      const action = String(params.action || "").trim().toLowerCase();
      if (!ACTIONS.includes(action as (typeof ACTIONS)[number]) && action !== "goto") {
        return textResult(`error: action must be one of ${ACTIONS.join("|")}`);
      }

      await mkdir(join(runtime.taskDir, "browser"), { recursive: true });
      const run = (args: string[], timeoutMs?: number) =>
        runAgentBrowser(args, {
          taskId: runtime.task.taskId,
          taskDir: runtime.taskDir,
          timeoutMs,
        });

      if (action === "close") {
        const r = await run(["close"], 30_000);
        return jsonResult({
          ok: r.exitCode === 0,
          action: "close",
          text: (r.stdout || r.stderr || r.error || "").slice(0, 2000),
        });
      }

      if (action === "open" || action === "goto") {
        if (!params.url) return textResult("error: url required");
        let url: string;
        try {
          url = resolveTargetUrl(runtime, String(params.url));
        } catch (e) {
          return textResult(`error: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (!isInScope(runtime, url)) return textResult(`error: out of scope: ${url}`);
        const opened = await run(["open", url], 120_000);
        if (opened.unavailable) return textResult(`error: ${opened.error}`);
        if (opened.exitCode !== 0 && !/https?:\/\//i.test(opened.stdout + opened.stderr)) {
          return textResult(
            `error: browser open failed: ${(opened.error || opened.stderr || opened.stdout).slice(0, 800)}`,
          );
        }
        await run(["wait", "800"], 15_000);
        const snap = await run(["snapshot", "-i"], 60_000);
        const evidenceId = await emitEvidence(runtime, "browser", `browser open ${url}`, {
          url,
          snapshot: snap.stdout.slice(0, 12_000),
          cli: opened.stdout.slice(0, 2000),
        });
        return jsonResult({
          ok: true,
          action: "open",
          url,
          snapshot: snap.stdout.slice(0, 12_000),
          evidence_id: evidenceId,
          guidance: "Use refs like @e3 from snapshot for click/fill. Re-snapshot after navigation.",
        });
      }

      if (action === "snapshot") {
        const args = ["snapshot"];
        if (params.interactive !== false) args.push("-i");
        const r = await run(args, 60_000);
        if (r.unavailable) return textResult(`error: ${r.error}`);
        const evidenceId = await emitEvidence(runtime, "browser", "browser snapshot", {
          snapshot: r.stdout.slice(0, 16_000),
        });
        return jsonResult({
          ok: r.exitCode === 0 || r.stdout.length > 0,
          action: "snapshot",
          snapshot: r.stdout.slice(0, 16_000),
          evidence_id: evidenceId,
        });
      }

      if (action === "click") {
        if (!params.selector) return textResult("error: selector required (@eN or CSS)");
        const r = await run(["click", String(params.selector)], 60_000);
        if (r.unavailable) return textResult(`error: ${r.error}`);
        const snap = await run(["snapshot", "-i"], 45_000);
        return jsonResult({
          ok: r.exitCode === 0 || /click|✓|Done/i.test(r.stdout + r.stderr),
          action: "click",
          selector: params.selector,
          cli: (r.stdout || r.stderr).slice(0, 1500),
          snapshot: snap.stdout.slice(0, 10_000),
        });
      }

      if (action === "fill" || action === "type") {
        if (!params.selector) return textResult("error: selector required");
        const cmd = action === "fill" ? "fill" : "type";
        const r = await run([cmd, String(params.selector), String(params.text ?? "")], 60_000);
        if (r.unavailable) return textResult(`error: ${r.error}`);
        return jsonResult({
          ok: r.exitCode === 0 || /fill|type|✓|Done/i.test(r.stdout + r.stderr),
          action,
          selector: params.selector,
          cli: (r.stdout || r.stderr).slice(0, 1500),
        });
      }

      if (action === "press") {
        const key = String(params.key || "Enter");
        const r = await run(["press", key], 30_000);
        if (r.unavailable) return textResult(`error: ${r.error}`);
        return jsonResult({
          ok: r.exitCode === 0 || /press|✓|Done/i.test(r.stdout + r.stderr),
          action: "press",
          key,
          cli: (r.stdout || r.stderr).slice(0, 1000),
        });
      }

      if (action === "read") {
        const args = params.url ? ["read", String(params.url)] : ["read"];
        if (params.url) {
          try {
            const u = resolveTargetUrl(runtime, String(params.url));
            if (!isInScope(runtime, u)) return textResult(`error: out of scope: ${u}`);
            args[1] = u;
          } catch (e) {
            return textResult(`error: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        const r = await run(args, 60_000);
        if (r.unavailable) return textResult(`error: ${r.error}`);
        const evidenceId = await emitEvidence(runtime, "browser", "browser read", {
          text: r.stdout.slice(0, 12_000),
        });
        return jsonResult({
          ok: true,
          action: "read",
          text: r.stdout.slice(0, 12_000),
          evidence_id: evidenceId,
        });
      }

      if (action === "screenshot") {
        const path =
          params.path != null
            ? String(params.path)
            : join(runtime.taskDir, "browser", `shot_${Date.now()}.png`);
        const args = ["screenshot"];
        if (params.selector) args.push(String(params.selector));
        args.push(path);
        if (params.full_page) args.push("--full");
        const r = await run(args, 60_000);
        if (r.unavailable) return textResult(`error: ${r.error}`);
        const evidenceId = await emitEvidence(runtime, "browser", `browser screenshot ${path}`, {
          path,
          cli: (r.stdout || r.stderr).slice(0, 1500),
        });
        return jsonResult({
          ok: r.exitCode === 0 || /saved|screenshot|png|jpeg/i.test(r.stdout + r.stderr + path),
          action: "screenshot",
          path,
          cli: (r.stdout || r.stderr).slice(0, 1500),
          evidence_id: evidenceId,
          guidance: "Use path with captcha tool or read image offline; for OCR try captcha(op=ocr, image_path=...)",
        });
      }

      if (action === "cookies") {
        const r = await run(["cookies", "get", "--json"], 30_000);
        if (r.unavailable) return textResult(`error: ${r.error}`);
        const jar = parseCookiesJson(r.stdout || r.stderr);
        return jsonResult({
          ok: true,
          action: "cookies",
          cookies: jar,
          raw: (r.stdout || "").slice(0, 4000),
        });
      }

      if (action === "export_cookies") {
        const actor = sanitizeActor(params.actor != null ? String(params.actor) : "browser");
        const r = await run(["cookies", "get", "--json"], 30_000);
        if (r.unavailable) return textResult(`error: ${r.error}`);
        const jar = parseCookiesJson(r.stdout || r.stderr);
        const dir = join(runtime.taskDir, "session", "actors", actor);
        await mkdir(dir, { recursive: true });
        const jarPath = join(dir, "cookies.json");
        // merge with existing actor jar
        let existing: Record<string, string> = {};
        try {
          const { readFile } = await import("node:fs/promises");
          existing = JSON.parse(await readFile(jarPath, "utf8")) as Record<string, string>;
        } catch {
          existing = {};
        }
        const merged = { ...existing, ...jar };
        await writeFile(jarPath, JSON.stringify(merged, null, 2), "utf8");
        // also mirror default path if actor is default
        if (actor === "default") {
          await mkdir(join(runtime.taskDir, "session"), { recursive: true });
          await writeFile(join(runtime.taskDir, "session", "cookies.json"), JSON.stringify(merged, null, 2), "utf8");
        }
        const evidenceId = await emitEvidence(runtime, "browser", `export cookies → session actor=${actor}`, {
          actor,
          cookies: merged,
        });
        return jsonResult({
          ok: true,
          action: "export_cookies",
          actor,
          cookies: merged,
          jar_path: jarPath,
          evidence_id: evidenceId,
          guidance: `Use session(op=request|chain, actor="${actor}") to replay as this identity.`,
        });
      }

      return textResult(`error: unhandled action ${action}`);
    },
  };
}

function sanitizeActor(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_").slice(0, 48);
  return s || "default";
}
