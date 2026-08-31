/**
 * Session-title Task hint (Spec #457) — gate + Main prompt copy.
 * Run: npx tsx src/runtime/session-title.test.ts
 */
import assert from "node:assert/strict";
import type { TaskEnvelope } from "../types.js";
import {
  applyHarnessAutoTitle,
  formatSessionTitleHint,
  harnessAutoTitleFromEnvelope,
  shouldApplyHarnessAutoTitle,
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
  const autoTask = task({
    conversationTitle: "新会话",
    target: { type: "url", value: "http://host.docker.internal:3000" },
    instruction: "再次渗透测试",
  });
  const auto = formatSessionTitleHint(autoTask, { titleToolAvailable: false });
  assert.match(auto, /harness/i);
  assert.doesNotMatch(auto, /platform_set_conversation_title/);
  assert.doesNotMatch(auto, /only_if_default=true/);
  assert.doesNotMatch(auto, /housekeeping/i);
  assert.equal(harnessAutoTitleFromEnvelope(autoTask), "host.docker.internal:3000");
  assert.ok(shouldApplyHarnessAutoTitle(autoTask));
  assert.ok(!shouldApplyHarnessAutoTitle(autoTask, { graphStage: true }));
  assert.ok(!shouldApplyHarnessAutoTitle(autoTask, { worker: true }));

  const greetingTask = task({ conversationTitle: "新会话", instruction: "你好" });
  const greeting = formatSessionTitleHint(greetingTask, { titleToolAvailable: false });
  assert.doesNotMatch(greeting, /only_if_default=true/);
  assert.match(greeting, /do not auto-title/i);
  assert.doesNotMatch(greeting, /platform_set_conversation_title/);
  assert.equal(shouldApplyHarnessAutoTitle(greetingTask), false);

  const customTask = task({
    conversationTitle: "Juice Shop 复测",
    target: { type: "url", value: "http://host.docker.internal:3000" },
  });
  const custom = formatSessionTitleHint(customTask, { titleToolAvailable: false });
  assert.match(custom, /Juice Shop 复测/);
  assert.doesNotMatch(custom, /only_if_default=true/);
  assert.doesNotMatch(custom, /platform_set_conversation_title/);
  assert.equal(shouldApplyHarnessAutoTitle(customTask), false);

  const defaultRename = formatSessionTitleHint(customTask, { titleToolAvailable: true });
  assert.match(defaultRename, /platform_set_conversation_title/);
  assert.match(defaultRename, /only_if_default=false/);
  console.log("ok session title hint cases");
}

{
  const sent: Array<Record<string, unknown>> = [];
  const origFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ title: "host.docker.internal:3000" }),
    } as Response;
  }) as typeof fetch;
  try {
    const result = await applyHarnessAutoTitle({
      task: task({
        conversationTitle: "新会话",
        target: { type: "url", value: "http://host.docker.internal:3000" },
      }),
      platform: {
        send: async (msg) => {
          sent.push(msg);
        },
      },
      platformApi: { baseUrl: "http://platform.test", nodeToken: "tok" },
    });
    assert.equal(result.applied, true);
    assert.equal(calls.length, 1);
    assert.match(String(calls[0]!.url), /\/api\/node\/ledger\/conversations\/c1\/title/);
    assert.equal((calls[0]!.body as { only_if_default?: boolean }).only_if_default, true);
    assert.ok(sent.some((m) => m.type === "conversation_title_updated"));
  } finally {
    globalThis.fetch = origFetch;
  }
  console.log("ok harness auto-title write");
}

console.log("session-title.test.ts ok");
