/**
 * Spec #375 D10 / #384 / #409 — FE Surface panel projects Case surface_ledger only;
 * internal v2 status (seen/touched/booked); operator chips NEW + TESTED (no SEEN/BOOK).
 */
import assert from "node:assert/strict";
import {
  attachFindingsToSurface,
  collectSurfaceEntries,
  emptySurfaceLedger,
  ensureSurfaceLedger,
  isSurfaceNew,
  normalizeSurfaceStatus,
  parseEngagementTargets,
  preferSurfaceStatus,
  projectSurfaceEntriesFromLedger,
  surfaceShowsStatusChip,
  surfaceStatusLabel,
  upsertSurfaceLedger,
  type SurfaceLedger,
} from "./surfaceModel.ts";
import { buildSurfaceTree, surfaceTreeRowChrome } from "../components/SurfaceTreeView.tsx";

function testEmptyLedgerProjectsEmpty() {
  const empty = emptySurfaceLedger();
  assert.equal(projectSurfaceEntriesFromLedger(empty).length, 0);
  assert.equal(projectSurfaceEntriesFromLedger(null).length, 0);
  assert.equal(projectSurfaceEntriesFromLedger(undefined).length, 0);
  assert.equal(projectSurfaceEntriesFromLedger({ version: 1, surfaces: [] }).length, 0);
  assert.deepEqual(ensureSurfaceLedger(null), emptySurfaceLedger());
  // Empty tree / honest empty panel after project.
  assert.equal(buildSurfaceTree([]).length, 0);
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
        status: "seen",
        source: "agent",
      },
      {
        id: "s2",
        origin_key: "ssh://10.0.0.5:22",
        path_key: "",
        location: "ssh://10.0.0.5:22",
        kind: "ssh",
        status: "touched",
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
  assert.equal(login!.status, "seen");

  const ssh = entries.find((e) => e.service === "ssh");
  assert.ok(ssh);
  assert.equal(ssh!.host, "10.0.0.5");
  assert.equal(ssh!.port, "22");
  assert.equal(ssh!.path, "");
  assert.equal(ssh!.status, "touched");
  assert.equal(login!.originKey, "https://lab.example:443");
  assert.equal(ssh!.originKey, "ssh://10.0.0.5:22");

  const tree = buildSurfaceTree(entries);
  assert.equal(tree.length, 2, "web origin and ssh origin are separate roots");
  const labels = tree.map((r) => r.label).sort();
  assert.ok(labels.some((l) => l.includes("https://lab.example:443")));
  assert.ok(labels.some((l) => l.includes("ssh://10.0.0.5:22")));
}

function testLegacyStatusMapsToV2Presentation() {
  // Spec #379 / #384: open→seen, in_probe/probed→touched, booked→booked (internal).
  assert.equal(normalizeSurfaceStatus("open"), "seen");
  assert.equal(normalizeSurfaceStatus("  Open "), "seen");
  assert.equal(normalizeSurfaceStatus("in_probe"), "touched");
  assert.equal(normalizeSurfaceStatus("probed"), "touched");
  assert.equal(normalizeSurfaceStatus("seen"), "seen");
  assert.equal(normalizeSurfaceStatus("touched"), "touched");
  assert.equal(normalizeSurfaceStatus("booked"), "booked");
  assert.equal(normalizeSurfaceStatus("deadend"), "deadend");
  assert.equal(normalizeSurfaceStatus("skipped_roe"), "skipped_roe");
  assert.equal(normalizeSurfaceStatus("nope"), undefined);
  // Spec #409 operator labels (not raw v2 strings).
  assert.equal(surfaceStatusLabel("open"), "");
  assert.equal(surfaceStatusLabel("probed"), "TESTED");
  assert.equal(surfaceStatusLabel("touched"), "TESTED");
  assert.equal(surfaceStatusLabel("booked"), "");

  const ledger: SurfaceLedger = {
    version: 1,
    surfaces: [
      {
        origin_key: "https://legacy.example:443",
        path_key: "/a",
        location: "https://legacy.example/a",
        kind: "url",
        status: "open",
      },
      {
        origin_key: "https://legacy.example:443",
        path_key: "/b",
        location: "https://legacy.example/b",
        kind: "url",
        status: "in_probe",
      },
      {
        origin_key: "https://legacy.example:443",
        path_key: "/c",
        location: "https://legacy.example/c",
        kind: "url",
        status: "probed",
      },
      {
        origin_key: "https://legacy.example:443",
        path_key: "/d",
        location: "https://legacy.example/d",
        kind: "url",
        status: "booked",
      },
    ],
  };
  const entries = projectSurfaceEntriesFromLedger(ledger);
  assert.equal(entries.find((e) => e.path === "/a")!.status, "seen");
  assert.equal(entries.find((e) => e.path === "/b")!.status, "touched");
  assert.equal(entries.find((e) => e.path === "/c")!.status, "touched");
  assert.equal(entries.find((e) => e.path === "/d")!.status, "booked");

  const tree = buildSurfaceTree(entries);
  assert.ok(tree.length >= 1);
  assert.equal(tree[0]!.nodeKind, "origin");
  assert.equal(tree[0]!.label, "https://legacy.example:443");
  // Paths hang directly under origin (no :port intermediate).
  const byPath = new Map(tree[0]!.children.map((c) => [c.path, c]));
  assert.equal(byPath.get("/a")?.status, "seen");
  assert.equal(byPath.get("/b")?.status, "touched");
  assert.equal(byPath.get("/c")?.status, "touched");
  assert.equal(byPath.get("/d")?.status, "booked");
  // Operator: seen quiet, touched → TESTED.
  assert.equal(surfaceStatusLabel(byPath.get("/a")?.status), "");
  assert.equal(surfaceStatusLabel(byPath.get("/b")?.status), "TESTED");
}

