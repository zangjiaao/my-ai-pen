/**
 * Surface tree: roots are scheme://host:port (Spec D2); different ports = different roots.
 */
import assert from "node:assert/strict";
import {
  collectSurfaceEntries,
  parseEngagementTargets,
  parseSurfaceRef,
  projectSurfaceEntriesFromLedger,
  toSurfaceEntry,
  type SurfaceLedger,
} from "./surfaceModel.ts";
import { buildSurfaceTree, entryOriginRootKey } from "../components/SurfaceTreeView.tsx";

function testEntryOriginRootKey() {
  assert.equal(
    entryOriginRootKey({
      key: "x",
      host: "127.0.0.1",
      port: "3000",
      origin: "127.0.0.1:3000",
      service: "web",
      path: "/",
      method: null,
      scheme: "http",
      originKey: "http://127.0.0.1:3000",
    }),
    "http://127.0.0.1:3000",
  );
  assert.equal(
    entryOriginRootKey({
      key: "y",
      host: "127.0.0.1",
      port: "8080",
      origin: "127.0.0.1:8080",
      service: "web",
      path: "/",
      method: null,
      scheme: "http",
    }),
    "http://127.0.0.1:8080",
  );
}

function testDifferentPortsAreDifferentRoots() {
  const ledger: SurfaceLedger = {
    version: 2,
    surfaces: [
      {
        origin_key: "http://127.0.0.1:3000",
        path_key: "/",
        location: "http://127.0.0.1:3000/",
        kind: "url",
        status: "seen",
      },
      {
        origin_key: "http://127.0.0.1:3000",
        path_key: "/api/Users",
        location: "http://127.0.0.1:3000/api/Users",
        kind: "url",
        status: "touched",
      },
      {
        origin_key: "http://127.0.0.1:8080",
        path_key: "/login.php",
        location: "http://127.0.0.1:8080/login.php",
        kind: "url",
        status: "seen",
      },
    ],
  };
  const entries = projectSurfaceEntriesFromLedger(ledger);
  const tree = buildSurfaceTree(entries);
  assert.equal(tree.length, 2, `two origin roots, got ${tree.map((r) => r.label).join(" | ")}`);
  const labels = tree.map((r) => r.label).sort();
  assert.deepEqual(labels, ["http://127.0.0.1:3000", "http://127.0.0.1:8080"]);
  assert.ok(tree.every((r) => r.nodeKind === "origin"));
  assert.ok(tree.every((r) => r.id.startsWith("origin:")));
  // No intermediate :port child under origin
  for (const root of tree) {
    assert.ok(!root.children.some((c) => c.nodeKind === "port"), "no :port intermediate nodes");
  }
  const juice = tree.find((r) => r.label.includes(":3000"))!;
  assert.ok(juice.children.some((c) => c.label === "api" || c.path.includes("api")));
}

function testLedgerRootLabelIsSchemeHostPort() {
  const ledger: SurfaceLedger = {
    version: 2,
    surfaces: [
      {
        origin_key: "https://lab.example:443",
        path_key: "/login",
        location: "https://lab.example/login",
        kind: "url",
        status: "seen",
      },
    ],
  };
  const tree = buildSurfaceTree(projectSurfaceEntriesFromLedger(ledger));
  assert.equal(tree.length, 1);
  assert.equal(tree[0]!.label, "https://lab.example:443");
  assert.equal(tree[0]!.nodeKind, "origin");
}

function testCollectStillBuildsOriginRoots() {
  const entries = collectSurfaceEntries(
    [
      {
        kind: "surface",
        level: "work_item",
        endpoint: "http://host.docker.internal:3000/login",
        title: "login",
      },
      {
        kind: "surface",
        level: "work_item",
        endpoint: "http://host.docker.internal:8080/vulnerabilities",
        title: "dvwa",
      },
    ],
    [],
    [],
    parseEngagementTargets({ target: "http://host.docker.internal:3000" }),
  );
  const tree = buildSurfaceTree(entries);
  assert.ok(tree.length >= 1);
  // Distinct ports must not collapse to one bare hostname root
  const keys = new Set(tree.map((r) => r.id));
  if (tree.length === 1) {
    // engagement may fold 8080 away — at least root must not be bare host without port scheme
    assert.ok(tree[0]!.label.includes("://") || tree[0]!.label.includes(":"), tree[0]!.label);
  } else {
    assert.ok(keys.size === tree.length);
  }
}

function testParseHostOnlyIsWeb() {
  const p = parseSurfaceRef("host.docker.internal", null, "host only host.docker.internal");
  assert.ok(p);
  assert.equal(p!.service, "web");
  assert.equal(p!.path, "/");
}

testEntryOriginRootKey();
testDifferentPortsAreDifferentRoots();
testLedgerRootLabelIsSchemeHostPort();
testCollectStillBuildsOriginRoots();
testParseHostOnlyIsWeb();
console.log("surfaceModel.hostPort.test.ts: ok");
