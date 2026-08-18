/**
 * Configured seat model is available before the first assistant message_end.
 * Run: npx tsx src/runtime/llm-usage.test.ts
 */
import assert from "node:assert/strict";
import { LlmUsageLedger } from "./llm-usage.js";
import { createUsageLedgerFromEnv } from "./platform-observability.js";

{
  const ledger = new LlmUsageLedger();
  ledger.setConfiguredModel("deepseek-v4-flash");
  const snap = ledger.snapshot();
  assert.equal(snap.model, "deepseek-v4-flash");
  assert.equal(snap.requests, 0);
  assert.equal(snap.total_tokens, 0);
}

{
  const ledger = new LlmUsageLedger();
  ledger.setConfiguredModel("configured-id");
  const recorded = ledger.recordAssistantMessage({
    role: "assistant",
    model: "provider-reported-id",
    usage: { input: 10, output: 5, totalTokens: 15 },
  });
  assert.equal(recorded, true);
  const snap = ledger.snapshot();
  assert.equal(snap.model, "provider-reported-id");
  assert.equal(snap.requests, 1);
  assert.equal(snap.total_tokens, 15);
}

{
  const ledger = createUsageLedgerFromEnv({ PI_MODEL: "from-env" });
  assert.equal(ledger.snapshot().model, "from-env");
  assert.equal(ledger.snapshot().requests, 0);
}

console.log("llm-usage.test.ts: ok");