/** Spec #409 — operator status label map + NEW false-safe projection. */
function testOperatorStatusProjectionNewTestedNoBook() {
  // Internal normalize stays expand–contract for Graph/gates.
  assert.equal(normalizeSurfaceStatus("seen"), "seen");
  assert.equal(normalizeSurfaceStatus("touched"), "touched");
  assert.equal(normalizeSurfaceStatus("booked"), "booked");

  // Operator chips.
  assert.equal(surfaceStatusLabel("seen"), "");
  assert.equal(surfaceStatusLabel("open"), "");
  assert.equal(surfaceStatusLabel("touched"), "TESTED");
  assert.equal(surfaceStatusLabel("in_probe"), "TESTED");
  assert.equal(surfaceStatusLabel("probed"), "TESTED");
  assert.equal(surfaceStatusLabel("booked"), "");
  assert.equal(surfaceStatusLabel("deadend"), "deadend");
  assert.equal(surfaceStatusLabel("skipped_roe"), "skipped_roe");
  assert.equal(surfaceStatusLabel(undefined), "");
  assert.equal(surfaceStatusLabel("PRIOR"), "");
  assert.equal(surfaceStatusLabel("prior"), "");

  assert.equal(surfaceShowsStatusChip("seen"), false);
  assert.equal(surfaceShowsStatusChip("touched"), true);
  assert.equal(surfaceShowsStatusChip("booked"), false);
  assert.equal(surfaceShowsStatusChip("deadend"), true);

  // NEW false-safe until inventory flag present.
  assert.equal(isSurfaceNew(undefined), false);
  assert.equal(isSurfaceNew({}), false);
  assert.equal(isSurfaceNew({ is_new: false }), false);
  assert.equal(isSurfaceNew({ is_new: true }), true);
  assert.equal(isSurfaceNew({ is_new: "true" }), true);
  assert.equal(isSurfaceNew({ isNew: true }), true);
  assert.equal(isSurfaceNew({ is_new: 0 }), false);

  const ledger: SurfaceLedger = {
    version: 1,
    surfaces: [
      {
        origin_key: "https://op.example:443",
        path_key: "/quiet",
        location: "https://op.example/quiet",
        kind: "url",
        status: "seen",
      },
      {
        origin_key: "https://op.example:443",
        path_key: "/tested",
        location: "https://op.example/tested",
        kind: "url",
        status: "touched",
      },
      {
        origin_key: "https://op.example:443",
        path_key: "/booked",
        location: "https://op.example/booked",
        kind: "url",
        status: "booked",
      },
      {
        origin_key: "https://op.example:443",
        path_key: "/novel",
        location: "https://op.example/novel",
        kind: "url",
        status: "seen",
        is_new: true,
      },
      {
        origin_key: "https://op.example:443",
        path_key: "/old",
        location: "https://op.example/old",
        kind: "url",
        status: "touched",
        is_new: false,
      },
    ],
  };
  const entries = projectSurfaceEntriesFromLedger(ledger);
  assert.equal(entries.find((e) => e.path === "/quiet")!.isNew, undefined);
  assert.equal(entries.find((e) => e.path === "/novel")!.isNew, true);
  assert.equal(entries.find((e) => e.path === "/old")!.isNew, undefined);
  assert.equal(entries.find((e) => e.path === "/old")!.status, "touched");

  const tree = buildSurfaceTree(entries);
  const byPath = new Map(tree[0]!.children.map((c) => [c.path, c]));

  const quietChrome = surfaceTreeRowChrome(byPath.get("/quiet")!, { open: true });
  assert.equal(quietChrome.showStatusChip, false, "seen → no SEEN chip");
  assert.equal(quietChrome.showNewBadge, false);

  const testedChrome = surfaceTreeRowChrome(byPath.get("/tested")!, { open: true });
  assert.equal(testedChrome.showStatusChip, true);
  assert.equal(surfaceStatusLabel(byPath.get("/tested")!.status), "TESTED");
  assert.equal(testedChrome.showNewBadge, false);

  const bookedChrome = surfaceTreeRowChrome(byPath.get("/booked")!, { open: true });
  assert.equal(bookedChrome.showStatusChip, false, "booked → no BOOK chip");
  assert.equal(surfaceStatusLabel(byPath.get("/booked")!.status), "");

  const novelChrome = surfaceTreeRowChrome(byPath.get("/novel")!, { open: true });
  assert.equal(novelChrome.showNewBadge, true);
  assert.equal(novelChrome.showStatusChip, false, "NEW seen row not TESTED yet");
  assert.equal(byPath.get("/novel")!.isNew, true);

  const oldChrome = surfaceTreeRowChrome(byPath.get("/old")!, { open: true });
  assert.equal(oldChrome.showNewBadge, false);
  assert.equal(oldChrome.showStatusChip, true);
  assert.equal(surfaceStatusLabel(byPath.get("/old")!.status), "TESTED");
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
  assert.equal(projectSurfaceEntriesFromLedger(ledger)[0]!.status, "seen");

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
        status: "seen",
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
  // Live status advance: open → in_probe projects as seen → touched.
  assert.equal(entries.find((e) => e.path === "/api/users")!.status, "touched");
  assert.equal(entries.find((e) => e.path === "/api/orders")!.status, "seen");
}

