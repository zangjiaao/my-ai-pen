/**
 * Spec #327 / #328 — shared dialog Markdown renderer (primary seam).
 * Black-box: input string + props → observable HTML structure / safety.
 * Run: npx tsx src/components/MarkdownText.test.tsx  (from platform/frontend)
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import MarkdownText, { sanitizeHref } from "./MarkdownText.tsx";

function render(text: string, props: { breaks?: boolean; className?: string } = {}): string {
  return renderToStaticMarkup(createElement(MarkdownText, { text, ...props }));
}

// --- H4+ headings (incl. CJK / emoji) ---
{
  const html = render("#### 🔴🟡 越权漏洞（4项）");
  assert.match(html, /<h4[\s>]/, "H4 should render as heading element");
  assert.ok(html.includes("🔴🟡 越权漏洞（4项）"), "CJK/emoji heading text preserved");
  assert.ok(!html.includes("####"), "heading markers must not remain raw");

  const h6 = render("###### deep");
  assert.match(h6, /<h6[\s>]/);
  console.log("ok: H4–H6 headings including CJK/emoji");
}

// --- Thematic break ---
{
  const html = render("above\n\n---\n\nbelow");
  assert.match(html, /<hr[\s/>]/, "thematic break should be an hr");
  assert.ok(!html.includes("---"), "raw --- should not remain as paragraph text");
  console.log("ok: thematic breaks as hr");
}

// --- Emphasis / inline code / links ---
{
  const html = render("Critical **JWT leak** and `token` see [docs](https://example.com/a).");
  assert.match(html, /<strong[^>]*>JWT leak<\/strong>/);
  assert.match(html, /<code[^>]*>token<\/code>/);
  assert.match(html, /href="https:\/\/example\.com\/a"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noreferrer"/);
  console.log("ok: emphasis, inline code, safe links");
}

// --- GFM table ---
{
  const md = `| A | B |
| --- | --- |
| 1 | 2 |`;
  const html = render(md);
  assert.match(html, /<table[\s>]/);
  assert.match(html, /<th[\s>]/);
  assert.ok(html.includes(">A<") || html.includes(">A</"), "table header cell");
  assert.ok(!html.includes("| A | B |"), "pipe table source should not stay raw");
  console.log("ok: GFM tables");
}

// --- Strikethrough / task list (GFM) ---
{
  const html = render("~~old~~\n\n- [x] done\n- [ ] todo");
  assert.match(html, /<del[\s>]/);
  assert.match(html, /type="checkbox"/);
  console.log("ok: strikethrough and task lists");
}

// --- breaks=false (default): single newlines collapse per GFM paragraph rules ---
{
  const html = render("line one\nline two");
  // Default GFM: soft line break becomes space inside one paragraph (no <br>)
  assert.ok(!html.includes("<br"), "default breaks=false should not force hard breaks");
  assert.ok(html.includes("line one") && html.includes("line two"));
  console.log("ok: breaks=false default GFM paragraphs");
}

// --- breaks=true: single newlines become hard breaks ---
{
  const html = render("line one\nline two", { breaks: true });
  assert.match(html, /<br[\s/>]/, "breaks=true should emit hard line breaks");
  console.log("ok: breaks=true soft newlines");
}

// --- Raw HTML must not become live structure / script ---
{
  const html = render('<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\n**ok**');
  assert.ok(!html.includes("<script"), "script tags must not inject");
  // react-markdown without rehype-raw treats HTML as text or strips structure
  assert.ok(!/<img\b/i.test(html), "raw HTML img must not become img element");
  assert.match(html, /<strong[^>]*>ok<\/strong>/);
  console.log("ok: no raw HTML injection");
}

// --- Unsafe link schemes inert ---
{
  const js = render("[x](javascript:alert(1))");
  assert.ok(!/href\s*=\s*["']javascript:/i.test(js), "javascript: must not be href");
  assert.ok(!js.includes("javascript:alert"), "javascript URL must not be executable anchor");

  const data = render("[x](data:text/html,hi)");
  assert.ok(!/href\s*=\s*["']data:/i.test(data), "data: must not be href");
  console.log("ok: unsafe URL schemes inert");
}

// --- Image Markdown: no remote-loading <img> ---
{
  const html = render("![alt text](https://evil.example/track.png)");
  assert.ok(!/<img\b/i.test(html), "image syntax must not produce img tags");
  assert.ok(html.includes("alt text") || html.includes("track.png"), "image intent still understandable");
  console.log("ok: images non-fetching presentation");
}

// --- Code fences monospaced, no highlighter dep ---
{
  const html = render("```json\n{\"a\":1}\n```");
  assert.match(html, /<pre[\s>]/);
  assert.match(html, /<code[\s>]/);
  assert.ok(html.includes("{") || html.includes("&quot;") || html.includes("&#x27;") || html.includes("a"), "code body present");
  // language label optional/presentational
  console.log("ok: fenced code monospaced blocks");
}

// --- Nested inline in headings / lists ---
{
  const html = render("### Title with **bold** and `code`\n\n- item with [link](https://example.com)");
  assert.match(html, /<h3[\s>]/);
  assert.match(html, /<strong[^>]*>bold<\/strong>/);
  assert.match(html, /<code[^>]*>code<\/code>/);
  assert.match(html, /href="https:\/\/example\.com"/);
  console.log("ok: nested inline markup");
}

// --- Blockquotes ---
{
  const html = render("> quoted evidence");
  assert.match(html, /<blockquote[\s>]/);
  assert.ok(html.includes("quoted evidence"));
  console.log("ok: blockquotes");
}

// --- sanitizeHref unit (exported pure helper) ---
{
  assert.equal(sanitizeHref("https://a.com"), "https://a.com");
  assert.equal(sanitizeHref("http://a.com"), "http://a.com");
  assert.equal(sanitizeHref("/relative"), "/relative");
  assert.equal(sanitizeHref("#anchor"), "#anchor");
  assert.equal(sanitizeHref("javascript:alert(1)"), undefined);
  assert.equal(sanitizeHref("data:text/html,x"), undefined);
  assert.equal(sanitizeHref("vbscript:msg"), undefined);
  console.log("ok: sanitizeHref policy");
}

// --- className passthrough ---
{
  const html = render("hi", { className: "thinking-dense text-xs" });
  assert.ok(html.includes("thinking-dense") && html.includes("text-xs"));
  console.log("ok: className passthrough");
}

console.log("MarkdownText.test.tsx: all ok");
