/**
 * Spec #305 S4 — pending speaker reuses MessageRenderer speaker rules.
 * Run: npx tsx src/lib/agentSpeaker.test.ts  (from platform/frontend)
 */
import assert from "node:assert/strict";
import {
  agentDisplayName,
  shouldShowAgentSpeakerLabel,
} from "../components/MessageRenderer.tsx";

{
  const expert = { expert_name: "渗透大师", agent_source: "pentest" };
  assert.equal(agentDisplayName(expert, {}), "渗透大师");
  assert.equal(
    agentDisplayName({ agent_source: "default" }, {}),
    "通用助理",
  );
  assert.equal(agentDisplayName({}, {}), "渗透Agent");
  console.log("ok: S4 agentDisplayName resolution");
}

{
  const expert = { expert_name: "渗透大师" };
  assert.equal(shouldShowAgentSpeakerLabel(expert, null), true);
  assert.equal(
    shouldShowAgentSpeakerLabel(expert, { expert_name: "渗透大师" }),
    false,
    "same expert collapses",
  );
  assert.equal(
    shouldShowAgentSpeakerLabel(expert, { expert_name: "其他专家" }),
    true,
    "expert switch shows label",
  );
  assert.equal(
    shouldShowAgentSpeakerLabel(
      { agent_source: "default" },
      { expert_name: "渗透大师" },
    ),
    true,
  );
  console.log("ok: S4 same-speaker collapse for pending chrome");
}

console.log("all agentSpeaker Spec #305 tests passed");
