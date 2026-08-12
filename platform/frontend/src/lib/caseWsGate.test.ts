/**
 * Case WS gate — single entry for Case-scoped frames.
 * Run: npx tsx src/lib/caseWsGate.test.ts  (from platform/frontend)
 */
import assert from "node:assert/strict";
import { gateCaseWsHandlers, isActiveCaseMessage } from "./caseWsGate.ts";

assert.equal(isActiveCaseMessage({ conversation_id: "c1" }, null), false);
assert.equal(isActiveCaseMessage({ conversation_id: "c1" }, ""), false);
assert.equal(isActiveCaseMessage({ conversation_id: "c1" }, "c1"), true);
assert.equal(isActiveCaseMessage({ conversation_id: "c2" }, "c1"), false);
assert.equal(isActiveCaseMessage({}, "c1"), true, "legacy unscoped on open Case");
assert.equal(isActiveCaseMessage({}, null), false, "legacy unscoped on blank home");

{
  const seen: string[] = [];
  const gated = gateCaseWsHandlers(
    "c1",
    {
      plan_tree_updated: (m) => seen.push(`plan:${m.conversation_id}`),
      conversation_working: (m) => seen.push(`work:${m.conversation_id}`),
    },
    { bypass: ["conversation_working"] },
  );
  gated.plan_tree_updated!({ conversation_id: "c2" });
  gated.plan_tree_updated!({ conversation_id: "c1" });
  gated.conversation_working!({ conversation_id: "c2" });
  assert.deepEqual(seen, ["plan:c1", "work:c2"], "plan gated; working bypassed");
}

{
  const seen: string[] = [];
  const gated = gateCaseWsHandlers(null, {
    plan_tree_updated: () => seen.push("x"),
  });
  gated.plan_tree_updated!({ conversation_id: "c1" });
  assert.deepEqual(seen, [], "blank home drops Case frames");
}

console.log("ok: caseWsGate");
