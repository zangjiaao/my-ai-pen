/**
 * Session-title Task hint (Spec #457) — gate + Main prompt copy.
 * Run: npx tsx src/runtime/session-title.test.ts
 */
import assert from "node:assert/strict";
import type { TaskEnvelope } from "../types.js";
import {
  formatSessionTitleHint,
  structuredTargetHint,
  taskHasStructuredTargetOrScope,
} from "./session-title.js";

function task(partial: Partial<TaskEnvelope> = {}): TaskEnvelope {
  return {
    taskId: "t1",
    conversationId: "c1",
    instruction: "hello",
    target: {},
    scope: {},
    ...partial,
  };
}

{
  assert.equal(
    taskHasStructuredTargetOrScope(
      task({ target: { type: "url", value: "http://host.docker.internal:3000" } }),
    ),
    true,
  );
  assert.equal(
    taskHasStructuredTargetOrScope(
      task({ scope: { allow: ["http://host.docker.internal:3000"] } }),
    ),
    true,
  );
  assert.equal(taskHasStructuredTargetOrScope(task()), false);
  assert.equal(taskHasStructuredTargetOrScope(task({ scope: { allow: [] } })), false);
  console.log("ok structured target/scope gate");
}

{
  assert.equal(
    structuredTargetHint(
      task({ target: { type: "url", value: "http://host.docker.internal:3000" } }),
    ),
    "host.docker.internal:3000",
  );
  console.log("ok structured target hint");
}

{
  const auto = formatSessionTitleHint(
    task({
      conversationTitle: "新会话",
      target: { type: "url", value: "http://host.docker.internal:3000" },
      instruction: "再次渗透测试",
    }),
  );
  assert.match(auto, /only_if_default=true/);
  assert.match(auto, /do not announce/i);
  assert.doesNotMatch(auto, /housekeeping/i);

  const greeting = formatSessionTitleHint(
    task({ conversationTitle: "新会话", instruction: "你好" }),
  );
  assert.doesNotMatch(greeting, /only_if_default=true/);
  assert.match(greeting, /do not auto-title/i);

  const custom = formatSessionTitleHint(
    task({
      conversationTitle: "Juice Shop 复测",
      target: { type: "url", value: "http://host.docker.internal:3000" },
    }),
  );
  assert.match(custom, /Juice Shop 复测/);
  assert.match(custom, /only_if_default=false/);
  assert.doesNotMatch(custom, /only_if_default=true/);
  console.log("ok session title hint cases");
}

console.log("session-title.test.ts ok");
