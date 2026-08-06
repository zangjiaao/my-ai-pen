/**
 * Spec #308 S5 / S6 integration-style pure tests (Case message fixtures).
 *
 * Proves:
 * - S5 late-open: history prefix + live append for same agent_id / package_turn_id
 * - S6 Case-only rebuild: persisted messages alone reconstruct Package + process + Delivery
 *
 * Run: npx tsx src/lib/workerAuditReplay.test.ts
 */
import assert from "node:assert/strict";
import {
  buildPackageTurns,
  mergeHistoryAndLive,
  selectDefaultTurnId,
} from "./workerAuditTurns";
import {
  filterMainChannelMessages,
  filterWorkerAgentMessages,
  type MessageLike,
} from "./workerAuditChannel";

/** Minimal Case-persisted fixture (no Node process required). */
function caseFixtureMessages(): MessageLike[] {
  return [
    // Main narrative noise — must not pollute Worker turns
    {
      id: "main-text",
      msg_type: "text",
      created_at: "2026-03-01T10:00:00Z",
      content: { text: "Main is working" },
    },
    {
      id: "main-subagent-tool",
      msg_type: "tool_call",
      created_at: "2026-03-01T10:00:01Z",
      content: { tool_name: "subagent", status: "done", summary: "dispatched Worker 1" },
    },
    // Package 1 complete
    {
      id: "wp-start-1",
      msg_type: "worker_package_start",
      created_at: "2026-03-01T10:00:02Z",
      content: {
        channel: "worker_audit",
        agent_id: "sub_1",
        package_turn_id: "pkg_sub_1_a",
        handoff: {
          target: "https://app.example/login",
          scope: "web auth",
          already_done: "none",
          this_turn_goal: "Probe login SQLi",
          success_criteria: "poc or deadend",
        },
      },
    },
    {
      id: "wp-think-1",
      msg_type: "thinking",
      created_at: "2026-03-01T10:00:03Z",
      content: {
        channel: "worker_audit",
        agent_id: "sub_1",
        package_turn_id: "pkg_sub_1_a",
        stream_id: "wstream_a1",
        text: "Checking login form…",
      },
    },
    {
      id: "wp-tool-1",
      msg_type: "tool_call",
      created_at: "2026-03-01T10:00:04Z",
      content: {
        channel: "worker_audit",
        agent_id: "sub_1",
        package_turn_id: "pkg_sub_1_a",
        tool_name: "browser_action",
        tool_run_id: "tr_a1",
        status: "done",
        summary: "GET /login 200",
      },
    },
    {
      id: "wp-text-1",
      msg_type: "text",
      created_at: "2026-03-01T10:00:05Z",
      content: {
        channel: "worker_audit",
        agent_id: "sub_1",
        package_turn_id: "pkg_sub_1_a",
        stream_id: "wstream_a2",
        text: "No injection on username.",
      },
    },
    {
      id: "wp-del-1",
      msg_type: "worker_package_delivery",
      created_at: "2026-03-01T10:00:06Z",
      content: {
        channel: "worker_audit",
        agent_id: "sub_1",
        package_turn_id: "pkg_sub_1_a",
        status: "ok",
        summary: "Login form exercised; no SQLi.",
        settlement: { findings: 0, deadend: true, reason: "param_not_reflected" },
      },
    },
    // Package 2 still running (no delivery)
    {
      id: "wp-start-2",
      msg_type: "worker_package_start",
      created_at: "2026-03-01T10:05:00Z",
      content: {
        channel: "worker_audit",
        agent_id: "sub_1",
        package_turn_id: "pkg_sub_1_b",
        handoff: {
          target: "https://app.example/search",
          scope: "web",
          already_done: "login checked",
          this_turn_goal: "Probe search XSS",
          success_criteria: "poc",
        },
      },
    },
    {
      id: "wp-think-2",
      msg_type: "thinking",
      created_at: "2026-03-01T10:05:01Z",
      content: {
        channel: "worker_audit",
        agent_id: "sub_1",
        package_turn_id: "pkg_sub_1_b",
        stream_id: "wstream_b1",
        text: "Opening search…",
      },
    },
  ];
}

