/**
 * Harness housekeeping — auto-title gate + expert hint (Spec #457).
 * Run: npx tsx src/runtime/housekeeping.test.ts
 */
import assert from "node:assert/strict";
import type { TaskEnvelope } from "../types.js";
import {
  composeStructuredTitle,
  createHousekeepingSink,
  formatExpertSessionTitleHint,
  shouldRunTitleHousekeeping,
  structuredTargetHint,
  taskHasStructuredTargetOrScope,
} from "./housekeeping.js";

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
  const untitled = task({
    conversationTitle: "新会话",
    target: { type: "url", value: "http://host.docker.internal:3000" },
    instruction: "再次渗透测试",
  });
  assert.equal(shouldRunTitleHousekeeping(untitled), true);

  assert.equal(
    shouldRunTitleHousekeeping(
      task({ conversationTitle: "新会话", instruction: "你好" }),
    ),
    false,
    "greeting without target/scope must not auto-title",
  );

  assert.equal(
    shouldRunTitleHousekeeping(
      task({
        conversationTitle: "Juice Shop 复测",
        target: { type: "url", value: "http://host.docker.internal:3000" },
      }),
    ),
    false,
    "user title is never auto-replaced",
  );

  assert.equal(
    shouldRunTitleHousekeeping(
      task({ conversationTitle: "  ", scope: { allow: ["10.0.0.1"] } }),
    ),
    true,
  );
  console.log("ok shouldRunTitleHousekeeping");
}

{
  assert.equal(
    structuredTargetHint(
      task({ target: { type: "url", value: "http://host.docker.internal:3000" } }),
    ),
    "host.docker.internal:3000",
  );
  const title = composeStructuredTitle(
    task({ target: { type: "url", value: "http://host.docker.internal:3000" } }),
    { id: "pentest", label: "Application security assessment" },
  );
  assert.match(title, /host\.docker\.internal:3000/);
  assert.ok(title.length <= 40);
  console.log("ok structured title compose");
}

{
  const defaultHint = formatExpertSessionTitleHint("新会话");
  assert.match(defaultHint, /housekeeping/i);
  assert.doesNotMatch(defaultHint, /only_if_default=true/);
  assert.doesNotMatch(defaultHint, /real task/);
  assert.match(defaultHint, /only_if_default=false/);

  const customHint = formatExpertSessionTitleHint("DVWA 渗透");
  assert.match(customHint, /DVWA 渗透/);
  assert.doesNotMatch(customHint, /housekeeping/i);
  console.log("ok expert title hint no longer assigns auto-title");
}

{
  const forwarded: string[] = [];
  let titled = 0;
  const sink = createHousekeepingSink(
    { async send(m) { forwarded.push(String(m.type)); } },
    () => {
      titled += 1;
    },
  );
  await sink.send({ type: "text", text: "should drop" });
  await sink.send({ type: "thinking", text: "should drop" });
  await sink.send({ type: "tool_call", tool_name: "shell" });
  await sink.send({ type: "conversation_title_updated", title: "pentest · lab" });
  assert.deepEqual(forwarded, ["conversation_title_updated"]);
  assert.equal(titled, 1);
  console.log("ok housekeeping sink is silent except title");
}

console.log("housekeeping.test.ts ok");
