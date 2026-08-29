/**
 * Feedback must not consume Worker 1; release greys the collab row.
 */
import assert from "node:assert/strict";
import { PanelAgentTracker } from "./panel-agents.js";

{
  const panel = new PanelAgentTracker("task", "渗透大师");
  panel.noteSubagentStart({
    id: "feedback",
    assignment: "Feedback after init",
    label: "Feedback",
    name: "Feedback",
  });
  panel.noteSubagentStart({ id: "sub_1787915335500_1", assignment: "登录与会话刻画" });
  const kids = panel.list().filter((a) => a.parent_id);
  assert.equal(kids.find((a) => a.id === "feedback")?.name, "Feedback");
  assert.equal(kids.find((a) => a.id === "sub_1787915335500_1")?.name, "Worker 1");
  assert.equal(panel.workerIndexFor("sub_1787915335500_1"), 1);
  assert.equal(panel.workerIndexFor("feedback"), 0);
  console.log("ok: Feedback does not consume Worker 1");
}

{
  const panel = new PanelAgentTracker("task", "Expert");
  panel.noteSubagentStart({ id: "sub_1", assignment: "probe" });
  assert.equal(panel.noteSubagentReleased("sub_1"), true);
  const row = panel.list().find((a) => a.id === "sub_1");
  assert.equal(row?.status, "released");
  assert.equal(row?.name, "Worker 1");
  assert.equal(panel.dropChild("sub_1"), true, "dropChild remains for tests / Session delete");
  console.log("ok: release keeps row grey");
}

{
  const panel = new PanelAgentTracker("task", "渗透大师");
  panel.noteSubagentStart({
    id: "feedback",
    assignment: "Feedback after init",
    label: "评审 init → surface",
    name: "Feedback",
  });
  panel.setMainActivity({ phase: "llm_waiting", detail: "Feedback 评审 init → surface" });
  const main = panel.list()[0]!;
  assert.equal(main.current_detail, "Feedback 评审 init → surface");
  assert.ok(!/并行/.test(String(main.current_detail)));
  console.log("ok: Feedback running does not steal Worker fan-out subtitle");
}
