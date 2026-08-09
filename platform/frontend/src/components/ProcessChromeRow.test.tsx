/**
 * Thin smoke: ProcessChromeRow + status light dialect (Pending/Tool shell).
 * Run: npx tsx src/components/ProcessChromeRow.test.tsx  (from platform/frontend)
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProcessChromeRow, ProcessStatusLight } from "./ProcessChromeRow.tsx";

{
  const html = renderToStaticMarkup(
    createElement(ProcessChromeRow, {
      testId: "agent-pending-card",
      titleTestId: "agent-pending-title",
      leading: createElement(ProcessStatusLight, {
        status: "running",
        pulse: true,
        testId: "pending-status-light",
      }),
      title: "思考中…",
    }),
  );
  assert.ok(html.includes('data-testid="agent-pending-card"'));
  assert.ok(html.includes('data-testid="pending-status-light"'));
  assert.ok(html.includes('data-pulse="true"'));
  assert.ok(html.includes("animate-pulse"));
  assert.ok(html.includes("思考中"));
  assert.ok(!html.includes("tool-card-toggle"), "pending is not expandable");
  console.log("ok: pending shell = light + title");
}

{
  const html = renderToStaticMarkup(
    createElement(ProcessChromeRow, {
      testId: "tool-card",
      leading: createElement(ProcessStatusLight, {
        status: "running",
        pulse: true,
        testId: "tool-status-light",
      }),
      title: "Platform Create Report",
      summary: "执行中",
      expanded: false,
      onToggle: () => {},
    }),
  );
  assert.ok(html.includes('data-testid="tool-card"'));
  assert.ok(html.includes('data-testid="tool-card-toggle"'));
  assert.ok(html.includes("Platform Create Report"));
  assert.ok(html.includes("执行中"));
  assert.ok(html.includes('data-status="running"'));
  assert.ok(html.includes("animate-pulse"));
  console.log("ok: tool shell = light + name + summary");
}

{
  const html = renderToStaticMarkup(
    createElement(ProcessStatusLight, {
      status: "done",
      pulse: false,
      testId: "tool-status-light",
    }),
  );
  assert.ok(html.includes('data-status="done"'));
  assert.ok(html.includes('data-pulse="false"'));
  assert.ok(!html.includes("animate-pulse"));
  assert.ok(html.includes("bg-status-success"));
  console.log("ok: done light solid green, no pulse");
}

console.log("ProcessChromeRow.test.tsx: all ok");
