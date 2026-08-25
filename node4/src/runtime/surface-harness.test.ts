/**
 * Spec #411 — soft Surface NEW untested stop/mid-run reminders (no settlement hard gate).
 */
import assert from "node:assert/strict";
import {
  incompleteNewUntestedSurfaceStopReminder,
  midRunNewUntestedSurfaceNudge,
  selectNewUntestedSurfaces,
  incompleteSeenSurfaceStopReminder,
  midRunSeenSurfaceNudge,
} from "./surface-harness.js";
import { composeContinuePrompt } from "./loop-policy.js";

assert.equal(incompleteNewUntestedSurfaceStopReminder(0), "", "no stop reminder when empty");
assert.equal(midRunNewUntestedSurfaceNudge(0), "", "no mid-run when empty");

const stop = incompleteNewUntestedSurfaceStopReminder(3, ["/api/a", "/rest/b"], 1, 3);
assert.match(stop, /NEW untested/i, "stop names NEW untested");
assert.match(stop, /TESTED/i, "stop names TESTED duty");
assert.match(stop, /\/api\/a/, "stop lists sample paths");
assert.match(stop, /surface\(summary\|list\)/i, "stop points at surface tool");
assert.match(stop, /never blocks booking or settlement/i, "soft — no hard gate");
assert.match(stop, /priors alone ≠ this-Case TESTED|priors alone/i, "priors ≠ coverage");
assert.match(stop, /Reminder 1\/3/, "attempt counter");

const mid = midRunNewUntestedSurfaceNudge(5);
assert.match(mid, /5 Surface/, "mid-run count");
assert.match(mid, /NEW untested/i, "mid-run NEW vocabulary");
assert.match(mid, /surface\(summary\|list\)/i, "mid-run tool pointer");
assert.match(mid, /priors/i, "mid-run priors note");

// Deprecated aliases still work (emit NEW copy)
assert.match(incompleteSeenSurfaceStopReminder(1, ["/x"]), /NEW untested/i);
assert.match(midRunSeenSurfaceNudge(2), /NEW untested/i);

// --- selectNewUntestedSurfaces: untested = coverage not tested/skipped (#518) ---
{
  const fallback = selectNewUntestedSurfaces([
    { status: "seen", path_key: "/a" },
    { status: "touched", path_key: "/b" },
    { status: "seen", path_key: "/c" },
  ]);
  assert.equal(fallback.mode, "seen_fallback");
  assert.equal(fallback.count, 3);
  assert.deepEqual(fallback.samples, ["/a", "/b", "/c"]);
}

{
  const purpose = selectNewUntestedSurfaces([
    { status: "seen", coverage: "untested", path_key: "/browse" },
    { status: "touched", coverage: "untested", path_key: "/browse2" },
    { status: "touched", coverage: "tested", path_key: "/tested" },
    { status: "seen", coverage: "skipped", path_key: "/skip" },
  ]);
  assert.equal(purpose.mode, "seen_fallback");
  assert.equal(purpose.count, 2, "untested coverage only");
  assert.deepEqual(purpose.samples, ["/browse", "/browse2"]);
}

{
  const withNew = selectNewUntestedSurfaces([
    { status: "seen", is_new: true, coverage: "untested", path_key: "/novel" },
    { status: "seen", is_new: false, coverage: "untested", path_key: "/old" },
    { status: "touched", is_new: true, coverage: "tested", path_key: "/tested-new" },
    { status: "seen", is_new: true, coverage: "untested", path_key: "/novel2" },
  ]);
  assert.equal(withNew.mode, "new_untested");
  assert.equal(withNew.count, 2, "only is_new && untested");
  assert.deepEqual(withNew.samples, ["/novel", "/novel2"]);
}

const composedStop = composeContinuePrompt({
  attempt: 1,
  max: 3,
  openTodoCount: 0,
  openNewUntestedSurfaceCount: 2,
  openNewUntestedSurfaceSamples: ["/ftp"],
  kind: "empty",
});
assert.match(composedStop, /NEW untested/i, "empty stop includes NEW reminder");
assert.match(composedStop, /\/ftp/, "empty stop includes sample");
assert.ok(!composedStop.includes("<system-reminder>"), "continue is markdown, not XML");
assert.match(composedStop, /### Continue/, "empty stop uses Continue heading");

// Legacy option names still compose
const legacyOpts = composeContinuePrompt({
  attempt: 1,
  max: 3,
  openTodoCount: 0,
  openSeenSurfaceCount: 1,
  openSeenSurfaceSamples: ["/legacy"],
  kind: "empty",
});
assert.match(legacyOpts, /NEW untested/i, "legacy openSeenSurfaceCount still wired");
assert.match(legacyOpts, /\/legacy/, "legacy sample");

const composedMid = composeContinuePrompt({
  attempt: 1,
  max: 3,
  openTodoCount: 0,
  openNewUntestedSurfaceCount: 4,
  kind: "goal",
  goalContinuationBody: "continue goals",
});
assert.match(composedMid, /Gentle reminder.*NEW untested/i, "non-empty continue gets mid-run nudge");

const noNew = composeContinuePrompt({
  attempt: 1,
  max: 3,
  openTodoCount: 0,
  openNewUntestedSurfaceCount: 0,
  kind: "empty",
});
assert.equal(noNew.includes("NEW untested"), false, "zero queue → no surface reminder");

// Both todo + NEW may appear; neither hard-blocks
const both = composeContinuePrompt({
  attempt: 1,
  max: 3,
  openTodoCount: 2,
  openTodoTitles: ["recon"],
  openNewUntestedSurfaceCount: 1,
  openNewUntestedSurfaceSamples: ["/x"],
  kind: "empty",
});
assert.match(both, /incomplete todo/i, "todo stop still present");
assert.match(both, /NEW untested/i, "NEW stop still present");

console.log("surface-harness.test.ts: ok");
