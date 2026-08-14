/**
 * Intel projection helpers.
 * Run: npx tsx src/lib/intelView.test.ts  (from platform/frontend)
 */
import assert from "node:assert/strict";
import {
  filterIntelRows,
  hangLabel,
  isIntelNew,
  statusFromForgetCount,
  upsertIntelRow,
} from "./intelView.ts";

assert.equal(statusFromForgetCount(0), "active");
assert.equal(statusFromForgetCount(1), "forgotten");
assert.equal(statusFromForgetCount(2), "sealed");

assert.equal(isIntelNew({ created_task_id: "t1" }, "t1"), true);
assert.equal(isIntelNew({ created_task_id: "t1" }, "t2"), false);
assert.equal(isIntelNew({ is_new: true }, "other"), true);

assert.equal(hangLabel({ asset_id: "a", port: "443" }), "a:443");

const living = filterIntelRows(
  [
    { id: "1", forget_count: 0, summary: "live" },
    { id: "2", forget_count: 1, summary: "soft" },
    { id: "3", forget_count: 2, summary: "seal" },
  ],
  "active",
);
assert.deepEqual(living.map((r) => r.id), ["1"]);
assert.deepEqual(filterIntelRows(living.concat([{ id: "3", status: "sealed" }]), "sealed").map((r) => r.id), ["3"]);

const upserted = upsertIntelRow([{ id: "1", summary: "old" }], { id: "1", summary: "new", forget_count: 1 });
assert.equal(upserted[0].summary, "new");
assert.equal(upserted.length, 1);

console.log("intelView.test.ts: all ok");
