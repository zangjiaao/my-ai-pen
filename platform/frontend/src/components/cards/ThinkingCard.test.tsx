/**
 * Spec #327 / #329 — thin smoke: thinking body uses shared Markdown renderer + soft-break.
 * Full GFM matrix lives on MarkdownText.test.tsx; this only locks wiring.
 * Run: npx tsx src/components/cards/ThinkingCard.test.tsx  (from platform/frontend)
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ThinkingCard from "./ThinkingCard.tsx";

function renderThinking(content: Record<string, unknown>): string {
  return renderToStaticMarkup(createElement(ThinkingCard, { content }));
}

// Expanded done thinking: bold / H4 / thematic break render (not raw source)
{
  const body = [
    "Critical finding confirmed! **JWT Password Hash Leakage**",
    "",
    "#### 🔴 检查点",
    "",
    "---",
    "",
    "step one",
    "step two",
  ].join("\n");

  const html = renderThinking({ status: "done", reasoning: body });

  assert.ok(html.includes('data-testid="thinking-card-body"'), "body container present when expanded");
  assert.match(html, /<strong[^>]*>JWT Password Hash Leakage<\/strong>/, "emphasis rendered");
  assert.match(html, /<h4[\s>]/, "H4 heading rendered");
  assert.ok(html.includes("🔴 检查点") || html.includes("检查点"), "heading text visible");
  assert.ok(!html.includes("####"), "#### markers must not remain raw in body");
  assert.match(html, /<hr[\s/>]/, "thematic break rendered");
  // soft-break: single newline between short lines should produce <br>
  assert.match(html, /<br[\s/>]/, "thinking enables soft-break for single newlines");
  // density: muted/small classes applied on markdown root
  assert.ok(html.includes("text-xs") && html.includes("text-ink-muted"), "thinking density classes");
  console.log("ok: thinking body shared GFM + soft-break wiring");
}

// Empty running thinking: no body (Spec #305 lifecycle preserved)
{
  const html = renderThinking({ status: "running", text: "" });
  assert.ok(!html.includes('data-testid="thinking-card-body"'), "empty running: no body chrome");
  assert.ok(html.includes("思考中"), "running title preserved");
  console.log("ok: empty running thinking shell unchanged");
}

// Lifecycle title for done with body
{
  const html = renderThinking({ status: "done", text: "done thought" });
  assert.ok(html.includes("思考完成"), "done title");
  assert.ok(html.includes("done thought"), "body text present");
  console.log("ok: done thinking title + body");
}

console.log("ThinkingCard.test.tsx: all ok");
