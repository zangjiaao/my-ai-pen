/**
 * Occupancy checkpoint (Spec context-window-management.md).
 * Run: npx tsx src/runtime/context-window.test.ts
 */
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  CHECKPOINT_POINTER,
  PERSIST_PASS_MARKER,
  buildCheckpointMessages,
  createContextWindowTransform,
  estimateOccupancy,
  findKeepTailStart,
  occupancyAtOrAboveThreshold,
  occupancyLlmTurnError,
  parseCompactThreshold,
  withPersistPass,
  type CompactCycle,
} from "./context-window.js";
import { isLlmTurnError } from "./llm-turn-error.js";

assert.equal(parseCompactThreshold(undefined), 0.8);
assert.equal(parseCompactThreshold("0.8"), 0.8);
assert.equal(parseCompactThreshold("80"), 0.8);
assert.equal(parseCompactThreshold("0.4"), 0.5);
assert.equal(parseCompactThreshold("99"), 0.95);

const shortMsgs = [
  { role: "user", content: "hi", timestamp: 1 },
  { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 100, output: 20 }, timestamp: 2 },
];
const occ = estimateOccupancy(shortMsgs);
assert.equal(occ.usageTokens, 120);
assert.equal(occupancyAtOrAboveThreshold(120, 8192, 0.8), false);

const fat = [
  ...shortMsgs,
  {
    role: "assistant",
    content: [{ type: "text", text: "x" }],
    usage: { input: 7000, output: 100 },
    timestamp: 3,
  },
  { role: "toolResult", toolCallId: "t1", toolName: "shell", content: [{ type: "text", text: "nmap dump ".repeat(200) }], timestamp: 4 },
];
const fatOcc = estimateOccupancy(fat);
assert.ok(occupancyAtOrAboveThreshold(fatOcc.tokens, 8192, 0.8), "fat occupancy should trip 80% of 8k");

const keep = findKeepTailStart(
  [
    { role: "user", content: "start recon", timestamp: 1 },
    { role: "assistant", content: "todo in_progress: probe login", timestamp: 2 },
    { role: "user", content: "keep going", timestamp: 3 },
    { role: "assistant", content: "ok", timestamp: 4 },
  ],
  "probe login",
);
assert.equal(keep, 0, "keep-tail starts at the user turn that began the in_progress todo");
assert.equal(
  findKeepTailStart(
    [
      { role: "user", content: "old", timestamp: 1 },
      { role: "assistant", content: "done", timestamp: 2 },
      { role: "user", content: "now", timestamp: 3 },
    ],
    null,
  ),
  2,
);

const toolBody = "SENSITIVE_TOOL_BODY_SHOULD_DROP";
const history: AgentMessage[] = [
  { role: "user", content: "old turn", timestamp: 1 },
  {
    role: "assistant",
    content: [{ type: "toolCall", id: "c1", name: "shell", arguments: { command: "nmap" } }],
    timestamp: 2,
  } as unknown as AgentMessage,
  { role: "toolResult", toolCallId: "c1", toolName: "shell", content: [{ type: "text", text: toolBody }], timestamp: 3 } as unknown as AgentMessage,
  { role: "user", content: "current slice", timestamp: 4 },
  { role: "assistant", content: [{ type: "text", text: "working" }], timestamp: 5 } as unknown as AgentMessage,
];
const shrunk = buildCheckpointMessages(history, 3, {
  findingsLines: ["- [high] SQLi @ /login id=f1"],
  intelLines: ["- i1 kind=config hang=a:80 — WAF in front"],
});
const blob = JSON.stringify(shrunk);
assert.ok(!blob.includes(toolBody), "pre-slice tool bodies must not survive shrink");
assert.ok(blob.includes("current slice"), "keep-tail current user turn stays");
assert.ok(blob.includes(CHECKPOINT_POINTER), "checkpoint pointer present");
assert.ok(blob.includes("SQLi"), "findings board rehydrated");
assert.ok(blob.includes("WAF"), "living intel rehydrated");

const withPass = withPersistPass(history);
assert.ok(JSON.stringify(withPass).includes(PERSIST_PASS_MARKER));

const err = occupancyLlmTurnError("provider context_length exceeded");
assert.ok(isLlmTurnError(err));
assert.match(err.message, /occupancy/);
assert.notEqual(err.message.includes("natural_stop"), true);

async function testTransformCycle() {
  const cycle: CompactCycle = { persistPassIssued: false, shrinkRetry: 0 };
  const transform = createContextWindowTransform({
    contextWindow: 200,
    threshold: 0.5,
    cycle,
  });
  const below = await transform([
    { role: "user", content: "hi", timestamp: 1 },
    { role: "assistant", content: "ok", usage: { input: 10, output: 5 }, timestamp: 2 } as unknown as AgentMessage,
  ]);
  assert.equal(below.length, 2, "below threshold is a no-op");
  assert.equal(cycle.persistPassIssued, false);

  const over: AgentMessage[] = [
    { role: "user", content: "old", timestamp: 1 },
    { role: "assistant", content: "x", usage: { input: 180, output: 10 }, timestamp: 2 } as unknown as AgentMessage,
    { role: "user", content: "now", timestamp: 3 },
  ];
  const persist = await transform(over);
  assert.ok(JSON.stringify(persist).includes(PERSIST_PASS_MARKER), "first over-threshold is persist pass");
  assert.equal(cycle.persistPassIssued, true);

  const after = await transform(persist);
  const afterBlob = JSON.stringify(after);
  assert.ok(!afterBlob.includes(PERSIST_PASS_MARKER) || after[0].role === "user", "then shrink");
  assert.ok(afterBlob.includes(CHECKPOINT_POINTER), "shrink emits checkpoint");
  assert.ok(!afterBlob.includes("\"content\":\"old\""), "old user turn dropped after persist");
}

await testTransformCycle();
console.log("context-window.test.ts ok");
