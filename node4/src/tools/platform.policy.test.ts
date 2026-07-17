/**
 * Policy unit tests for platform ledger tools (host create denial + chat-only helpers).
 */
import assert from "node:assert/strict";
import { isHostCreateAttempt } from "./platform.js";
import { isChatOnlyTask } from "../runtime/session-runner.js";
import { resolveRolePack } from "../roles/index.js";
import { DEFAULT_SEAT_ID, DEFAULT_SEAT_PACK } from "../roles/default.js";
import { toolNamesForPack } from "./index.js";

assert.equal(isHostCreateAttempt("create_host", {}), true);
assert.equal(isHostCreateAttempt("enrich_asset", { create_host: true }), true);
assert.equal(isHostCreateAttempt("enrich_asset", { address: "evil.example", ports: [80] }), true);
assert.equal(isHostCreateAttempt("enrich_asset", { asset_id: "abc", ports: [80] }), false);
assert.equal(isHostCreateAttempt("list", {}), false);

const blank = resolveRolePack({});
assert.equal(blank.pack.id, DEFAULT_SEAT_ID);
assert.equal(blank.blocked, undefined);
assert.ok(!toolNamesForPack(DEFAULT_SEAT_PACK).includes("finding"));
assert.ok(toolNamesForPack(DEFAULT_SEAT_PACK).some((n) => n.startsWith("platform_")));

assert.equal(
  isChatOnlyTask({ taskId: "t", conversationId: "c", instruction: "你好", target: {}, scope: {} }, "default"),
  true,
);
assert.equal(
  isChatOnlyTask(
    {
      taskId: "t",
      conversationId: "c",
      instruction: "scan",
      target: { value: "http://x" },
      scope: { allow: ["http://x"] },
    },
    "pentest",
  ),
  false,
);
assert.equal(
  isChatOnlyTask(
    {
      taskId: "t",
      conversationId: "c",
      instruction: "scan",
      target: { value: "http://x" },
      scope: { allow: ["http://x"] },
    },
    "default",
  ),
  true,
  "default seat always chat-only",
);

console.log("platform.policy.test.ts ok");
