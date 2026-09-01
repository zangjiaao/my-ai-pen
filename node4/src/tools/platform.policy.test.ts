/**
 * Policy unit tests for platform ledger tools (host create denial + chat-only helpers).
 */
import assert from "node:assert/strict";
import { isDefaultConversationTitle, isHostCreateAttempt, resolveListVulnerabilitiesPort, createPlatformCreateReportTool } from "./platform.js";
import { isChatOnlyTask, isLedgerAssistSeat } from "../runtime/session-runner.js";
import { resolveRolePack } from "../roles/index.js";
import { DEFAULT_SEAT_ID, DEFAULT_SEAT_PACK } from "../roles/default.js";
import { toolNamesForPack } from "./index.js";

// Dedicated create tool is allowed (server requires user-request reason).
assert.equal(isHostCreateAttempt("create_host", {}), false);
assert.equal(isHostCreateAttempt("platform_create_asset", {}), false);
// enrich must not smuggle create
assert.equal(isHostCreateAttempt("enrich_asset", { create_host: true }), true);
assert.equal(isHostCreateAttempt("enrich_asset", { address: "evil.example", ports: [80] }), true);
assert.equal(isHostCreateAttempt("enrich_asset", { asset_id: "abc", ports: [80] }), false);
assert.equal(isHostCreateAttempt("list", {}), false);

const blank = resolveRolePack({});
assert.equal(blank.pack.id, DEFAULT_SEAT_ID);
assert.equal(blank.blocked, undefined);
assert.ok(!toolNamesForPack(DEFAULT_SEAT_PACK).includes("finding"));
assert.ok(!toolNamesForPack(DEFAULT_SEAT_PACK).includes("workset"));
assert.ok(toolNamesForPack(DEFAULT_SEAT_PACK).some((n) => n.startsWith("platform_")));
assert.ok(
  toolNamesForPack(DEFAULT_SEAT_PACK).includes("request_user_decision"),
  "default seat can request UI authorization cards",
);

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
      instruction: "目标：JuiceShop，开始应用评估",
      target: {},
      scope: {},
    },
    "pentest",
  ),
  false,
  "pentest empty envelope is a work turn, not chat-only",
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
assert.equal(isLedgerAssistSeat("default"), true);
assert.equal(isLedgerAssistSeat("consult"), true);
assert.equal(isLedgerAssistSeat("pentest"), false);
assert.ok(
  toolNamesForPack(DEFAULT_SEAT_PACK).includes("platform_create_report"),
  "default seat can persist delivery reports",
);
{
  const report = createPlatformCreateReportTool({
    task: { taskId: "t", conversationId: "c", instruction: "x", target: {}, scope: {} },
    platform: { send: async () => {} },
  } as never);
  assert.doesNotMatch(
    String(report.description),
    /First platform_list_vulnerabilities/i,
    "act Expert no longer has list_vulnerabilities — report body comes from Case blackboard",
  );
  assert.match(String(report.description), /Case|blackboard|findings board/i);
}
assert.ok(
  toolNamesForPack(DEFAULT_SEAT_PACK).includes("platform_list_reports"),
  "default seat can list reports",
);
assert.ok(
  toolNamesForPack(DEFAULT_SEAT_PACK).includes("platform_set_conversation_title"),
  "default seat can rename session title",
);
assert.ok(
  toolNamesForPack(DEFAULT_SEAT_PACK).includes("fact"),
  "default seat notebook is fact (Intel hang)",
);


{
  const task = {
    target: { type: "url", value: "http://host.docker.internal:3000" },
    scope: { allow: ["http://host.docker.internal:3000"] },
  };
  assert.deepEqual(resolveListVulnerabilitiesPort({ task }), { port: "3000", appliedDefault: true });
  assert.deepEqual(resolveListVulnerabilitiesPort({ port: "8080", task }), {
    port: "8080",
    appliedDefault: false,
  });
  assert.deepEqual(resolveListVulnerabilitiesPort({ allPorts: true, task }), {
    port: "",
    appliedDefault: false,
  });
}
assert.ok(
  !toolNamesForPack(DEFAULT_SEAT_PACK).includes("platform_record_intel"),
  "platform_record_intel is not a second Agent surface",
);

assert.equal(isDefaultConversationTitle("新会话"), true);
assert.equal(isDefaultConversationTitle("New session"), true);
assert.equal(isDefaultConversationTitle("  "), true);
assert.equal(isDefaultConversationTitle("DVWA 渗透 — lab.local"), false);

console.log("platform.policy.test.ts ok");
