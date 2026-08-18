/**
 * Collab copy chrome: Main panel must carry pi Agent.sessionId when stamped.
 */
import assert from "node:assert/strict";
import { PanelAgentTracker } from "./panel-agents.js";

const panel = new PanelAgentTracker("你好", "渗透大师");
assert.equal(panel.list()[0]!.session_id, undefined, "no id before stamp");
panel.setAgentSessionId("fbe1e595-agent-sid-example");
const main = panel.list()[0]!;
assert.equal(main.session_id, "fbe1e595-agent-sid-example");
assert.equal(main.role, "main");
// empty stamp clears
panel.setAgentSessionId("");
assert.equal(panel.list()[0]!.session_id, undefined);
panel.setModel("deepseek-v4-flash");
assert.equal(panel.list()[0]!.model, "deepseek-v4-flash");
panel.noteSubagentStart({ id: "sub_1", assignment: "probe" });
assert.equal(panel.list().length, 2);
assert.equal(panel.dropChild("sub_1"), true);
assert.equal(panel.list().length, 1);
console.log("panel-agents.session-id.test.ts: ok");
