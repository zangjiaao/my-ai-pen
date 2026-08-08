/**
 * Spec #325 S2 FE projections — composer C1 + B1 anchor.
 * Run: npx tsx src/lib/workBurstTime.test.ts
 */
import assert from "node:assert/strict";
import {
  composerLiveSeconds,
  composerTimerVisible,
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
}

{
  const idle: WorkBurstProjection = { active_burst_id: null, live_work_seconds: null };
  assert.equal(composerTimerVisible(idle, false), false);
  assert.equal(composerTimerVisible(null, true), false);

  const open: WorkBurstProjection = {
    active_burst_id: "wb_1",
    live_work_seconds: 12,
    accruing: true,
  };
  assert.equal(composerTimerVisible(open, true), true);

  const paused: WorkBurstProjection = {
    active_burst_id: "wb_1",
    live_work_seconds: 12,
    accruing: false,
    authorize_paused: true,
  };
  assert.equal(composerTimerVisible(paused, true), true);
  assert.equal(composerLiveSeconds(paused), 12);
  assert.equal(composerLiveSeconds(open, { nowMs: 5000, tickAnchor: { seconds: 10, atMs: 2000 } }), 13);
  console.log("ok: composer C1 visibility + pause");
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

console.log("workBurstTime.test.ts: all ok");
