/**
 * Spec #324 S1 — Case metering FE projection.
 * Run: npx tsx src/lib/caseMetering.test.ts
 */
import assert from "node:assert/strict";
import {
  agentRowUsesMeteringSecondary,
  formatAgentUsageLine,
  formatCaseMeteringDetail,
  formatCaseMeteringHeader,
  formatCostUsd,
  formatTokenCount,
} from "./caseMetering.ts";

assert.equal(formatTokenCount(0), "0");
assert.equal(formatTokenCount(999), "999");
assert.equal(formatTokenCount(1500), "1.5k");
assert.equal(formatCostUsd(0), "$0");
assert.equal(formatCostUsd(0.02), "$0.02");

assert.equal(
  formatCaseMeteringHeader({ llm_usage: { total_tokens: 1500, cost: 0.02 } }),
  "1.5k tok · $0.02",
);
assert.equal(formatCaseMeteringHeader({ llm_usage: { total_tokens: 0, cost: 0 } }), "0 tok");
assert.equal(formatCaseMeteringHeader(undefined), "0 tok");

const detail = formatCaseMeteringDetail(
  { llm_usage: { total_tokens: 4900000, cost: 0.06, requests: 12 } },
  { activeLine: "0/1 active" },
);
assert.ok(detail.includes("4,900,000"));
assert.ok(detail.includes("Requests: 12"));
assert.ok(detail.includes("$0.06"));
assert.ok(detail.includes("0/1 active"));
assert.ok(detail.includes("Case cumulative"));

assert.equal(
  formatAgentUsageLine({
    model: "gpt-test",
    usage: { total_tokens: 1200, requests: 4 },
  }),
  "gpt-test · 4 req · 1.2k tok",
);

// Sub short line may omit empty chrome
assert.equal(
  formatAgentUsageLine(
    { role: "subagent", parent_id: "main", usage: { total_tokens: 30, requests: 1 } },
    { short: true },
  ),
  "1 req · 30 tok",
);

assert.equal(
  formatAgentUsageLine({ model: "deepseek-v4-flash", usage: {} }),
  "deepseek-v4-flash",
);

// Zero / missing → quiet, not work-content narration
assert.equal(formatAgentUsageLine({ usage: {} }), "—");
assert.equal(formatAgentUsageLine({ role: "subagent", parent_id: "m", usage: {} }), "");
assert.ok(!/本轮工作已结束/.test(formatAgentUsageLine({ usage: {}, model: "" })));
assert.ok(!/正在执行/.test(formatAgentUsageLine({ usage: { total_tokens: 1, requests: 1 } })));

assert.equal(agentRowUsesMeteringSecondary(), true);

console.log("caseMetering.test.ts: ok");
