import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { observeAttackSurface } from "../runtime/coverage-auditor.js";
import { emitToolEvidence, jsonResult, textResult } from "./common.js";

type BrowserState = {
  page?: any;
  browser?: any;
  wired?: boolean;
};

const state: BrowserState = {};

export function createBrowserTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "browser",
    label: "Browser",
    description: "Drive a real browser when Playwright is installed. Actions: goto, click, fill, press, content, screenshot, snapshot, close. Use it for login, session capture, and front-end-only flows.",
    promptSnippet: "Drive browser for login/session/front-end flows",
    promptGuidelines: [
      "Use browser for authentication and JavaScript-heavy flows before replaying requests with http.",
      "After login, use browser(action='snapshot') so traffic/http can reuse cookies and storage state.",
    ],
    parameters: Type.Object({
      action: Type.String(),
      url: Type.Optional(Type.String()),
      selector: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      key: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId: string, params: any) {
      const pw = await loadPlaywright();
      if (!pw) return textResult("error: Playwright is not installed. Run `npm install` in node2 and `npx playwright install chromium`.");
      if (!state.browser) {
        state.browser = await pw.chromium.launch({
          headless: true,
          proxy: runtime.trafficProxyUrl ? { server: runtime.trafficProxyUrl } : undefined,
        });
        state.page = await state.browser.newPage();
        wireTrafficCapture(runtime, state.page);
      }
      const page = state.page;
      if (params.action === "goto") {
        if (!params.url) return textResult("error: url is required");
        await page.goto(params.url, { waitUntil: "domcontentloaded" });
        await observePage(runtime, page, "browser");
        return jsonResult(await pageSummary(page));
      }
      if (params.action === "click") {
        if (!params.selector) return textResult("error: selector is required");
        await page.click(params.selector);
        await observePage(runtime, page, "browser");
        return jsonResult(await pageSummary(page));
      }
      if (params.action === "fill") {
        if (!params.selector) return textResult("error: selector is required");
        await page.fill(params.selector, params.text || "");
        await observePage(runtime, page, "browser");
        return jsonResult(await pageSummary(page));
      }
      if (params.action === "press") {
        await page.keyboard.press(params.key || "Enter");
        await observePage(runtime, page, "browser");
        return jsonResult(await pageSummary(page));
      }
      if (params.action === "content") {
        const html = String(await page.content()).slice(0, 128 * 1024);
        const evidenceId = await emitToolEvidence(runtime, "browser", `browser content ${page.url()}`, { url: page.url(), html });
        await observeAttackSurface(runtime, { method: "GET", url: page.url(), responseBody: html, evidenceIds: [evidenceId], source: "browser" });
        return jsonResult({ evidence_id: evidenceId, url: page.url(), html }, { evidenceId });
      }
      if (params.action === "snapshot") {
        const snapshot = { url: page.url(), cookies: await page.context().cookies(), storageState: await page.context().storageState() };
        runtime.traffic.setSnapshot(snapshot);
        return jsonResult(snapshot);
      }
      if (params.action === "screenshot") {
        const bytes = await page.screenshot({ type: "png" });
        const evidenceId = await emitToolEvidence(runtime, "browser", `browser screenshot ${page.url()}`, { url: page.url(), screenshot_base64: Buffer.from(bytes).toString("base64") });
        return jsonResult({ evidence_id: evidenceId, url: page.url() }, { evidenceId });
      }
      if (params.action === "close") {
        await state.browser?.close();
        state.browser = undefined;
        state.page = undefined;
        return textResult("closed");
      }
      return textResult("error: action must be goto, click, fill, press, content, screenshot, snapshot, or close");
    },
  };
}

async function loadPlaywright(): Promise<any | undefined> {
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
    return await dynamicImport("playwright");
  } catch {
    return undefined;
  }
}

async function pageSummary(page: any): Promise<Record<string, unknown>> {
  return { url: page.url(), title: await page.title() };
}

async function observePage(runtime: ToolRuntime, page: any, source: string): Promise<void> {
  try {
    const html = String(await page.content()).slice(0, 128 * 1024);
    await observeAttackSurface(runtime, { method: "GET", url: page.url(), responseBody: html, source });
  } catch {
    // Observation should never break the browser action itself.
  }
}

function wireTrafficCapture(runtime: ToolRuntime, page: any): void {
  if (state.wired) return;
  state.wired = true;
  const pending = new Map<any, { method: string; url: string; requestHeaders: Record<string, string>; requestBody?: string; startedAt: string }>();
  page.on("request", async (request: any) => {
    try {
      pending.set(request, {
        method: String(request.method() || "GET").toUpperCase(),
        url: String(request.url()),
        requestHeaders: lowerHeaders(await request.allHeaders().catch(() => request.headers())),
        requestBody: request.postData() || undefined,
        startedAt: new Date().toISOString(),
      });
    } catch {
      // Browser capture is best-effort and should not break user actions.
    }
  });
  page.on("response", async (response: any) => {
    try {
      const request = response.request();
      const started = pending.get(request) || {
        method: String(request.method() || "GET").toUpperCase(),
        url: String(response.url()),
        requestHeaders: lowerHeaders(request.headers()),
        requestBody: request.postData() || undefined,
        startedAt: new Date().toISOString(),
      };
      pending.delete(request);
      if (!/^https?:\/\//i.test(started.url)) return;
      const responseHeaders = lowerHeaders(await response.allHeaders().catch(() => response.headers()));
      const contentType = responseHeaders["content-type"] || "";
      const responseBody = shouldCaptureBody(contentType) ? String(await response.text().catch(() => "")).slice(0, 128 * 1024) : undefined;
      const trafficId = runtime.traffic.add({
        source: "browser",
        method: started.method,
        url: started.url,
        status: response.status(),
        requestHeaders: started.requestHeaders,
        requestBody: started.requestBody,
        responseHeaders,
        responseBody,
        receivedAt: started.startedAt,
      });
      await observeAttackSurface(runtime, {
        method: started.method,
        url: started.url,
        requestBody: started.requestBody,
        responseBody,
        source: "browser.traffic",
      });
      await runtime.platform.send({
        type: "traffic_captured",
        conversation_id: runtime.task.conversationId,
        task_id: runtime.task.taskId,
        traffic_id: trafficId,
        method: started.method,
        url: started.url,
        status: response.status(),
        source: "browser",
      });
    } catch {
      // Browser capture is best-effort and should not break user actions.
    }
  });
}

function lowerHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers || {})) out[key.toLowerCase()] = String(value);
  return out;
}

function shouldCaptureBody(contentType: string): boolean {
  return !contentType || /text\/|json|xml|javascript|html|form/i.test(contentType);
}
