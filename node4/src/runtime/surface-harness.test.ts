/**
 * Spec #407 — soft Surface SEEN stop/mid-run reminders (no settlement hard gate).
 */
import assert from "node:assert/strict";
import {
  incompleteSeenSurfaceStopReminder,
  midRunSeenSurfaceNudge,
} from "./surface-harness.js";
import { composeContinuePrompt } from "./loop-policy.js";

assert.equal(incompleteSeenSurfaceStopReminder(0), "", "no stop reminder when no seen");
assert.equal(midRunSeenSurfaceNudge(0), "", "no mid-run when no seen");

const stop = incompleteSeenSurfaceStopReminder(3, ["/api/a", "/rest/b"], 1, 3);
assert.match(stop, /still at \*\*seen\*\*/i, "stop names seen status");
assert.match(stop, /\/api\/a/, "stop lists sample paths");
assert.match(stop, /surface\(summary\|list\)/i, "stop points at surface tool");
assert.match(stop, /never blocks booking or settlement/i, "soft — no hard gate language inverted");
assert.match(stop, /Reminder 1\/3/, "attempt counter");

const mid = midRunSeenSurfaceNudge(5);
assert.match(mid, /5 Surface/, "mid-run count");
assert.match(mid, /seen/i, "mid-run seen vocabulary");
assert.match(mid, /surface\(summary\|list\)/i, "mid-run tool pointer");

const composedStop = composeContinuePrompt({
  attempt: 1,
  max: 3,
  openTodoCount: 0,
  openSeenSurfaceCount: 2,
  openSeenSurfaceSamples: ["/ftp"],
  kind: "empty",
});
assert.match(composedStop, /still at \*\*seen\*\*/i, "empty stop includes seen reminder");
assert.match(composedStop, /\/ftp/, "empty stop includes sample");

const composedMid = composeContinuePrompt({
  attempt: 1,
  max: 3,
  openTodoCount: 0,
  openSeenSurfaceCount: 4,
  kind: "goal",
  goalContinuationBody: "continue goals",
});
assert.match(composedMid, /Gentle reminder.*seen/i, "non-empty continue gets mid-run seen nudge");

const noSeen = composeContinuePrompt({
  attempt: 1,
  max: 3,
  openTodoCount: 0,
  openSeenSurfaceCount: 0,
  kind: "empty",
});
assert.equal(noSeen.includes("still at **seen**"), false, "no seen → no surface reminder");

// Both todo + seen may appear; neither hard-blocks
const both = composeContinuePrompt({
  attempt: 1,
  max: 3,
  openTodoCount: 2,
  openTodoTitles: ["recon"],
  openSeenSurfaceCount: 1,
  openSeenSurfaceSamples: ["/x"],
  kind: "empty",
});
assert.match(both, /incomplete todo/i, "todo stop still present");
assert.match(both, /still at \*\*seen\*\*/i, "seen stop still present");

console.log("surface-harness.test.ts: ok");
