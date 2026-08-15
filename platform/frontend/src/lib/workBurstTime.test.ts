/**
 * Spec #325 S2 FE projections — composer C1 + B1 anchor.
 * Run: npx tsx src/lib/workBurstTime.test.ts
 */
import assert from "node:assert/strict";
import {
  composerLiveSeconds,
  composerTimerVisible,
  formatAgentDurationLabel,
  formatElapsedTenths,
  formatWorkSeconds,
  resultAnchorWorkSeconds,
  selectResultAnchorMessageIds,
  type WorkBurstProjection,
} from "./workBurstTime.ts";

{
  assert.equal(formatWorkSeconds(0), "0:00");
  assert.equal(formatWorkSeconds(65), "1:05");
  assert.equal(formatWorkSeconds(3600 + 65), "1:01:05");
  console.log("ok: formatWorkSeconds");

  assert.equal(formatAgentDurationLabel(0), "耗时：0s");
  assert.equal(formatAgentDurationLabel(11), "耗时：11s");
  assert.equal(formatAgentDurationLabel(65), "耗时：1m 5s");
  assert.equal(formatAgentDurationLabel(3600 + 65), "耗时：1h 1m 5s");
  console.log("ok: formatAgentDurationLabel");
}

{
  const idle: WorkBurstProjection = { active_burst_id: null, live_work_seconds: null };
  assert.equal(composerTimerVisible(idle, false), false);
  // Optimistic / mid-reload: working without ledger still shows timer+list-tail.
  assert.equal(composerTimerVisible(null, true), true);
  assert.equal(composerTimerVisible(idle, true), true);

  const open: WorkBurstProjection = {
    active_burst_id: "wb_1",
    live_work_seconds: 12,
    accruing: true,
  };
  assert.equal(composerTimerVisible(open, true), true);
  assert.equal(composerTimerVisible(open, false), true, "open burst keeps timer even if working flag lags");

  const paused: WorkBurstProjection = {
    active_burst_id: "wb_1",
    live_work_seconds: 12,
    accruing: false,
    authorize_paused: true,
  };
  assert.equal(composerTimerVisible(paused, true), true);
  assert.equal(composerLiveSeconds(paused), 12);
  assert.equal(composerLiveSeconds(open, { nowMs: 5000, tickAnchor: { seconds: 10, atMs: 2000 } }), 13);
  const remount: WorkBurstProjection = {
    active_burst_id: "wb_1",
    live_work_seconds: 87,
    accruing: true,
  };
  assert.equal(composerLiveSeconds(remount), 87, "reload uses ledger seconds, not 0");
  assert.equal(composerLiveSeconds(remount, { precise: true }), 87);
  assert.equal(
    composerLiveSeconds(remount, {
      precise: true,
      nowMs: 2500,
      tickAnchor: { seconds: 87, atMs: 1000 },
    }),
    88.5,
  );
  console.log("ok: composer C1 visibility + pause");
}

{
  assert.equal(formatElapsedTenths(0), "0.0s");
  assert.equal(formatElapsedTenths(12.3), "12.3s");
  assert.equal(formatElapsedTenths(65.3), "1m 5.3s");
  console.log("ok: formatElapsedTenths");
}

{
  assert.equal(resultAnchorWorkSeconds({ is_result_anchor: true, work_seconds: 42 }), 42);
  assert.equal(resultAnchorWorkSeconds({ work_seconds: 42 }), null);
  assert.equal(resultAnchorWorkSeconds({ work_burst_id: "wb", work_seconds: 9 }), 9);
  assert.equal(resultAnchorWorkSeconds({ is_result_anchor: true, work_seconds: -1 }), null);

  const msgs = [
    { id: "u1", role: "user", msg_type: "text", content: { text: "go" } },
    { id: "t1", role: "agent", msg_type: "tool_call", content: {} },
    { id: "a1", role: "agent", msg_type: "text", content: { text: "done", is_result_anchor: true, work_seconds: 88 } },
    { id: "a2", role: "agent", msg_type: "thinking", content: { status: "done" } },
  ];
  const map = selectResultAnchorMessageIds(msgs, { wb_1: 88 });
  assert.equal(map.a1, 88);
  assert.equal(map.t1, undefined);
  assert.equal(map.a2, undefined);
  console.log("ok: B1 one duration per burst on result anchor");
}

{
  // Fallback when stamp missing: exactly one finalized → last text agent
  const msgs = [
    { id: "t1", role: "agent", msg_type: "tool_call", content: {} },
    { id: "a1", role: "agent", msg_type: "text", content: { text: "ok" } },
  ];
  const map = selectResultAnchorMessageIds(msgs, { wb_x: 15 });
  assert.equal(map.a1, 15);
  assert.equal(map.t1, undefined);
  console.log("ok: B1 fallback single finalized");
}

{
  // status / engagement_closeout are not B1 fallback targets (SystemNotice path)
  const msgs = [
    { id: "s1", role: "agent", msg_type: "status", content: { text: "gist" } },
    { id: "e1", role: "agent", msg_type: "engagement_closeout", content: {} },
    { id: "a1", role: "agent", msg_type: "text", content: { text: "ok" } },
  ];
  const map = selectResultAnchorMessageIds(msgs, { wb_y: 21 });
  assert.equal(map.a1, 21);
  assert.equal(map.s1, undefined);
  assert.equal(map.e1, undefined);
  const onlyStatus = selectResultAnchorMessageIds(
    [{ id: "s1", role: "agent", msg_type: "status", content: { text: "x" } }],
    { wb_z: 3 },
  );
  assert.equal(onlyStatus.s1, undefined);
  console.log("ok: B1 fallback skips status/closeout");
}

