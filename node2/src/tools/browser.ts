/**
 * Browser tool — Node3-aligned: drive Chromium via agent-browser inside
 * the long-lived strix-sandbox container (not host Playwright).
 */
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import {
  agentBrowser,
  ensureBrowserSandbox,
  execInBrowserSandbox,
  isBrowserSandboxEnabled,
  parseAgentBrowserJson,
  preferredTargetOrigin,
  rewriteUrlForSandbox,
  rewriteUrlFromSandbox,
  rewriteCookieDomainFromSandbox,
  stopBrowserSandbox,
} from "../runtime/browser-sandbox.js";
import { observeAttackSurface } from "../runtime/coverage-auditor.js";
import { emitToolEvidence, isInScope, jsonResult, textResult } from "./common.js";

export function createBrowserTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "browser",
    label: "Browser",
    description:
      "Drive a real browser in the strix-sandbox (agent-browser + Chromium). Actions: goto, click, fill, press, content, screenshot, snapshot, close. Use for login, session capture, and JavaScript-heavy flows. Selectors may be CSS or agent-browser refs like @e3 from snapshot output returned by content/snapshot.",
    promptSnippet: "Sandbox browser (agent-browser) for login/session/front-end flows",
    promptGuidelines: [
      "Browser runs inside ghcr.io/usestrix/strix-sandbox via agent-browser — host Playwright is not required.",
      "Use browser for authentication and JavaScript-heavy flows before replaying requests with http.",
      "After login, use browser(action='snapshot') so traffic/http can reuse cookies and storage state.",
      "Prefer snapshot/content to discover interactive refs (@eN) before click/fill when CSS selectors are unknown.",
    ],
    parameters: Type.Object({
      action: Type.String(),
      url: Type.Optional(Type.String()),
      selector: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      key: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId: string, params: any) {
      if (!isBrowserSandboxEnabled(runtime)) {
        return textResult(
          "error: Browser sandbox is disabled. Enable NODE2_SCANNER_SANDBOX_AUTO (default true) so browser can use strix-sandbox agent-browser.",
        );
      }

      const action = String(params.action || "").toLowerCase();
      if (action === "close") {
        await stopBrowserSandbox(runtime.task.taskId);
        return textResult("closed");
      }

      try {
        await ensureBrowserSandbox(runtime);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult(
          `error: failed to start browser sandbox (strix-sandbox agent-browser): ${message.slice(0, 500)}. Ensure Docker is available and the scanner sandbox image is pullable.`,
        );
      }

      if (action === "goto") {
        if (!params.url) return textResult("error: url is required");
        if (!isInScope(runtime, params.url)) return textResult(`error: out of scope: ${params.url}`);
        const sandboxUrl = rewriteUrlForSandbox(params.url);
        const opened = await agentBrowser(runtime, ["open", sandboxUrl], 120_000);
        if (opened.unavailable || (opened.exitCode !== 0 && !/https?:\/\//i.test(opened.text))) {
          return textResult(`error: browser open failed: ${opened.error || opened.text || `exit ${opened.exitCode}`}`);
        }
        // Best-effort wait for SPA paint.
        await agentBrowser(runtime, ["wait", "1000"], 30_000);
        const summary = await pageSummary(runtime);
        await observePage(runtime, summary);
        return jsonResult({
          runner: "strix-sandbox",
          tool: "agent-browser",
          action: "goto",
          requested_url: params.url,
          sandbox_url: sandboxUrl,
          ...summary,
          cli: opened.text.slice(0, 2000),
        });
      }

      if (action === "click") {
        if (!params.selector) return textResult("error: selector is required");
        const result = await agentBrowser(runtime, ["click", String(params.selector)], 60_000);
        if (result.exitCode !== 0 && !/✓|Done|clicked/i.test(result.text)) {
          return textResult(`error: browser click failed: ${result.text || `exit ${result.exitCode}`}`);
        }
        const summary = await pageSummary(runtime);
        await observePage(runtime, summary);
        return jsonResult({ runner: "strix-sandbox", action: "click", selector: params.selector, ...summary, cli: result.text.slice(0, 1000) });
      }

      if (action === "fill") {
        if (!params.selector) return textResult("error: selector is required");
        const result = await agentBrowser(runtime, ["fill", String(params.selector), String(params.text || "")], 60_000);
        if (result.exitCode !== 0 && !/✓|Done|filled/i.test(result.text)) {
          return textResult(`error: browser fill failed: ${result.text || `exit ${result.exitCode}`}`);
        }
        const summary = await pageSummary(runtime);
        await observePage(runtime, summary);
        return jsonResult({ runner: "strix-sandbox", action: "fill", selector: params.selector, ...summary, cli: result.text.slice(0, 1000) });
      }

      if (action === "press") {
        const key = String(params.key || "Enter");
        const result = await agentBrowser(runtime, ["press", key], 30_000);
        if (result.exitCode !== 0 && !/✓|Done/i.test(result.text)) {
          return textResult(`error: browser press failed: ${result.text || `exit ${result.exitCode}`}`);
        }
        const summary = await pageSummary(runtime);
        await observePage(runtime, summary);
        return jsonResult({ runner: "strix-sandbox", action: "press", key, ...summary, cli: result.text.slice(0, 1000) });
      }

      if (action === "content") {
        const summary = await pageSummary(runtime);
        const htmlResult = await agentBrowser(
          runtime,
          ["eval", "document.documentElement ? document.documentElement.outerHTML : document.body.outerHTML"],
          60_000,
        );
        let html = stripEvalQuotes(htmlResult.text).slice(0, 128 * 1024);
        if (!html || html.length < 20) {
          const snap = await agentBrowser(runtime, ["snapshot", "-i"], 60_000);
          html = snap.text.slice(0, 128 * 1024);
        }
        const evidenceId = await emitToolEvidence(runtime, "browser", `browser content ${summary.url}`, {
          url: summary.url,
          html,
          runner: "strix-sandbox",
        });
        await observeAttackSurface(runtime, {
          method: "GET",
          url: String(summary.url || ""),
          responseBody: html,
          evidenceIds: [evidenceId],
          source: "browser",
        });
        // Also return interactive snapshot refs for agent click/fill.
        const interactive = await agentBrowser(runtime, ["snapshot", "-i"], 60_000);
        return jsonResult(
          {
            evidence_id: evidenceId,
            runner: "strix-sandbox",
            ...summary,
            html,
            interactive_snapshot: interactive.text.slice(0, 32 * 1024),
          },
          { evidenceId },
        );
      }

      if (action === "snapshot") {
        const summary = await pageSummary(runtime);
        const cookies = await collectCookies(runtime);
        const statePath = "/tmp/node2-browser-state.json";
        await agentBrowser(runtime, ["state", "save", statePath], 30_000);
        const stateFile = await readSandboxFile(runtime, statePath);
        let storageState: unknown = undefined;
        if (stateFile) {
          try {
            storageState = JSON.parse(stateFile);
          } catch {
            storageState = undefined;
          }
        }
        const interactive = await agentBrowser(runtime, ["snapshot", "-i"], 60_000);
        const cookieHeader = cookies
          .map((cookie) => `${cookie.name}=${cookie.value}`)
          .filter((part) => !part.startsWith("="))
          .join("; ");
        const snapshot = {
          url: summary.url,
          title: summary.title,
          cookie: cookieHeader,
          cookies: cookieHeader,
          cookieList: cookies,
          storageState: storageState || { cookies, origins: [] },
          interactive_snapshot: interactive.text.slice(0, 32 * 1024),
          runner: "strix-sandbox",
          source: "agent-browser",
        };
        runtime.traffic.setSnapshot(snapshot);
        // Record a lightweight traffic row for the current page.
        if (summary.url) {
          runtime.traffic.add({
            source: "browser",
            method: "GET",
            url: String(summary.url),
            status: 200,
            requestHeaders: {},
            responseHeaders: {},
            responseBody: interactive.text.slice(0, 16 * 1024),
          });
        }
        return jsonResult(snapshot);
      }

      if (action === "screenshot") {
        const summary = await pageSummary(runtime);
        const path = `/tmp/node2-shot-${Date.now()}.png`;
        const shot = await agentBrowser(runtime, ["screenshot", path], 60_000);
        if (shot.exitCode !== 0 && !/Screenshot saved|✓/i.test(shot.text)) {
          return textResult(`error: browser screenshot failed: ${shot.text || `exit ${shot.exitCode}`}`);
        }
        const b64 = await readSandboxFileBase64(runtime, path);
        const evidenceId = await emitToolEvidence(runtime, "browser", `browser screenshot ${summary.url}`, {
          url: summary.url,
          screenshot_base64: b64?.slice(0, 2 * 1024 * 1024),
          runner: "strix-sandbox",
        });
        return jsonResult({ evidence_id: evidenceId, url: summary.url, runner: "strix-sandbox" }, { evidenceId });
      }

      return textResult("error: action must be goto, click, fill, press, content, screenshot, snapshot, or close");
    },
  };
}

