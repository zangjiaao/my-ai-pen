/**
 * Spec #493: yield / last-turn harvest (no settlement.json).
 * Run: npx tsx src/runtime/worker-yield.test.ts
 */
import assert from "node:assert/strict";
import {
  formatYieldData,
  harvestWorkerReport,
  lastAssistantTextFromMessages,
} from "./worker-yield.js";
import { isPackageSuccess } from "./package-settlement-law.js";

assert.equal(
  lastAssistantTextFromMessages([
    { role: "user", content: "ping" },
    { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] },
    { role: "assistant", content: [{ type: "text", text: "**pong**" }] },
  ]),
  "**pong**",
);

assert.equal(formatYieldData({ summary: "got pong" }), "got pong");
assert.match(formatYieldData({ reply: "pong" }), /pong/);

{
  const ping = harvestWorkerReport({ lastAssistantText: "**pong** ✅" });
  assert.equal(ping.ok, true, "last-turn ping/pong is success");
  assert.equal(ping.has_valid_result, true);
  assert.equal(ping.salvaged, false);
  assert.match(ping.summary, /pong/);
  assert.equal(isPackageSuccess(ping), true);
}

{
  const y = harvestWorkerReport({
    lastAssistantText: "I could not reach the host",
    yield: { status: "error", error: "timeout talking to target" },
  });
  assert.equal(y.ok, false);
  assert.match(y.summary, /timeout talking to target/);
  assert.equal(isPackageSuccess(y), false);
}

{
  const y = harvestWorkerReport({
    lastAssistantText: "oral report here",
    yield: { status: "success", useLastTurn: true },
  });
  assert.equal(y.ok, true);
  assert.equal(y.summary, "oral report here");
}

{
  const y = harvestWorkerReport({
    lastAssistantText: "ignored",
    yield: { status: "success", data: { summary: "BTC 64633 USD" } },
  });
  assert.equal(y.ok, true);
  assert.match(y.summary, /BTC/);
}

{
  const empty = harvestWorkerReport({ lastAssistantText: "" });
  assert.equal(empty.ok, false);
  assert.match(empty.summary, /without a report/);
}

{
  const aborted = harvestWorkerReport({ lastAssistantText: "partial", aborted: true });
  assert.equal(aborted.ok, false);
  assert.equal(isPackageSuccess(aborted), false);
}

assert.equal(
  isPackageSuccess({ ok: true, salvaged: true, has_valid_result: true }),
  true,
  "I0.4: file salvage flag does not fail a valid yield/last-turn report",
);

console.log("worker-yield.test.ts: ok");
