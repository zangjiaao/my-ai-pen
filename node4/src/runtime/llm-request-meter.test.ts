/**
 * LLM outbound request meter.
 * Run: npx tsx src/runtime/llm-request-meter.test.ts
 */
import assert from "node:assert/strict";
import { measureLlmRequestPayload, MIB, utf8Bytes } from "./llm-request-meter.js";

assert.equal(utf8Bytes({ a: 1 }), Buffer.byteLength(JSON.stringify({ a: 1 }), "utf8"));
assert.ok(utf8Bytes({ c: "中" }) > JSON.stringify({ c: "中" }).length);

const empty = measureLlmRequestPayload({}, { id: "m", provider: "p" });
assert.equal(empty.model, "m");
assert.equal(empty.provider, "p");
assert.equal(empty.messages, 0);
assert.equal(empty.tools, 0);
assert.equal(empty.over_1mib, false);

const payload = {
  model: "deepseek-v4-flash",
  messages: [
    { role: "user", content: "hi" },
    { role: "assistant", content: "ok" },
  ],
  tools: [{ type: "function", function: { name: "shell" } }],
};
const m = measureLlmRequestPayload(payload, { id: "x", provider: "opencode-go" });
assert.equal(m.model, "deepseek-v4-flash");
assert.equal(m.provider, "opencode-go");
assert.equal(m.messages, 2);
assert.equal(m.tools, 1);
assert.ok(m.bytes > m.messages_bytes);
assert.ok(m.messages_bytes > 0);
assert.ok(m.tools_bytes > 0);
assert.equal(m.over_1mib, false);

const fat = measureLlmRequestPayload({ messages: [{ role: "user", content: "x".repeat(MIB) }] });
assert.equal(fat.over_1mib, true);
assert.ok(fat.bytes >= MIB);

console.log("llm-request-meter.test.ts ok");
