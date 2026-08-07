/**
 * Parked continue must clear prior terminal STOP so AgentRow is not stuck.
 */
import assert from "node:assert/strict";
import { PanelAgentTracker } from "./panel-agents.js";

const panel = new PanelAgentTracker("prior task", "渗透大师");
panel.setMainActivity({ phase: "tool_running", tool: "shell" });
assert.equal(panel.list()[0]?.status, "running");

panel.setMainTerminal("aborted");
assert.equal(panel.list()[0]?.status, "stopped", "abort maps to stopped");
assert.equal(panel.list()[0]?.current_action, "aborted");

panel.resetMainForContinue({
  phase: "parked_free_continue",
  task: "继续渗透 http://target:3000",
});
const row = panel.list()[0]!;
assert.equal(row.status, "running", "continue clears stopped");
assert.equal(row.current_action, "parked_free_continue");
assert.equal(row.task, "继续渗透 http://target:3000");
assert.ok(!/已中止/.test(String(row.current_detail || "")), "not 已中止 after reset");

panel.setMainActivity({ phase: "tool_running", tool: "shell" });
const live = panel.list()[0]!;
assert.equal(live.status, "running", "status stays running during tools");
assert.equal(live.current_action, "tool_running");

console.log("ok: panel resetMainForContinue clears STOP for park attach");
