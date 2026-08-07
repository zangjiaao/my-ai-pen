/**
 * Spec #305 S4 — pending speaker reuses MessageRenderer speaker rules.
 * Run: npx tsx src/lib/agentSpeaker.test.ts  (from platform/frontend)
 */
import assert from "node:assert/strict";
import {
  agentDisplayName,
  shouldShowAgentSpeakerLabel,
} from "../components/MessageRenderer.tsx";
import {
  buildPendingSendSuccessEvent,
  pendingChromeSpeakerContent,
  reducePendingChrome,
} from "./messageStreamIdentity.ts";

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

// Issue 16: display_name vs name same expert collapses
{
  assert.equal(
    shouldShowAgentSpeakerLabel(
      { expert_display_name: "渗透大师" },
      { expert_name: "渗透大师" },
    ),
    false,
    "display_name and name resolve to same speaker → collapse",
  );
  assert.equal(
    agentDisplayName({ expert_display_name: "@渗透大师" }, {}),
    "渗透大师",
  );
  console.log("ok: Issue 16 display_name vs name collapse");
}

// Issue 7: send_success attribution → speaker content shape
{
  const pending = reducePendingChrome(
    null,
    buildPendingSendSuccessEvent({
      conversationId: "conv-1",
      expert_id: "exp-1",
      expert_name: "渗透大师",
      expert_display_name: "渗透大师",
      agent_source: "pentest",
    }),
  );
  const content = pendingChromeSpeakerContent(pending!);
  assert.equal(shouldShowAgentSpeakerLabel(content, null), true);
  assert.equal(
    shouldShowAgentSpeakerLabel(content, { expert_name: "渗透大师" }),
    false,
  );
  assert.equal(agentDisplayName(content, {}), "渗透大师");
  console.log("ok: Issue 7 send path attribution shape + collapse");
}

console.log("all agentSpeaker Spec #305 tests passed");
