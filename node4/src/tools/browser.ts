/**
 * Browser tool — prefer Docker strix-sandbox agent-browser (Node2/3 class);
 * host agent-browser only as fallback when sandbox cannot start.
 * Cookies export into session actor jars for dual-identity HTTP replay.
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { parseCookiesJson } from "../runtime/agent-browser-cli.js";
import {
  rewriteUrlForSandbox,
  runBrowserCommand,
  stopBrowserSandbox,
} from "../runtime/browser-sandbox.js";
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
      "Real browser automation via agent-browser.",
      "Default: Docker strix-sandbox (isolated Chromium + deps). Host fallback if sandbox unavailable.",
      `Actions: ${ACTIONS.join(", ")}.`,
      "Use for JS-heavy pages, captcha UI, stored XSS verification, multi-step forms.",
      "Workflow: open → snapshot -i → click/fill @refs → re-snapshot.",
      "export_cookies: write browser cookies into session actor jar (default actor=browser) for dual-identity HTTP.",
      "Does not restrict shell — when browser fails, error includes setup hints.",
    ].join(" "),
    parameters: Type.Object({
      action: Type.String(),
      url: Type.Optional(Type.String()),
      selector: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      key: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
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
        runBrowserCommand(runtime, args, timeoutMs);

      if (action === "close") {
        const r = await run(["close"], 30_000);
        await stopBrowserSandbox(runtime.task.taskId).catch(() => {});
        return jsonResult({
          ok: r.exitCode === 0,
          action: "close",
          via: r.via,
          text: (r.text || r.error || "").slice(0, 2000),
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
        // Container reaches host services via host.docker.internal
        const openUrl = rewriteUrlForSandbox(url);
        const opened = await run(["open", openUrl], 120_000);
        if (opened.unavailable) {
          return textResult(
            `error: browser unavailable: ${opened.error || "no docker/host agent-browser"}. Prefer Docker image ghcr.io/usestrix/strix-sandbox:1.0.0 (NODE4_BROWSER_SANDBOX=1). Host needs: agent-browser install --with-deps`,
          );
        }
        if (opened.exitCode !== 0 && !/https?:\/\//i.test(opened.text)) {
          return textResult(
            `error: browser open failed (via=${opened.via}): ${opened.text.slice(0, 800) || opened.error}`,
          );
        }
        await run(["wait", "800"], 15_000);
        const snap = await run(["snapshot", "-i"], 60_000);
        const evidenceId = await emitEvidence(runtime, "browser", `browser open ${url}`, {
          url,
          open_url: openUrl,
          via: opened.via,
          snapshot: snap.text.slice(0, 12_000),
          cli: opened.text.slice(0, 2000),
        });
        return jsonResult({
          ok: true,
          action: "open",
          url,
          open_url: openUrl,
          via: opened.via,
          snapshot: snap.text.slice(0, 12_000),
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
          via: r.via,
          snapshot: r.text.slice(0, 16_000),
        });
        return jsonResult({
          ok: r.exitCode === 0 || r.text.length > 0,
          action: "snapshot",
          via: r.via,
          snapshot: r.text.slice(0, 16_000),
          evidence_id: evidenceId,
        });
      }

      if (action === "click") {
        if (!params.selector) return textResult("error: selector required (@eN or CSS)");
        const r = await run(["click", String(params.selector)], 60_000);
        if (r.unavailable) return textResult(`error: ${r.error}`);
        const snap = await run(["snapshot", "-i"], 45_000);
        return jsonResult({
          ok: r.exitCode === 0 || /click|✓|Done/i.test(r.text),
          action: "click",
          via: r.via,
          selector: params.selector,
          cli: r.text.slice(0, 1500),
          snapshot: snap.text.slice(0, 10_000),
        });
      }

      if (action === "fill" || action === "type") {
        if (!params.selector) return textResult("error: selector required");
        const cmd = action === "fill" ? "fill" : "type";
        const r = await run([cmd, String(params.selector), String(params.text ?? "")], 60_000);
        if (r.unavailable) return textResult(`error: ${r.error}`);
        return jsonResult({
          ok: r.exitCode === 0 || /fill|type|✓|Done/i.test(r.text),
          action,
          via: r.via,
          selector: params.selector,
          cli: r.text.slice(0, 1500),
        });
      }

      if (action === "press") {
        const key = String(params.key || "Enter");
        const r = await run(["press", key], 30_000);
        if (r.unavailable) return textResult(`error: ${r.error}`);
        return jsonResult({
          ok: r.exitCode === 0 || /press|✓|Done/i.test(r.text),
          action: "press",
          via: r.via,
          key,
          cli: r.text.slice(0, 1000),
        });
      }

      if (action === "read") {
        const args = params.url ? ["read", String(params.url)] : ["read"];
        if (params.url) {
          try {
            const u = resolveTargetUrl(runtime, String(params.url));
            if (!isInScope(runtime, u)) return textResult(`error: out of scope: ${u}`);
            args[1] = rewriteUrlForSandbox(u);
          } catch (e) {
            return textResult(`error: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        const r = await run(args, 60_000);
        if (r.unavailable) return textResult(`error: ${r.error}`);
        const evidenceId = await emitEvidence(runtime, "browser", "browser read", {
          via: r.via,
          text: r.text.slice(0, 12_000),
        });
        return jsonResult({
          ok: true,
          action: "read",
          via: r.via,
          text: r.text.slice(0, 12_000),
          evidence_id: evidenceId,
        });
      }

      if (action === "screenshot") {
        // Screenshots inside container: write under /tmp then docker cp is complex;
        // use agent-browser default path and return CLI text; prefer snapshot when sandbox.
        const pathHint =
          params.path != null
            ? String(params.path)
            : join(runtime.taskDir, "browser", `shot_${Date.now()}.png`);
        const args = ["screenshot"];
        if (params.selector) args.push(String(params.selector));
        // In sandbox, path is inside container; keep basename under /tmp
        const containerPath = `/tmp/n4-shot-${Date.now()}.png`;
        args.push(containerPath);
        if (params.full_page) args.push("--full");
        const r = await run(args, 60_000);
        if (r.unavailable) return textResult(`error: ${r.error}`);
        const evidenceId = await emitEvidence(runtime, "browser", `browser screenshot`, {
          via: r.via,
          path_hint: pathHint,
          container_path: containerPath,
          cli: r.text.slice(0, 1500),
        });
        return jsonResult({
          ok: r.exitCode === 0 || /saved|screenshot|png|jpeg/i.test(r.text),
          action: "screenshot",
          via: r.via,
          path_hint: pathHint,
          container_path: r.via === "sandbox" ? containerPath : pathHint,
          cli: r.text.slice(0, 1500),
          evidence_id: evidenceId,
          guidance:
            "For captcha, prefer captcha(fetch,url=image) with session actor, or browser snapshot + interact. OCR via captcha(ocr) if tesseract on host.",
        });
      }

      if (action === "cookies") {
        const r = await run(["cookies", "get", "--json"], 30_000);
        if (r.unavailable) return textResult(`error: ${r.error}`);
        const jar = parseCookiesJson(r.stdout || r.text);
        return jsonResult({
          ok: true,
          action: "cookies",
          via: r.via,
          cookies: jar,
          raw: r.text.slice(0, 4000),
        });
      }

      if (action === "export_cookies") {
        const actor = sanitizeActor(params.actor != null ? String(params.actor) : "browser");
        const r = await run(["cookies", "get", "--json"], 30_000);
        if (r.unavailable) return textResult(`error: ${r.error}`);
        const jar = parseCookiesJson(r.stdout || r.text);
        const dir = join(runtime.taskDir, "session", "actors", actor);
        await mkdir(dir, { recursive: true });
        const jarPath = join(dir, "cookies.json");
        let existing: Record<string, string> = {};
        try {
          existing = JSON.parse(await readFile(jarPath, "utf8")) as Record<string, string>;
        } catch {
          existing = {};
        }
        const merged = { ...existing, ...jar };
        await writeFile(jarPath, JSON.stringify(merged, null, 2), "utf8");
        if (actor === "default") {
          await mkdir(join(runtime.taskDir, "session"), { recursive: true });
          await writeFile(
            join(runtime.taskDir, "session", "cookies.json"),
            JSON.stringify(merged, null, 2),
            "utf8",
          );
        }
        const evidenceId = await emitEvidence(runtime, "browser", `export cookies → session actor=${actor}`, {
          actor,
          via: r.via,
          cookies: merged,
        });
        return jsonResult({
          ok: true,
          action: "export_cookies",
          via: r.via,
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
