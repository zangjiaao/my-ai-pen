/**
 * Intel projection helpers.
 * Run: npx tsx src/lib/intelView.test.ts  (from platform/frontend)
 */
import assert from "node:assert/strict";
import {
  filterIntelRows,
  accessCount,
  hangLabel,
  isIntelNew,
  mergeIntelSnapshot,
  statusFromForgetCount,
  upsertIntelRow,
} from "./intelView.ts";

assert.equal(statusFromForgetCount(0), "active");
assert.equal(statusFromForgetCount(1), "forgotten");
assert.equal(statusFromForgetCount(2), "sealed");

assert.equal(isIntelNew({ created_task_id: "t1" }, "t1"), true);
assert.equal(isIntelNew({ created_task_id: "t1" }, "t2"), false);
assert.equal(isIntelNew({ is_new: true }, "other"), true);
assert.equal(isIntelNew({ is_new: false, created_task_id: "t1" }, "t1"), true, "task match beats stale is_new false");
assert.equal(isIntelNew({ is_new: false, created_task_id: "t1" }, "t2"), false);

const merged = mergeIntelSnapshot(
  [{ id: "live", summary: "just upserted" }, { id: "old", summary: "prev" }],
  [{ id: "old", summary: "from snapshot" }],
);
assert.deepEqual(merged.map((r) => r.id), ["live", "old"]);
assert.equal(merged[1].summary, "from snapshot");
assert.deepEqual(mergeIntelSnapshot([{ id: "x" }], []).map((r) => r.id), ["x"]);

assert.equal(hangLabel({ asset_id: "a", port: "443" }), "a:443");
assert.equal(accessCount({ access_count: 4 }), 4);
assert.equal(accessCount({}), 0);
assert.equal(accessCount({ access_count: -1 }), 0);

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