// ─── S6 Case-only rebuild (no Node) ─────────────────────────────────────────
{
  const all = caseFixtureMessages();
  // Main list excludes Worker frames
  const main = filterMainChannelMessages(all);
  assert.equal(main.length, 2, "Main keeps only non-Worker messages");
  assert.ok(main.every((m) => m.msg_type !== "worker_package_start"));

  // Dialog rebuild from Case messages alone
  const turns = buildPackageTurns(all, "sub_1");
  assert.equal(turns.length, 2, "two Package turns on same Worker");

  const p1 = turns[0];
  assert.equal(p1.packageTurnId, "pkg_sub_1_a");
  assert.equal(p1.status, "ok");
  assert.equal(p1.handoff.this_turn_goal, "Probe login SQLi");
  assert.equal(p1.handoff.target, "https://app.example/login");
  assert.equal(p1.process.length, 3, "thinking + tool + text");
  assert.ok(p1.delivery);
  assert.equal(p1.delivery?.status, "ok");
  assert.equal(p1.delivery?.summary, "Login form exercised; no SQLi.");
  assert.deepEqual(p1.delivery?.settlement, {
    findings: 0,
    deadend: true,
    reason: "param_not_reflected",
  });

  const p2 = turns[1];
  assert.equal(p2.packageTurnId, "pkg_sub_1_b");
  assert.equal(p2.status, "running");
  assert.equal(p2.delivery, null, "running has no Delivery");
  assert.equal(p2.handoff.this_turn_goal, "Probe search XSS");
  assert.equal(p2.process.length, 1);
  assert.equal(selectDefaultTurnId(turns), "pkg_sub_1_b", "default = latest (running)");

  // Agent filter still works after Case reload shape
  const scoped = filterWorkerAgentMessages(all, "sub_1");
  assert.ok(scoped.every((m) => String(m.content?.agent_id) === "sub_1"));
  assert.equal(buildPackageTurns(all, "sub_other").length, 0);
}

// ─── S5 late-open: history prefix + live append ─────────────────────────────
{
  const history = caseFixtureMessages();
  // Live: progressive stretch of package 2 thinking + new tool + delivery
  const live: MessageLike[] = [
    {
      id: "live-think",
      msg_type: "thinking",
      created_at: "2026-03-01T10:05:02Z",
      content: {
        channel: "worker_audit",
        agent_id: "sub_1",
        package_turn_id: "pkg_sub_1_b",
        stream_id: "wstream_b1",
        text: "Opening search… found q= param",
      },
    },
    {
      id: "live-tool",
      msg_type: "tool_call",
      created_at: "2026-03-01T10:05:03Z",
      content: {
        channel: "worker_audit",
        agent_id: "sub_1",
        package_turn_id: "pkg_sub_1_b",
        tool_name: "shell",
        tool_run_id: "tr_b1",
        status: "running",
      },
    },
    {
      id: "live-del",
      msg_type: "worker_package_delivery",
      created_at: "2026-03-01T10:05:10Z",
      content: {
        channel: "worker_audit",
        agent_id: "sub_1",
        package_turn_id: "pkg_sub_1_b",
        status: "failed",
        summary: "timeout mid probe",
      },
    },
  ];

  const merged = mergeHistoryAndLive(history, live);
  // History Package 1 frames must remain
  assert.ok(
    merged.some((m) => m.id === "wp-start-1"),
    "late-open keeps history package start",
  );
  assert.ok(
    merged.some((m) => m.id === "wp-del-1"),
    "late-open keeps history delivery",
  );

  // Progressive stream prefers longer live text
  const think = merged.find((m) => String(m.content?.stream_id) === "wstream_b1");
  assert.equal(String(think?.content?.text), "Opening search… found q= param");

  const turns = buildPackageTurns(merged, "sub_1");
  assert.equal(turns.length, 2);
  assert.equal(turns[0].status, "ok", "package 1 still ok after live merge");
  assert.equal(turns[0].process.length, 3);
  assert.equal(turns[1].status, "failed");
  assert.ok(turns[1].delivery);
  assert.equal(turns[1].delivery?.summary, "timeout mid probe");
  assert.ok(
    turns[1].process.some((m) => String(m.content?.tool_name) === "shell"),
    "live tool attached to package 2",
  );
  assert.equal(selectDefaultTurnId(turns), "pkg_sub_1_b");
}

console.log("workerAuditReplay.test.ts: ok");