async function pageSummary(runtime: ToolRuntime): Promise<Record<string, unknown>> {
  const preferred = preferredTargetOrigin(runtime);
  const [urlRes, titleRes] = await Promise.all([
    agentBrowser(runtime, ["get", "url"], 30_000),
    agentBrowser(runtime, ["get", "title"], 30_000),
  ]);
  const rawUrl = firstNonEmptyLine(urlRes.text);
  const title = firstNonEmptyLine(titleRes.text);
  return {
    url: rewriteUrlFromSandbox(rawUrl, preferred),
    title,
    sandbox_url: rawUrl,
  };
}

async function collectCookies(runtime: ToolRuntime): Promise<Array<Record<string, unknown>>> {
  const preferred = preferredTargetOrigin(runtime);
  const res = await agentBrowser(runtime, ["cookies", "--json"], 30_000);
  const parsed = parseAgentBrowserJson(res.stdout || res.text) as any;
  const list: any[] =
    parsed?.data?.cookies ||
    parsed?.cookies ||
    (Array.isArray(parsed) ? parsed : []);
  if (!Array.isArray(list)) return [];
  return list.map((cookie) => {
    const domain = rewriteCookieDomainFromSandbox(String(cookie.domain || ""), preferred);
    return {
      ...cookie,
      domain,
      // Playwright-style fields for downstream consumers.
      name: cookie.name,
      value: cookie.value,
      path: cookie.path || "/",
      httpOnly: Boolean(cookie.httpOnly),
      secure: Boolean(cookie.secure),
    };
  });
}

