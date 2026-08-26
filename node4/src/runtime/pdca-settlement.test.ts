/**
 * Spec #519 — Case PDCA overlay + host terminal consistency.
 * Seam: settleParticipantTurn (shared Free / parked contract) + TurnDelta + overlay caps.
 * Run: npx tsx src/runtime/pdca-settlement.test.ts
 */
import assert from "node:assert/strict";
import {
  applyBaseHonestyToGraphStatus,
  computeTurnDelta,
  emptyOverlay,
  evaluateTerminalConsistency,
  formatReplanPrompt,
  mapPdcaVerdictToHarnessStatus,
  pdcaSettleEnabled,
  projectLiveStateOverlay,
  settleParticipantTurn,
  type LiveStateOverlay,
} from "./pdca-settlement.js";

function overlay(partial: Partial<LiveStateOverlay>): LiveStateOverlay {
  return {
    ...emptyOverlay(),
    ...partial,
    surfaces: { ...emptyOverlay().surfaces, ...partial.surfaces },
    hypotheses: { ...emptyOverlay().hypotheses, ...partial.hypotheses },
    findings: { ...emptyOverlay().findings, ...partial.findings },
    packages: { ...emptyOverlay().packages, ...partial.packages },
  };
}

// --- Flag default off ---
assert.equal(pdcaSettleEnabled({}), false);
assert.equal(pdcaSettleEnabled({ NODE4_PDCA_SETTLE: "0" }), false);
assert.equal(pdcaSettleEnabled({ NODE4_PDCA_SETTLE: "1" }), true);

// --- Projection: actionable Surface identities, coverage counts, caps ---
{
  const snap = projectLiveStateOverlay({
    surfaces: [
      { id: "s1", location: "http://t/login", status: "seen", coverage: "untested" },
      { id: "s2", location: "http://t/ok", status: "touched", coverage: "tested" },
      { id: "s3", location: "http://t/skip", status: "seen", coverage: "skipped" },
      { id: "s4", location: "http://t/booked", status: "booked", coverage: "untested" },
    ],
  });
  assert.equal(snap.surfaces.untested, 2);
  assert.equal(snap.surfaces.tested, 1);
  assert.equal(snap.surfaces.skipped, 1);
  assert.equal(snap.surfaces.actionable.length, 1);
  assert.equal(snap.surfaces.actionable[0]!.id, "s1");
}

{
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: `s${i}`,
    location: `http://t/p${i}`,
    status: "seen" as const,
    coverage: "untested" as const,
  }));
  const snap = projectLiveStateOverlay({ surfaces: many });
  assert.equal(snap.surfaces.actionable.length, 12);
  assert.equal(snap.surfaces.omitted, 28);
  assert.equal(snap.surfaces.untested, 40);
}

{
  const manyWorkers = Array.from({ length: 15 }, (_, i) => ({
    id: `w${i}`,
    summary: `worker ${i}`,
  }));
  const snap = projectLiveStateOverlay({ pendingWorkers: manyWorkers });
  assert.equal(snap.pendingWorkerReconciliation.length, 12);
  assert.equal(snap.pendingWorkerOmitted, 3);
}

// --- Natural stop with untested Surface → replan naming that Surface ---
{
  const after = projectLiveStateOverlay({
    surfaces: [{ id: "login", location: "http://t/login", status: "seen", coverage: "untested" }],
  });
  const settled = settleParticipantTurn({ overlay: after });
  assert.equal(settled.verdict, "replan");
  assert.equal(settled.unresolved[0]!.id, "login");
  assert.match(settled.replanPrompt || "", /login/);
  assert.equal(mapPdcaVerdictToHarnessStatus("replan"), "incomplete");
}

// --- Zero Findings + all Surfaces dispositioned → completed ---
{
  const after = projectLiveStateOverlay({
    surfaces: [
      { id: "a", location: "http://t/a", status: "touched", coverage: "tested" },
      { id: "b", location: "http://t/b", status: "seen", coverage: "skipped" },
    ],
    findings: [],
  });
  const settled = settleParticipantTurn({ overlay: after });
  assert.equal(settled.verdict, "completed");
  assert.equal(settled.unresolved.length, 0);
  assert.equal(mapPdcaVerdictToHarnessStatus("completed"), "completed");
}

// --- Empty overlay (no named work) → accept stop; Finding count is not success ---
{
  const settled = settleParticipantTurn({ overlay: emptyOverlay() });
  assert.equal(settled.verdict, "completed");
}

// --- Running Package / pending Worker / feedback_ok / active Hypothesis block completed ---
{
  assert.equal(
    evaluateTerminalConsistency({
      overlay: overlay({
        packages: { running: [{ kind: "package", id: "pkg-1" }], omitted: 0 },
      }),
    }).verdict,
    "replan",
  );
  assert.equal(
    evaluateTerminalConsistency({
      overlay: overlay({
        pendingWorkerReconciliation: [{ kind: "worker", id: "w1", summary: "ready_to_book" }],
      }),
    }).verdict,
    "replan",
  );
  assert.equal(
    evaluateTerminalConsistency({
      overlay: overlay({
        findings: {
          booked: 0,
          feedbackOkUnbooked: [{ kind: "finding", id: "f-ok" }],
          omitted: 0,
        },
      }),
    }).verdict,
    "replan",
  );
  assert.equal(
    evaluateTerminalConsistency({
      overlay: overlay({
        hypotheses: {
          active: [{ kind: "hypothesis", id: "h1", summary: "SQLi on /login" }],
          deferred: [],
          omitted: 0,
        },
      }),
    }).verdict,
    "replan",
  );
}

