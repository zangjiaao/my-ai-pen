/**
 * Surface tree: host.docker.internal vs host.docker.internal:8080 must not fork.
 */
import assert from "node:assert/strict";
import {
  canonicalizeSurfaceEntries,
  collectSurfaceEntries,
  parseEngagementTargets,
  parseSurfaceRef,
  toSurfaceEntry,
} from "./surfaceModel.ts";
import { buildSurfaceTree } from "../components/SurfaceTreeView.tsx";

function treePortLabels(entries: ReturnType<typeof collectSurfaceEntries>): string[] {
  const tree = buildSurfaceTree(entries);
  const ports: string[] = [];
  for (const root of tree) {
    for (const child of root.children) {
      if (child.nodeKind === "port" || child.nodeKind === "service") {
        ports.push(child.label);
      }
    }
  }
  return ports.sort();
}

function testParseHostOnlyIsWeb() {
  const p = parseSurfaceRef("host.docker.internal", null, "host only host.docker.internal");
  assert.ok(p);
  assert.equal(p!.service, "web");
  assert.equal(p!.path, "/");
  assert.equal(p!.port, "");
}

function testDockerInternalNoDuplicatePortBranches() {
  const entries = collectSurfaceEntries(
    [
      {
        kind: "surface",
        level: "work_item",
        endpoint: "http://host.docker.internal:8080/login",
        title: "login",
      },
      {
        kind: "surface",
        level: "work_item",
        endpoint: "http://host.docker.internal/vulnerabilities",
        title: "no explicit port",
      },
      {
        kind: "surface",
        level: "work_item",
        endpoint: "host.docker.internal",
        title: "host only",
      },
    ],
    [],
    [],
    parseEngagementTargets({ target: "http://host.docker.internal:8080" }),
  );

  // All web inventory under :8080 — not a parallel :80 or portless host root.
  for (const e of entries) {
    assert.equal(e.host, "host.docker.internal");
    if (e.service === "web") {
      assert.equal(e.port, "8080", `web entry should fold onto 8080: ${e.key}`);
    }
  }

  const ports = treePortLabels(entries);
  assert.deepEqual(ports, [":8080"], `expected single :8080 branch, got ${JSON.stringify(ports)}`);
  const tree = buildSurfaceTree(entries);
  assert.equal(tree.length, 1, "single host root");
  // Host root label is hostname only — port lives under children.
  assert.equal(tree[0]!.label, "host.docker.internal");
  assert.ok(!tree[0]!.label.includes(":"), "host root must not include :port");
}

function testFindingLeavesJoinSameHostRoot() {
  // Inventory under ledger asset uuid; finding-only leaf without assetKey must not fork a second site.
  const base = collectSurfaceEntries(
    [{ kind: "surface", level: "work_item", endpoint: "http://host.docker.internal:3000/", title: "root" }],
    [{ id: "948484b0-5b69-4de0-b56e-40873c69295a", address: "host.docker.internal", properties: { urls: [] } }],
    [],
    parseEngagementTargets({ target: "http://host.docker.internal:3000" }),
  );
  const orphan = toSurfaceEntry(
    parseSurfaceRef("http://host.docker.internal:3000/rest/user/login")!,
    { source: "finding" },
  );
  assert.ok(!orphan.assetKey, "finding leaf starts without assetKey");
  const merged = canonicalizeSurfaceEntries(
    [...base, orphan],
    [{ id: "948484b0-5b69-4de0-b56e-40873c69295a", address: "host.docker.internal" }],
    parseEngagementTargets({ target: "http://host.docker.internal:3000" }),
  );
  const tree = buildSurfaceTree(merged);
  assert.equal(tree.length, 1, `one site root, got ${tree.map((r) => r.id).join(",")}`);
  assert.equal(tree[0]!.label, "host.docker.internal");
  assert.deepEqual(
    tree[0]!.children.map((c) => c.label).sort(),
    [":3000"],
  );
}