function testLiveUpsertUpdatesStatusDisplayWithoutDowngrade() {
  let ledger = emptySurfaceLedger();
  ledger = upsertSurfaceLedger(ledger, {
    surfaces: [
      {
        origin_key: "https://app.example:443",
        path_key: "/pay",
        location: "https://app.example/pay",
        status: "seen",
      },
    ],
  });
  assert.equal(projectSurfaceEntriesFromLedger(ledger)[0]!.status, "seen");

  ledger = upsertSurfaceLedger(ledger, {
    surfaces: [
      {
        origin_key: "https://app.example:443",
        path_key: "/pay",
        location: "https://app.example/pay",
        status: "touched",
      },
    ],
  });
  assert.equal(projectSurfaceEntriesFromLedger(ledger)[0]!.status, "touched");

  ledger = upsertSurfaceLedger(ledger, {
    surfaces: [
      {
        origin_key: "https://app.example:443",
        path_key: "/pay",
        location: "https://app.example/pay",
        status: "booked",
      },
    ],
  });
  assert.equal(projectSurfaceEntriesFromLedger(ledger)[0]!.status, "booked");

  // Out-of-order lower status must not downgrade display.
  ledger = upsertSurfaceLedger(ledger, {
    surfaces: [
      {
        origin_key: "https://app.example:443",
        path_key: "/pay",
        location: "https://app.example/pay",
        status: "seen",
      },
    ],
  });
  assert.equal(projectSurfaceEntriesFromLedger(ledger)[0]!.status, "booked");
  assert.equal(preferSurfaceStatus("booked", "seen"), "booked");
  assert.equal(preferSurfaceStatus("open", "probed"), "touched");

  const tree = buildSurfaceTree(projectSurfaceEntriesFromLedger(ledger));
  // Paths hang under origin root (scheme://host:port), not under :port.
  const pathNode = tree[0]?.children.find((c) => c.path === "/pay");
  assert.ok(pathNode);
  assert.equal(tree[0]!.nodeKind, "origin");
  // Internal status remains booked for gates; operator chip suppressed (#409).
  assert.equal(pathNode!.status, "booked");
  assert.equal(surfaceStatusLabel(pathNode!.status), "");
  assert.equal(surfaceTreeRowChrome(pathNode!, { open: true }).showStatusChip, false);
}

function testEmptyVsSettledPresentation() {
  // Honest empty when ledger empty (before traffic settle).
  assert.equal(projectSurfaceEntriesFromLedger(emptySurfaceLedger()).length, 0);
  assert.equal(buildSurfaceTree(projectSurfaceEntriesFromLedger(null)).length, 0);

  // After settle-like upserts, rows appear with v2 labels (no asset.urls invent).
  let ledger = emptySurfaceLedger();
  ledger = upsertSurfaceLedger(ledger, {
    updated_at: "settled",
    surfaces: [
      {
        origin_key: "https://target.example:443",
        path_key: "/",
        location: "https://target.example/",
        kind: "url",
        methods: ["GET"],
        status: "seen",
        source: "traffic_settle",
      },
      {
        origin_key: "https://target.example:443",
        path_key: "/login",
        location: "https://target.example/login",
        kind: "url",
        methods: ["GET", "POST"],
        status: "touched",
        source: "traffic_settle",
      },
    ],
  });
  const entries = projectSurfaceEntriesFromLedger(ledger);
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.status === "seen" || e.status === "touched"));
  const tree = buildSurfaceTree(entries);
  assert.equal(tree.length, 1);
  assert.ok(tree[0]!.leafCount >= 2);
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
testLegacyStatusMapsToV2Presentation();
testOperatorStatusProjectionNewTestedNoBook();
testDirtyAssetsDoNotSeedProjection();
testLiveUpsertMergesByIdentity();
testLiveUpsertUpdatesStatusDisplayWithoutDowngrade();
testEmptyVsSettledPresentation();
testFindingsBadgeOnlyMatchingLedgerPaths();
console.log("surfaceModel.ledger.test.ts: ok");