// --- Pending user decision → paused, not completed/blocked ---
{
  const settled = settleParticipantTurn({
    overlay: overlay({ pendingUserDecision: true }),
  });
  assert.equal(settled.verdict, "paused");
  assert.equal(mapPdcaVerdictToHarnessStatus("paused"), "incomplete");
}

// --- Abort is incomplete, not completed ---
{
  const settled = settleParticipantTurn({
    overlay: emptyOverlay(),
    aborted: true,
  });
  assert.equal(settled.verdict, "incomplete");
}

// --- Open todos alone do not block completed ---
{
  const settled = settleParticipantTurn({
    overlay: overlay({ todos: { open: 5 } }),
  });
  assert.equal(settled.verdict, "completed");
}

// --- TurnDelta is named entity changes, not a full dump ---
{
  const before = projectLiveStateOverlay({
    surfaces: [{ id: "s1", location: "http://t/a", status: "seen", coverage: "untested" }],
  });
  const after = projectLiveStateOverlay({
    surfaces: [{ id: "s1", location: "http://t/a", status: "touched", coverage: "tested" }],
  });
  const delta = computeTurnDelta(before, after);
  assert.ok(delta.entries.some((e) => e.entity_id === "s1"));
  assert.ok(delta.entries.length < 20);
  const dump = JSON.stringify(after);
  assert.ok(JSON.stringify(delta).length < dump.length);
  const noOp = computeTurnDelta(after, after);
  assert.equal(noOp.entries.length, 0, "pre/post same snapshot is not an added-everything dump");
}

// --- High-value new Finding in delta; still replan if Surface remains ---
{
  const before = projectLiveStateOverlay({
    surfaces: [{ id: "s1", location: "http://t/a", status: "seen", coverage: "untested" }],
  });
  const after = projectLiveStateOverlay({
    surfaces: [{ id: "s1", location: "http://t/a", status: "seen", coverage: "untested" }],
    findings: [{ id: "f1", status: "booked", title: "RCE" }],
  });
  const settled = settleParticipantTurn({ overlay: after, previousOverlay: before });
  assert.equal(settled.verdict, "replan");
  assert.ok(settled.delta.entries.length > 0);
}

// --- Repeated no-delta natural stops exhaust budget → incomplete with named residuals ---
{
  const after = projectLiveStateOverlay({
    surfaces: [{ id: "s1", location: "http://t/login", status: "seen", coverage: "untested" }],
  });
  const first = settleParticipantTurn({
    overlay: after,
    previousOverlay: after,
    noProgressStreak: 0,
    maxNoProgress: 2,
  });
  assert.equal(first.verdict, "replan");
  const second = settleParticipantTurn({
    overlay: after,
    previousOverlay: after,
    noProgressStreak: first.nextNoProgressStreak,
    maxNoProgress: 2,
  });
  assert.equal(second.verdict, "blocked");
  assert.ok(second.unresolved.some((u) => u.id === "s1"));
  assert.equal(mapPdcaVerdictToHarnessStatus("blocked"), "blocked");
}

// --- Cold Free and parked continue share the same verdict for equivalent state ---
{
  const snap = projectLiveStateOverlay({
    surfaces: [{ id: "s1", location: "http://t/login", status: "seen", coverage: "untested" }],
    findings: [{ id: "f1", status: "booked", title: "XSS" }],
  });
  const cold = settleParticipantTurn({ overlay: snap });
  const parked = settleParticipantTurn({ overlay: snap });
  assert.deepEqual(cold.verdict, parked.verdict);
  assert.deepEqual(
    cold.unresolved.map((u) => u.id),
    parked.unresolved.map((u) => u.id),
  );
}

// --- Replan prompt names identities; does not dump the overlay JSON ---
{
  const after = projectLiveStateOverlay({
    surfaces: [{ id: "login", location: "http://t/login", status: "seen", coverage: "untested" }],
  });
  const settled = settleParticipantTurn({ overlay: after });
  const prompt = formatReplanPrompt(settled.delta, settled.unresolved);
  assert.match(prompt, /login/);
  assert.doesNotMatch(prompt, /"untested":\s*1/);
}

// --- Graph may not complete when base honesty still has unresolved work ---
{
  assert.equal(
    applyBaseHonestyToGraphStatus(
      "completed",
      overlay({
        findings: {
          booked: 2,
          feedbackOkUnbooked: [{ kind: "finding", id: "f-ok" }],
          omitted: 0,
        },
      }),
    ),
    "incomplete",
  );
  assert.equal(applyBaseHonestyToGraphStatus("blocked", emptyOverlay()), "blocked");
  assert.equal(applyBaseHonestyToGraphStatus("completed", emptyOverlay()), "completed");
  assert.equal(
    applyBaseHonestyToGraphStatus("completed", overlay({ pendingUserDecision: true })),
    "incomplete",
  );
}

// --- Worker ready_to_book without matching booked Finding is pending reconciliation ---
{
  const snap = projectLiveStateOverlay({
    pendingWorkers: [{ id: "w-login", summary: "ready_to_book XSS" }],
    findings: [{ id: "other", status: "booked", title: "other" }],
  });
  assert.equal(snap.pendingWorkerReconciliation.length, 1);
  assert.equal(settleParticipantTurn({ overlay: snap }).verdict, "replan");
}

console.log("pdca-settlement.test.ts: ok");
