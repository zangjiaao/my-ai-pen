/**
 * Mid-run steer delivery chrome helpers.
 * Run: npx tsx src/lib/steerDelivery.test.ts  (from platform/frontend)
 */
import assert from "node:assert/strict";
import {
  STEER_DELIVERY_QUEUED,
  STEER_QUEUED_HINT,
  clearQueuedSteerDeliveryPages,
  isSteerDeliveryQueued,
} from "./steerDelivery.ts";

assert.ok(STEER_QUEUED_HINT.length > 0, "hint copy present");
assert.equal(isSteerDeliveryQueued({ delivery: STEER_DELIVERY_QUEUED }), true);
assert.equal(isSteerDeliveryQueued({ delivery: "done" }), false);
assert.equal(isSteerDeliveryQueued({}), false);

{
  const data = {
    pages: [
      [
        {
          role: "user",
          msg_type: "text",
          content: { text: "hint", delivery: STEER_DELIVERY_QUEUED },
        },
        { role: "agent", msg_type: "text", content: { text: "hi" } },
        {
          role: "user",
          msg_type: "text",
          content: { text: "plain" },
        },
      ],
    ],
    pageParams: [0],
  };
  const next = clearQueuedSteerDeliveryPages(data);
  assert.notEqual(next, data, "new object when changed");
  assert.equal(
    (next.pages[0]![0]!.content as Record<string, unknown>).delivery,
    undefined,
    "queued cleared",
  );
  assert.equal(
    (next.pages[0]![0]!.content as Record<string, unknown>).text,
    "hint",
    "text kept",
  );
  assert.equal(
    (next.pages[0]![2]!.content as Record<string, unknown>).text,
    "plain",
    "non-queued unchanged",
  );
  // Idempotent
  const again = clearQueuedSteerDeliveryPages(next);
  assert.equal(again, next, "no-op when none queued");
}

console.log("ok: steerDelivery helpers");