async function observePage(runtime: ToolRuntime, summary: Record<string, unknown>): Promise<void> {
  try {
    const url = String(summary.url || "");
    if (!url) return;
    const interactive = await agentBrowser(runtime, ["snapshot", "-i"], 60_000);
    await observeAttackSurface(runtime, {
      method: "GET",
      url,
      responseBody: interactive.text.slice(0, 64 * 1024),
      source: "browser",
    });
  } catch {
    // Observation should never break the browser action itself.
  }
}

async function readSandboxFile(runtime: ToolRuntime, path: string): Promise<string | undefined> {
  const result = await execInBrowserSandbox(runtime, ["cat", path], 30_000);
  if (result.exitCode !== 0) return undefined;
  return result.stdout;
}

async function readSandboxFileBase64(runtime: ToolRuntime, path: string): Promise<string | undefined> {
  const result = await execInBrowserSandbox(runtime, ["base64", path], 60_000);
  if (result.exitCode !== 0) return undefined;
  return result.stdout.replace(/\s+/g, "");
}

function firstNonEmptyLine(text: string): string {
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip CLI chrome markers.
    if (trimmed.startsWith("✓") || trimmed.startsWith("error:") || trimmed.startsWith("Usage:")) continue;
    return trimmed.replace(/^"|"$/g, "");
  }
  return "";
}

function stripEvalQuotes(text: string): string {
  const line = firstNonEmptyLine(text) || text.trim();
  if ((line.startsWith('"') && line.endsWith('"')) || (line.startsWith("'") && line.endsWith("'"))) {
    try {
      return JSON.parse(line);
    } catch {
      return line.slice(1, -1);
    }
  }
  // Multi-line HTML may be JSON-encoded string across full stdout.
  try {
    const parsed = JSON.parse(text.trim());
    if (typeof parsed === "string") return parsed;
  } catch {
    // fall through
  }
  return text.trim();
}