{
  // Multi-turn: each user→agent segment gets a finalized duration (not only when count===1)
  const msgs = [
    { id: "u1", role: "user", msg_type: "text", content: { text: "a" } },
    { id: "a1", role: "agent", msg_type: "text", content: { text: "ra" } },
    { id: "u2", role: "user", msg_type: "text", content: { text: "b" } },
    { id: "a2t", role: "agent", msg_type: "thinking", content: {} },
    { id: "a2", role: "agent", msg_type: "text", content: { text: "rb" } },
    { id: "u3", role: "user", msg_type: "text", content: { text: "c" } },
    { id: "a3", role: "agent", msg_type: "text", content: { text: "rc" } },
  ];
  const map = selectResultAnchorMessageIds(msgs, {
    burst_old: 10,
    burst_mid: 20,
    burst_new: 30,
  });
  assert.equal(map.a1, 10);
  assert.equal(map.a2, 20);
  assert.equal(map.a3, 30);
  assert.equal(map.a2t, undefined, "thinking is not a duration locus");
  console.log("ok: B1 multi-turn each agent text turn has duration");
}

{
  // Prefer server stamp; do not overwrite with fallback
  const msgs = [
    { id: "u1", role: "user", msg_type: "text", content: {} },
    {
      id: "a1",
      role: "agent",
      msg_type: "text",
      content: { is_result_anchor: true, work_seconds: 99, work_burst_id: "b1" },
    },
  ];
  const map = selectResultAnchorMessageIds(msgs, { b1: 99, b2: 5 });
  assert.equal(map.a1, 99);
  console.log("ok: B1 keeps server stamp");
}

{
  // Streaming reply: withhold 耗时 until output finishes
  const msgs = [
    { id: "u1", role: "user", msg_type: "text", content: {} },
    { id: "a1", role: "agent", msg_type: "text", content: { text: "partial..." } },
  ];
  const whileStreaming = selectResultAnchorMessageIds(msgs, { wb: 42 }, {
    streamingMessageIds: ["a1"],
  });
  assert.equal(whileStreaming.a1, undefined, "no duration while text still streaming");
  const afterDone = selectResultAnchorMessageIds(msgs, { wb: 42 }, {
    streamingMessageIds: [],
  });
  assert.equal(afterDone.a1, 42);
  console.log("ok: B1 withholds duration until stream completes");
}

// Withhold 耗时 while a tool_call in the same segment is still running (interrupt sticky).
{
  const msgs = [
    { id: "u1", role: "user", msg_type: "text", content: { text: "go" } },
    { id: "a1", role: "agent", msg_type: "text", content: { text: "starting" } },
    {
      id: "t1",
      role: "agent",
      msg_type: "tool_call",
      content: { tool_name: "shell", status: "running", summary: "shell running" },
    },
  ];
  const whileToolRunning = selectResultAnchorMessageIds(msgs, { wb: 49 }, {
    suppressOpenSegment: false,
  });
  assert.equal(whileToolRunning.a1, undefined, "no 耗时 above stuck running tool");

  const settled = selectResultAnchorMessageIds(
    [
      msgs[0]!,
      msgs[1]!,
      {
        id: "t1",
        role: "agent",
        msg_type: "tool_call",
        content: { tool_name: "shell", status: "canceled", summary: "interrupted" },
      },
    ],
    { wb: 49 },
    { suppressOpenSegment: false },
  );
  assert.equal(settled.a1, 49, "耗时 returns once tools are terminal");
  console.log("ok: withhold B1 耗时 while segment tool still running");
}

{
  // Active turn: server may stamp is_result_anchor mid-stream — still suppress open segment
  const msgs = [
    { id: "u0", role: "user", msg_type: "text", content: {} },
    {
      id: "a0",
      role: "agent",
      msg_type: "text",
      content: { text: "old", is_result_anchor: true, work_seconds: 10, work_burst_id: "old" },
    },
    { id: "u1", role: "user", msg_type: "text", content: {} },
    {
      id: "a1",
      role: "agent",
      msg_type: "text",
      content: {
        text: "partial...",
        stream_id: "n4-text-x-1",
        is_result_anchor: true,
        work_seconds: 5,
        work_burst_id: "new",
      },
    },
  ];
  const open = selectResultAnchorMessageIds(msgs, { old: 10, new: 5 }, {
    suppressOpenSegment: true,
  });
  assert.equal(open.a0, 10, "historical turn still shows 耗时");
  assert.equal(open.a1, undefined, "open segment withheld even if stamped");
  const settled = selectResultAnchorMessageIds(msgs, { old: 10, new: 5 }, {
    suppressOpenSegment: false,
  });
  assert.equal(settled.a1, 5);
  console.log("ok: B1 suppressOpenSegment for active turn");
}

console.log("workBurstTime.test.ts: all ok");
