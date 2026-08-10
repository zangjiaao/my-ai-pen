/**
 * Spec #408 / surface-new-tested-coverage L5 — Surface tree UI density:
 * no method chips; collapsed parents use finding/unfinished counts (not method union or severity stacks).
 * Run: npx tsx src/components/SurfaceTreeView.test.tsx  (from platform/frontend)
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildSurfaceTree,
  surfaceTreeRowChrome,
  SurfaceTreeView,
} from "./SurfaceTreeView.tsx";
import type { SurfaceEntry } from "../lib/surfaceModel.ts";
import type { SurfaceFindingTag } from "../lib/findingKinds.ts";
import { projectSurfaceEntriesFromLedger, type SurfaceLedger } from "../lib/surfaceModel.ts";

function entry(partial: Partial<SurfaceEntry> & Pick<SurfaceEntry, "key" | "path">): SurfaceEntry {
  return {
    host: "lab.example",
    port: "443",
    origin: "https://lab.example:443",
    service: "web",
    method: null,
    scheme: "https",
    originKey: "https://lab.example:443",
    ...partial,
  };
}

function tag(id: string, label: string, title: string): SurfaceFindingTag {
  return {
    id,
    kind: "vuln",
    label,
    title,
    severity: label.toLowerCase(),
    finding: { id, title, severity: label.toLowerCase() },
  };
}

function testMethodsStayInModelButNotOnTreeChrome() {
  const entries = [
    entry({ key: "https://lab.example:443|/login", path: "/login", method: "GET,POST", status: "seen" }),
    entry({ key: "https://lab.example:443|/api", path: "/api", method: "PUT", status: "touched" }),
  ];
  const tree = buildSurfaceTree(entries);
  assert.equal(tree.length, 1);
  const login = tree[0]!.children.find((c) => c.path === "/login");
  const api = tree[0]!.children.find((c) => c.path === "/api");
  assert.ok(login);
  assert.ok(api);
  // Data model may still carry methods (search / tools).
  assert.ok(login!.methods.includes("GET") || login!.methods.includes("POST"));
  assert.ok(api!.methods.includes("PUT"));
  // Parent may still union methods in data — must not surface as chips via chrome.
  assert.ok(tree[0]!.methods.length >= 1);

  for (const node of [tree[0]!, login!, api!]) {
    for (const open of [true, false]) {
      const chrome = surfaceTreeRowChrome(node, { open });
      assert.equal(chrome.showMethods, false, `methods must never chip (open=${open} id=${node.id})`);
    }
  }
}

function testCollapsedParentUsesCountsNotSeverityStackOrMaxStatus() {
  const findingsByPath = new Map<string, SurfaceFindingTag[]>([
    ["https://lab.example:443|/a", [tag("f1", "high", "SQLi A")]],
    ["https://lab.example:443|/b", [tag("f2", "critical", "RCE B")]],
    ["https://lab.example:443|/c", [tag("f3", "medium", "XSS C")]],
  ]);
  const entries = [
    entry({ key: "https://lab.example:443|/a", path: "/a", method: "GET", status: "seen" }),
    entry({ key: "https://lab.example:443|/b", path: "/b", method: "POST", status: "touched" }),
    entry({ key: "https://lab.example:443|/c", path: "/c", method: "GET", status: "booked" }),
  ];
  const tree = buildSurfaceTree(entries, findingsByPath);
  const origin = tree[0]!;
  assert.equal(origin.nodeKind, "origin");
  assert.ok(origin.subtreeFindingTags.length >= 3);
  assert.ok(origin.unfinishedCount >= 2, "seen+touched count under origin");

  const collapsed = surfaceTreeRowChrome(origin, { open: false });
  assert.equal(collapsed.showMethods, false);
  assert.equal(collapsed.findingMode, "count");
  assert.equal(collapsed.findingCount, 3);
  assert.equal(collapsed.tags.length, 0, "no severity title chips on collapsed parent");
  assert.equal(collapsed.showStatusChip, false, "no max-status chip alone on collapsed parent");
  assert.ok(collapsed.unfinishedCount >= 2);

  const expanded = surfaceTreeRowChrome(origin, { open: true });
  assert.equal(expanded.findingMode, "tags");
  // Expanded parent shows only own tags (origin has none), not full subtree stack.
  assert.equal(expanded.tags.length, 0);

  const leafA = origin.children.find((c) => c.path === "/a")!;
  const leafChrome = surfaceTreeRowChrome(leafA, { open: true });
  assert.equal(leafChrome.findingMode, "tags");
  assert.equal(leafChrome.tags.length, 1);
  assert.equal(leafChrome.tags[0]!.label, "high");
  assert.equal(leafChrome.showStatusChip, true);
}

function testRenderHasNoMethodChips() {
  const findingsByPath = new Map<string, SurfaceFindingTag[]>([
    ["https://lab.example:443|/login", [tag("f1", "high", "SQLi")]],
    ["https://lab.example:443|/admin", [tag("f2", "critical", "Auth bypass")]],
  ]);
  const entries = [
    entry({ key: "https://lab.example:443|/login", path: "/login", method: "GET,POST", status: "seen" }),
    entry({ key: "https://lab.example:443|/admin", path: "/admin", method: "GET", status: "touched" }),
  ];
  const roots = buildSurfaceTree(entries, findingsByPath);

  const html = renderToStaticMarkup(
    createElement(SurfaceTreeView, {
      roots,
      total: 2,
    }),
  );
  assert.ok(!html.includes('data-testid="surface-method-chip"'));
  // Method strings must not appear as standalone uppercase chips in the row chrome.
  // Paths/labels do not include GET/POST; if chips were rendered they would appear as text nodes.
  assert.ok(!/>\s*GET\s*</.test(html), "GET method chip must not render");
  assert.ok(!/>\s*POST\s*</.test(html), "POST method chip must not render");
  // Leaf finding tags still allowed when expanded (default shallow open).
  assert.ok(html.includes(">high<") || html.includes("high"), "leaf finding tags still render");
}

function testLedgerProjectionUnchanged() {
  const ledger: SurfaceLedger = {
    version: 1,
    surfaces: [
      {
        origin_key: "https://lab.example:443",
        path_key: "/login",
        location: "https://lab.example/login",
        kind: "url",
        methods: ["GET", "POST"],
        status: "seen",
      },
    ],
  };
  const entries = projectSurfaceEntriesFromLedger(ledger);
  assert.equal(entries.length, 1);
  assert.ok(String(entries[0]!.method || "").includes("GET"));
  const tree = buildSurfaceTree(entries);
  assert.equal(tree.length, 1);
  assert.equal(tree[0]!.children[0]!.path, "/login");
  // Methods still project into model from ledger
  assert.ok(tree[0]!.children[0]!.methods.length >= 1);
  assert.equal(surfaceTreeRowChrome(tree[0]!.children[0]!, { open: true }).showMethods, false);
}

testMethodsStayInModelButNotOnTreeChrome();
testCollapsedParentUsesCountsNotSeverityStackOrMaxStatus();
testRenderHasNoMethodChips();
testLedgerProjectionUnchanged();
console.log("SurfaceTreeView.test.tsx: ok");
