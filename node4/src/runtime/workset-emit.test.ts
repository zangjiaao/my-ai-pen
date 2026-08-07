/**
 * Spec #311 — settle → Workset emit (free + Hard) unit seam.
 */
import assert from "node:assert/strict";
import {
  filterEmitableWorksetCandidates,
  worksetCandidatesFromAttackSurface,
  worksetCandidatesFromHardSettle,
} from "./workset-emit.js";
import type { AttackSurfaceCandidate } from "./attack-surface.js";

const task = {
  target: { type: "url", value: "http://target.local/" },
  scope: { allow: ["http://target.local/"], deny: [] },
};

// --- Free path ---
const freeCands: AttackSurfaceCandidate[] = [
  {
    host: "side.lab",
    port: "443",
    urls: ["https://side.lab/"],
    source: "finding_location",
    in_scope: false,
  },
  {
    host: "target.local",
    urls: ["http://target.local/admin"],
    source: "finding_location",
    in_scope: true,
  },
];

const freeWs = filterEmitableWorksetCandidates(
  worksetCandidatesFromAttackSurface(freeCands, { source: "free_settle" }),
);
assert.ok(freeWs.some((c) => c.family === "t_host" && c.host === "side.lab"));
assert.ok(freeWs.some((c) => c.family === "t_surface" && c.in_scope === true));
assert.ok(freeWs.every((c) => c.source === "free_settle"));

// Hollow host rejected by filter
assert.deepEqual(
  filterEmitableWorksetCandidates([
    {
      family: "t_host",
      title: "",
      host: "",
      in_scope: false,
      source: "x",
    },
  ]),
  [],
);

// --- Hard path ---
const hardWs = filterEmitableWorksetCandidates(
  worksetCandidatesFromHardSettle({
    task,
    openSurfaces: [
      {
        id: "/login",
        location: "http://target.local/login",
        path_key: "/login",
        status: "open",
        updated_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "/admin",
        location: "http://target.local/admin",
        path_key: "/admin",
        status: "in_probe",
        updated_at: "2026-01-01T00:00:01Z",
      },
    ],
    locationStrings: [
      "http://target.local/login",
      "https://oos.evil/x",
    ],
    source: "hard_settle",
  }),
);

assert.ok(
  hardWs.some((c) => c.family === "t_surface" && c.path_key === "/login"),
  "open surface → t_surface",
);
assert.ok(
  hardWs.some((c) => c.family === "t_host" && c.host === "oos.evil"),
  "OOS finding host → t_host",
);
assert.ok(hardWs.every((c) => c.source === "hard_settle"));

// Invalid empty surface filtered
assert.equal(
  filterEmitableWorksetCandidates([
    {
      family: "t_surface",
      title: "x",
      location: "/",
      in_scope: true,
      source: "hard_settle",
    },
  ]).length,
  0,
  "single-char path non-executable",
);

console.log("workset-emit.test.ts: ok");
