/**
 * Spec #375 D10 — FE Surface panel projects Case surface_ledger only.
 */
import assert from "node:assert/strict";
import {
  attachFindingsToSurface,
  collectSurfaceEntries,
  emptySurfaceLedger,
  ensureSurfaceLedger,
  parseEngagementTargets,
  projectSurfaceEntriesFromLedger,
  upsertSurfaceLedger,
  type SurfaceLedger,
} from "./surfaceModel.ts";

function testEmptyLedgerProjectsEmpty() {
  const empty = emptySurfaceLedger();
  assert.equal(projectSurfaceEntriesFromLedger(empty).length, 0);
  assert.equal(projectSurfaceEntriesFromLedger(null).length, 0);
  assert.equal(projectSurfaceEntriesFromLedger(undefined).length, 0);
  assert.equal(projectSurfaceEntriesFromLedger({ version: 1, surfaces: [] }).length, 0);
  assert.deepEqual(ensureSurfaceLedger(null), emptySurfaceLedger());
}

function testLedgerRowsProjectToInventory() {
  const ledger: SurfaceLedger = {
    version: 1,
    updated_at: "2026-08-10T00:00:00Z",
    surfaces: [
      {
        id: "s1",
        origin_key: "https://lab.example:443",
        path_key: "/login",
        location: "https://lab.example/login",
        kind: "url",
        methods: ["GET", "POST"],
        status: "open",
        source: "agent",
      },
      {
        id: "s2",
        origin_key: "ssh://10.0.0.5:22",
        path_key: "",
        location: "ssh://10.0.0.5:22",
        kind: "ssh",
        status: "probed",
        source: "agent",
      },
    ],
  };
  const entries = projectSurfaceEntriesFromLedger(ledger);
  assert.equal(entries.length, 2);
  const login = entries.find((e) => e.path === "/login");
  assert.ok(login);
  assert.equal(login!.host, "lab.example");
  assert.equal(login!.port, "443");
  assert.equal(login!.service, "web");
  assert.ok(String(login!.method || "").includes("GET"));
  assert.ok(String(login!.method || "").includes("POST"));
  assert.equal(login!.status, "open");

  const ssh = entries.find((e) => e.service === "ssh");
  assert.ok(ssh);
  assert.equal(ssh!.host, "10.0.0.5");
  assert.equal(ssh!.port, "22");
  assert.equal(ssh!.path, "");
  assert.equal(ssh!.status, "probed");
}

function testDirtyAssetsDoNotSeedProjection() {
  // Historical SoT merged assets.urls + plan + targets — D10 forbids that for Surface inventory.
  const dirtyAssets = [
    {
      id: "asset-1",
      address: "lab.example",
      properties: {
        urls: [
          "http://lab.example:8080/dvwa",
          "http://lab.example:8080/juice",
          "https://other-lab.example/admin",
        ],
      },
    },
  ];
  const planTree = [
    {
      kind: "surface",
      level: "work_item" as const,
      endpoint: "https://plan-only.example/path",
      title: "plan surface",
    },
  ];
  const targets = parseEngagementTargets({ target: "https://lab.example:3000" });
  const legacy = collectSurfaceEntries(planTree, dirtyAssets, [], targets);
  assert.ok(legacy.length > 0, "legacy collector still sees asset/plan/target noise");

  const emptyLedger = emptySurfaceLedger();
  const projected = projectSurfaceEntriesFromLedger(emptyLedger);
  assert.equal(projected.length, 0, "empty ledger must project empty even when assets/plan/targets exist");
}

function testLiveUpsertMergesByIdentity() {
  let ledger = emptySurfaceLedger();
  ledger = upsertSurfaceLedger(ledger, {
    updated_at: "t1",
    surfaces: [
      {
        origin_key: "https://app.example:443",
        path_key: "/api/users",
        methods: ["GET"],
        status: "open",
        location: "https://app.example/api/users",
      },
    ],
  });
  assert.equal(ledger.surfaces.length, 1);
  assert.equal(projectSurfaceEntriesFromLedger(ledger).length, 1);

  ledger = upsertSurfaceLedger(ledger, {
    updated_at: "t2",
    surfaces: [
      {
        origin_key: "https://app.example:443",
        path_key: "/api/users",
        methods: ["POST"],
        status: "in_probe",
        location: "https://app.example/api/users",
      },
      {
        origin_key: "https://app.example:443",
        path_key: "/api/orders",
        methods: ["GET"],
        status: "open",
        location: "https://app.example/api/orders",
      },
    ],
  });
  assert.equal(ledger.surfaces.length, 2);
  assert.equal(ledger.updated_at, "t2");
  const users = ledger.surfaces.find((s) => s.path_key === "/api/users");
  assert.ok(users);
  assert.ok((users!.methods || []).includes("GET"));
  assert.ok((users!.methods || []).includes("POST"));

  const entries = projectSurfaceEntriesFromLedger(ledger);
  assert.equal(entries.length, 2);
  assert.ok(entries.some((e) => e.path === "/api/users"));
  assert.ok(entries.some((e) => e.path === "/api/orders"));
}

function testFindingsBadgeOnlyMatchingLedgerPaths() {
  const ledger: SurfaceLedger = {
    version: 1,
    surfaces: [
      {
        origin_key: "https://lab.example:443",
        path_key: "/login",
        location: "https://lab.example/login",
        kind: "url",
      },
    ],
  };
  const entries = projectSurfaceEntriesFromLedger(ledger);
  const keys = entries.map((e) => e.key);
  const findings = [
    {
      id: "f1",
      title: "SQLi on login",
      location: "https://lab.example/login",
      severity: "high",
    },
    {
      id: "f2",
      title: "XSS elsewhere",
      location: "https://lab.example/not-in-ledger",
      severity: "medium",
    },
  ];
  const attached = attachFindingsToSurface(findings, keys, entries);
  assert.equal(attached.linkedUnique, 1);
  assert.equal(attached.unlinked.length, 1);
  // Must not invent inventory for the unlinked finding path.
  assert.equal(projectSurfaceEntriesFromLedger(ledger).length, 1);
  assert.equal(entries.length, 1);
}

testEmptyLedgerProjectsEmpty();
testLedgerRowsProjectToInventory();
testDirtyAssetsDoNotSeedProjection();
testLiveUpsertMergesByIdentity();
testFindingsBadgeOnlyMatchingLedgerPaths();
console.log("surfaceModel.ledger.test.ts: ok");