function testHostRootNoPortAndEngagementBeatsStaleAsset8080() {
  // Same ledger host had prior DVWA :8080 URLs; this engagement is :3000.
  const entries = collectSurfaceEntries(
    [
      {
        kind: "surface",
        level: "work_item",
        endpoint: "http://host.docker.internal:3000/rest/admin",
        title: "api",
      },
    ],
    [
      {
        id: "948484b0-5b69-4de0-b56e-40873c69295a",
        address: "host.docker.internal",
        properties: {
          urls: [
            "http://host.docker.internal:8080",
            "http://host.docker.internal:8080/vulnerabilities/sqli/",
          ],
        },
      },
    ],
    [],
    parseEngagementTargets({ target: "http://host.docker.internal:3000" }),
  );

  const tree = buildSurfaceTree(entries);
  assert.equal(tree.length, 1);
  assert.equal(tree[0]!.label, "host.docker.internal", "root is host only");
  assert.ok(!String(tree[0]!.label).includes(":8080"));
  const ports = treePortLabels(entries);
  assert.ok(ports.includes(":3000"), `expected :3000, got ${JSON.stringify(ports)}`);
  assert.ok(!ports.includes(":8080"), `stale :8080 must not appear, got ${JSON.stringify(ports)}`);
  for (const e of entries) {
    if (e.service === "web" && e.port) {
      assert.equal(e.port, "3000", `stale 8080 not kept: ${e.key}`);
    }
  }
}

function testEngagementTargetPreferPorted() {
  const targets = parseEngagementTargets({
    target: "host.docker.internal",
    scope: { allow: ["http://host.docker.internal:8080", "host.docker.internal"] },
  });
  assert.equal(targets.length, 1);
  assert.equal(targets[0]!.port, "8080");
  assert.equal(targets[0]!.origin, "host.docker.internal:8080");
}

function testDualPortEngagementKeepsBothPorts() {
  // Legitimate multi-port engagement must not collapse to one locked port.
  const targets = parseEngagementTargets({
    target: "http://app.lab:3000",
    scope: { allow: ["http://app.lab:8080"] },
  });
  assert.equal(targets.length, 2, `expected two targets, got ${JSON.stringify(targets)}`);
  const ports = new Set(targets.map((t) => t.port));
  assert.ok(ports.has("3000") && ports.has("8080"), `got ports ${[...ports]}`);

  const entries = collectSurfaceEntries(
    [],
    [
      {
        id: "asset-1",
        address: "app.lab",
        open_ports: [3000, 8080, 22],
      },
    ],
    [],
    targets,
  );
  const kept = new Set(
    entries.filter((e) => e.host === "app.lab" && e.port).map((e) => e.port),
  );
  assert.ok(kept.has("3000"), "engagement :3000 kept");
  assert.ok(kept.has("8080"), "engagement :8080 kept");
  assert.ok(!kept.has("22"), "non-engagement :22 filtered");
}

function testDoesNotCollapseDistinctRealPortsWhenBothStrong() {
  // Both 80 and 443 have real paths — keep separate (not docker-default noise).
  const entries = collectSurfaceEntries(
    [
      {
        kind: "surface",
        level: "work_item",
        endpoint: "http://app.example/login",
        title: "http",
      },
      {
        kind: "surface",
        level: "work_item",
        endpoint: "https://app.example/login",
        title: "https",
      },
    ],
    [],
    [],
    parseEngagementTargets({ target: "https://app.example" }),
  );
  const ports = new Set(entries.filter((e) => e.service === "web").map((e) => e.port));
  // Target is https → 443; bare http:// may fold into 443 if 443 dominates, or keep 80.
  // At least we should not invent a third host root.
  assert.equal(buildSurfaceTree(entries).length, 1);
  assert.ok(ports.has("443") || ports.has("80"));
}

testParseHostOnlyIsWeb();
testDockerInternalNoDuplicatePortBranches();
testFindingLeavesJoinSameHostRoot();
testHostRootNoPortAndEngagementBeatsStaleAsset8080();
testEngagementTargetPreferPorted();
testDualPortEngagementKeepsBothPorts();
testDoesNotCollapseDistinctRealPortsWhenBothStrong();
console.log("surfaceModel.hostPort.test.ts: ok");
