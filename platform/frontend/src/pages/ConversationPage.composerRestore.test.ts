/**
 * Spec #474 S2: Case snapshot result coordination.
 * Run: npx tsx src/pages/ConversationPage.composerRestore.test.ts
 */
import assert from "node:assert/strict";
import {
  decideComposerSnapshotAction,
  shouldAcceptComposerChipOverride,
  shouldPollConversationSnapshot,
  shouldReleaseCaseLoadingSkeleton,
} from "../lib/composerCaseRestore";

assert.equal(
  decideComposerSnapshotAction({
    requestedCaseId: "case-a",
    currentCaseId: "case-b",
    outcome: "not_found",
    restoredCaseId: undefined,
  }),
  "ignore",
  "a stale Case A 404 must not clear the current Case B",
);

assert.equal(
  decideComposerSnapshotAction({
    requestedCaseId: "case-a",
    currentCaseId: "case-a",
    outcome: "failure",
    restoredCaseId: undefined,
  }),
  "keep_restore_pending",
  "a transient initial snapshot failure must not complete composer restore",
);

assert.equal(
  decideComposerSnapshotAction({
    requestedCaseId: "case-a",
    currentCaseId: "case-a",
    outcome: "success",
    restoredCaseId: undefined,
  }),
  "state_and_restore",
  "the first later successful snapshot completes pending restore",
);

assert.equal(
  decideComposerSnapshotAction({
    requestedCaseId: "case-a",
    currentCaseId: "case-a",
    outcome: "success",
    restoredCaseId: "case-a",
  }),
  "state_only",
  "heartbeat must not overwrite an already-restored composer",
);

assert.equal(
  decideComposerSnapshotAction({
    requestedCaseId: "case-a",
    currentCaseId: "case-a",
    outcome: "not_found",
    restoredCaseId: undefined,
  }),
  "clear_case",
  "a current Case 404 still clears the missing Case",
);

assert.equal(
  shouldPollConversationSnapshot({
    activeCaseId: "case-a",
    running: false,
    snapshotLoaded: false,
  }),
  true,
  "an idle Case with a failed initial snapshot must retry until restore can complete",
);
assert.equal(
  shouldPollConversationSnapshot({
    activeCaseId: "case-a",
    running: false,
    snapshotLoaded: true,
  }),
  false,
  "an idle Case stops polling after its snapshot loads",
);
assert.equal(
  shouldPollConversationSnapshot({
    activeCaseId: "case-a",
    running: true,
    snapshotLoaded: true,
  }),
  true,
  "a running Case keeps the existing heartbeat",
);

assert.equal(
  shouldReleaseCaseLoadingSkeleton({
    requestSeq: 1,
    latestSeq: 2,
    snapshotAction: "state_and_restore",
  }),
  false,
  "an older same-Case load must not clear the later open's skeleton",
);
assert.equal(
  shouldReleaseCaseLoadingSkeleton({
    requestSeq: 2,
    latestSeq: 2,
    snapshotAction: "keep_restore_pending",
  }),
  false,
  "a transient /state failure keeps the Case skeleton until restore can finish",
);
assert.equal(
  shouldReleaseCaseLoadingSkeleton({
    requestSeq: 2,
    latestSeq: 2,
    snapshotAction: "ignore",
  }),
  false,
  "a stale result must not drop the current Case skeleton",
);
assert.equal(
  shouldReleaseCaseLoadingSkeleton({
    requestSeq: 2,
    latestSeq: 2,
    snapshotAction: "state_and_restore",
  }),
  true,
  "the latest successful open releases the skeleton",
);
assert.equal(
  shouldReleaseCaseLoadingSkeleton({
    requestSeq: 2,
    latestSeq: 2,
    snapshotAction: "clear_case",
  }),
  true,
  "a current Case 404 still releases the skeleton",
);
assert.equal(
  shouldReleaseCaseLoadingSkeleton({
    requestSeq: 3,
    latestSeq: 3,
    snapshotAction: null,
  }),
  true,
  "blank-home open has no pending Case restore",
);

assert.equal(
  shouldAcceptComposerChipOverride({
    activeCaseId: null,
    restoredCaseId: undefined,
  }),
  true,
  "blank-home chip edits are the draft",
);
assert.equal(
  shouldAcceptComposerChipOverride({
    activeCaseId: "case-a",
    restoredCaseId: undefined,
  }),
  false,
  "chip edits must not complete a still-pending Case restore",
);
assert.equal(
  shouldAcceptComposerChipOverride({
    activeCaseId: "case-a",
    restoredCaseId: "case-a",
  }),
  true,
  "after once-on-open, chip edits are operator intent",
);

console.log("ok: ConversationPage.composerRestore.test.ts");
