/**
 * Smoke: aggregate Pi assistant usage into Node3-shaped llm_usage (tokens + cost).
 */
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { TaskDiagnostics } from "./runtime/agent-observability.js";
import {
  LlmUsageLedger,
  estimateUsageCost,
  loadLlmCostRatesFromEnv,
} from "./runtime/llm-usage.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// --- pure ledger ---
const rates = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 }; // $/1M
const ledger = new LlmUsageLedger(rates);

assert(
  ledger.recordAssistantMessage({
    role: "assistant",
    model: "custom-model",
    usage: {
      input: 1_000_000,
      output: 500_000,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1_500_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }),
  "first usage should record",
);

// Second message with provider-reported cost.total preferred over rates.
assert(
  ledger.recordAssistantMessage({
    role: "assistant",
    model: "custom-model",
    usage: {
      input: 1000,
      output: 500,
      cacheRead: 200,
      cacheWrite: 0,
      reasoning: 100,
      totalTokens: 1700,
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    },
  }),
  "second usage should record",
);

const snap = ledger.snapshot({ tool_calls: 3 });
assert(snap.requests === 2, `requests=${snap.requests}`);
assert(snap.input_tokens === 1_001_000, `input=${snap.input_tokens}`);
assert(snap.output_tokens === 500_500, `output=${snap.output_tokens}`);
assert(snap.cached_tokens === 200, `cached=${snap.cached_tokens}`);
assert(snap.reasoning_tokens === 100, `reasoning=${snap.reasoning_tokens}`);
assert(snap.total_tokens === 1_501_700, `total=${snap.total_tokens}`);
// first msg cost via rates: 1*1 + 0.5*2 = 2.0; second uses reported 0.03
assert(Math.abs(snap.cost - 2.03) < 1e-9, `cost=${snap.cost}`);
assert(snap.model === "custom-model", `model=${snap.model}`);
assert(snap.tool_calls === 3, "tool_calls passthrough");

const estimated = estimateUsageCost(
  { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
  rates,
);
assert(estimated === 3, `estimate=${estimated}`);

// --- diagnostics integration ---
const workspaceDir = resolve("tmp", "node2-llm-usage-smoke");
const taskId = `llm-usage-${randomUUID()}`;
const taskDir = resolve(workspaceDir, taskId);
await mkdir(taskDir, { recursive: true });

const diagnostics = await TaskDiagnostics.create(
  taskDir,
  {
    taskId,
    conversationId: `conv-${taskId}`,
    instruction: "usage smoke",
    target: { type: "url", value: "http://127.0.0.1:9" },
    scope: { allow: ["http://127.0.0.1:9"] },
    snapshot: {},
  },
  rates,
);

await diagnostics.handleAgentEvent({ type: "turn_start" });
await diagnostics.handleAgentEvent({
  type: "message_end",
  message: {
    role: "assistant",
    model: "test-model",
    stopReason: "stop",
    content: [{ type: "text", text: "hello" }],
    usage: {
      input: 1200,
      output: 300,
      cacheRead: 100,
      cacheWrite: 0,
      reasoning: 50,
      totalTokens: 1600,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  },
});

const usage = diagnostics.llmUsage();
assert(usage.requests === 1, `diag requests=${usage.requests}`);
assert(usage.input_tokens === 1200, `diag input=${usage.input_tokens}`);
assert(usage.output_tokens === 300, `diag output=${usage.output_tokens}`);
assert(usage.cached_tokens === 100, `diag cached=${usage.cached_tokens}`);
assert(usage.reasoning_tokens === 50, `diag reasoning=${usage.reasoning_tokens}`);
assert(usage.total_tokens === 1600, `diag total=${usage.total_tokens}`);
assert(usage.cost > 0, `diag cost should use rates, got ${usage.cost}`);
assert(usage.model === "test-model", `diag model=${usage.model}`);

const summaryRaw = await readFile(resolve(taskDir, "agent-summary.json"), "utf8");
const summary = JSON.parse(summaryRaw) as { llm_usage?: { total_tokens?: number; cost?: number } };
assert(Number(summary.llm_usage?.total_tokens) === 1600, "summary llm_usage.total_tokens");
assert(Number(summary.llm_usage?.cost) > 0, "summary llm_usage.cost");

// Env loader smoke (does not require vars to be set).
const fromEnv = loadLlmCostRatesFromEnv({});
assert(fromEnv.input === 0 && fromEnv.output === 0, "default rates are zero");

// Worker usage rollup into parent diagnostics (P1).
await diagnostics.mergeWorkerUsage({
  requests: 1,
  input_tokens: 100,
  output_tokens: 50,
  cached_tokens: 0,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
  total_tokens: 150,
  cost: 0.001,
  agent_count: 1,
  tool_calls: 2,
});
const withWorker = diagnostics.llmUsage();
assert(withWorker.agent_count === 2, `agent_count with worker=${withWorker.agent_count}`);
assert(withWorker.total_tokens === 1750, `total with worker=${withWorker.total_tokens}`);
assert(withWorker.requests === 2, `requests with worker=${withWorker.requests}`);

console.log(
  JSON.stringify(
    {
      ok: true,
      ledger: snap,
      diagnostics: usage,
      estimated,
    },
    null,
    2,
  ),
);
