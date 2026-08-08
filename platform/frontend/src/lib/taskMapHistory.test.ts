/**
 * Spec #321 S3 FE helpers — history view isolation + selection policy.
 * Run: npx tsx src/lib/taskMapHistory.test.ts
 */
import assert from "node:assert/strict";
import {
  isLiveRevision,
  isViewingHistory,
  nextViewedRevisionId,
  normalizeTaskMapRevisions,
  planTreeForView,
  revisionDisplayLabel,
} from "./taskMapHistory.js";

const liveTree = [{ node_id: "l1", title: "Live", status: "running", level: "work_item" }];
const histTree = [{ node_id: "h1", title: "Old", status: "done", level: "work_item" }];
const aliceTree = [{ node_id: "a1", title: "Alice map", status: "done", level: "work_item" }];

const revs = normalizeTaskMapRevisions([
  {
    id: "tm-1",
    label: "Free · done",
    is_live: false,
    plan_tree: histTree,
    done: 1,
    total: 1,
  },
  {
    id: "tm-2",
    is_live: true,
    work_mode: "free",
    plan_tree: liveTree,
    done: 0,
    total: 1,
  },
]);
assert.equal(revs.length, 2);
assert.equal(revisionDisplayLabel(revs[0]!), "Free · done");

assert.equal(isViewingHistory(null, "tm-2"), false);
assert.equal(isViewingHistory("tm-2", "tm-2"), false);
assert.equal(isViewingHistory("tm-1", "tm-2"), true);

const liveView = planTreeForView({
  planTree: liveTree as any,
  revisions: revs,
  liveRevisionId: "tm-2",
  viewedRevisionId: null,
});
assert.equal(liveView[0]!.title, "Live");

const histView = planTreeForView({
  planTree: liveTree as any,
  revisions: revs,
  liveRevisionId: "tm-2",
  viewedRevisionId: "tm-1",
});
assert.equal(histView[0]!.title, "Old");

// Live plan tree change does not affect historical payload in revs
const liveView2 = planTreeForView({
  planTree: [{ node_id: "l1", title: "Live updated", status: "done", level: "work_item" }] as any,
  revisions: revs,
  liveRevisionId: "tm-2",
  viewedRevisionId: "tm-1",
});
assert.equal(liveView2[0]!.title, "Old", "history selection stays on frozen plan_tree");

// B2: Case live_revision_id is canonical — stale is_live on another row ignored
const multi = normalizeTaskMapRevisions([
  {
    id: "tm-alice",
    is_live: true, // stale multi-role flag
    plan_tree: aliceTree,
  },
  {
    id: "tm-bob",
    is_live: true,
    plan_tree: liveTree,
  },
]);
assert.equal(isLiveRevision(multi[0], "tm-bob"), false, "Alice is not Case live");
assert.equal(isLiveRevision(multi[1], "tm-bob"), true);
const aliceView = planTreeForView({
  planTree: liveTree as any,
  revisions: multi,
  liveRevisionId: "tm-bob",
  viewedRevisionId: "tm-alice",
});
assert.equal(aliceView[0]!.title, "Alice map", "history uses Alice frozen tree not Bob live");

// B1: selection policy — was on live → follow new live after archive
assert.equal(
  nextViewedRevisionId({
    prevViewedId: "tm-1",
    prevLiveId: "tm-1",
    nextLiveId: "tm-2",
    revisions: revs,
  }),
  "tm-2",
  "was on live → follow new live",
);

// was viewing history → keep history
assert.equal(
  nextViewedRevisionId({
    prevViewedId: "tm-1",
    prevLiveId: "tm-2",
    nextLiveId: "tm-3",
    revisions: [
      ...revs,
      { id: "tm-3", is_live: true, plan_tree: liveTree as any },
    ],
  }),
  "tm-1",
  "intentional history stickiness",
);

// history id gone → fall back to live
assert.equal(
  nextViewedRevisionId({
    prevViewedId: "tm-gone",
    prevLiveId: "tm-2",
    nextLiveId: "tm-2",
    revisions: revs,
  }),
  "tm-2",
  "missing history falls back to live",
);

console.log("taskMapHistory.test.ts: ok");
