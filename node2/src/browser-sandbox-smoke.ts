/**
 * Smoke: browser tool uses long-lived strix-sandbox + agent-browser (not host Playwright).
 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { CoverageStore } from "./stores/coverage.js";
import { EvidenceStore } from "./stores/evidence.js";
import { PlanStore } from "./stores/plan.js";
import { TrafficStore } from "./stores/traffic.js";
import { createBrowserTool } from "./tools/browser.js";
import { stopBrowserSandbox } from "./runtime/browser-sandbox.js";
import type { PlatformMessage, PlatformSink, ToolRuntime } from "./types.js";

class MemorySink implements PlatformSink {
  readonly events: PlatformMessage[] = [];
  async send(message: PlatformMessage): Promise<void> {
    this.events.push(message);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function execJson(tool: any, id: string, params: any): Promise<any> {
  const result = await tool.execute(id, params);
  const text = (result?.content || []).filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n");
  // Error strings are plain text.
  if (text.startsWith("error:")) throw new Error(text);
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

const target = process.env.NODE2_BROWSER_SMOKE_TARGET || "http://127.0.0.1:3000";
const image = process.env.NODE2_SCANNER_SANDBOX_IMAGE || process.env.STRIX_IMAGE || "ghcr.io/usestrix/strix-sandbox:1.0.0";

async function main(): Promise<void> {
  const workspaceDir = resolve("tmp", "node2-browser-sandbox-smoke");
  const taskId = `browser-sandbox-smoke-${Date.now()}`;
  const taskDir = resolve(workspaceDir, taskId);
  await mkdir(resolve(taskDir, "evidence"), { recursive: true });

  const runtime: ToolRuntime = {
    task: {
      taskId,
      conversationId: taskId,
      instruction: "browser sandbox smoke",
      target: { type: "url", value: target },
      scope: { allow: [target] },
      snapshot: {},
    },
    workspaceDir,
    platform: new MemorySink(),
    plan: new PlanStore(),
    coverage: new CoverageStore(),
    evidence: new EvidenceStore(resolve(taskDir, "evidence")),
    traffic: new TrafficStore(),
    pocCatalogPath: "",
    workflowRuns: [],
    lifecycle: {},
    scannerSandbox: { enabled: true, image },
  };
  runtime.plan.start();

  const browser = createBrowserTool(runtime);
  try {
    const opened = await execJson(browser, "goto", { action: "goto", url: target });
    assert(opened.runner === "strix-sandbox", `expected sandbox runner: ${JSON.stringify(opened).slice(0, 400)}`);
    assert(String(opened.url || "").includes("3000") || String(opened.sandbox_url || "").includes("3000"), `url missing: ${JSON.stringify(opened)}`);
    console.log("goto ok", opened.url || opened.sandbox_url, opened.title);

    const content = await execJson(browser, "content", { action: "content" });
    assert(content.evidence_id, "content should emit evidence");
    assert(String(content.html || content.interactive_snapshot || "").length > 20, "content should return html or snapshot");
    console.log("content ok", String(content.html || "").slice(0, 80).replace(/\s+/g, " "));

    const snap = await execJson(browser, "snapshot", { action: "snapshot" });
    assert(snap.runner === "strix-sandbox", "snapshot runner");
    runtime.traffic.setSnapshot(snap);
    const stored = runtime.traffic.snapshot();
    assert(stored && (stored.cookie || stored.cookies), `snapshot cookies missing: ${JSON.stringify(stored).slice(0, 300)}`);
    console.log("snapshot ok", { cookie: stored?.cookie || stored?.cookies, url: snap.url });

    const closed = await execJson(browser, "close", { action: "close" });
    const closeText = String(closed.raw || closed || "closed");
    assert(/closed/i.test(closeText), `close failed: ${closeText}`);
    console.log("close ok");

    console.log(JSON.stringify({ ok: true, target, image, title: opened.title, url: opened.url }, null, 2));
  } finally {
    await stopBrowserSandbox(taskId).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
