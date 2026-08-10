/**
 * Spec #408 L5 density + #409 operator projection — Surface tree:
 * no method chips; collapsed parents use counts; NEW + TESTED; no SEEN/BOOK/PRIOR.
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
import {
  projectSurfaceEntriesFromLedger,
  surfaceStatusLabel,
  type SurfaceLedger,
} from "../lib/surfaceModel.ts";

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
  // Spec #409: seen → no status chip (quiet, not SEEN flood).
  assert.equal(leafChrome.showStatusChip, false);

  const leafB = origin.children.find((c) => c.path === "/b")!;
  assert.equal(surfaceTreeRowChrome(leafB, { open: true }).showStatusChip, true);
  assert.equal(surfaceStatusLabel(leafB.status), "TESTED");

  const leafC = origin.children.find((c) => c.path === "/c")!;
  // Booked: finding tags without BOOK status chip.
  assert.equal(surfaceTreeRowChrome(leafC, { open: true }).showStatusChip, false);
  assert.equal(surfaceTreeRowChrome(leafC, { open: true }).tags.length, 1);
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

function testOperatorChipsNewTestedNoSeenBook() {
  const findingsByPath = new Map<string, SurfaceFindingTag[]>([
    ["https://lab.example:443|/booked", [tag("f1", "high", "SQLi")]],
  ]);
  const entries = [
    entry({ key: "https://lab.example:443|/quiet", path: "/quiet", status: "seen" }),
    entry({ key: "https://lab.example:443|/tested", path: "/tested", status: "touched" }),
    entry({ key: "https://lab.example:443|/booked", path: "/booked", status: "booked" }),
    entry({ key: "https://lab.example:443|/novel", path: "/novel", status: "seen", isNew: true }),
  ];
  const roots = buildSurfaceTree(entries, findingsByPath);
  const html = renderToStaticMarkup(
    createElement(SurfaceTreeView, {
      roots,
      total: 4,
    }),
  );

  // No operator SEEN / BOOK / PRIOR chips (status text nodes or data-status).
  assert.ok(!html.includes('data-status="seen"'));
  assert.ok(!html.includes('data-status="booked"'));
  assert.ok(!html.includes('data-status="BOOK"'));
  assert.ok(!html.includes('data-status="PRIOR"'));
  assert.ok(!/>\s*seen\s*</i.test(html));
  assert.ok(!/>\s*booked\s*</i.test(html));
  assert.ok(!/>\s*BOOK\s*</.test(html));
  assert.ok(!/>\s*PRIOR\s*</.test(html));
  assert.ok(!/>\s*SEEN\s*</.test(html));

  // TESTED for touched family.
  assert.ok(html.includes('data-status="TESTED"') || html.includes(">TESTED<") || html.includes("TESTED"));
  // NEW only when flagged.
  assert.ok(html.includes('data-testid="surface-new"') || html.includes(">NEW<"));
  // Booked path still shows finding severity tag.
  assert.ok(html.includes(">high<") || html.includes("high"));

  const byPath = new Map(roots[0]!.children.map((c) => [c.path, c]));
  assert.equal(surfaceTreeRowChrome(byPath.get("/quiet")!, { open: true }).showStatusChip, false);
  assert.equal(surfaceTreeRowChrome(byPath.get("/tested")!, { open: true }).showStatusChip, true);
  assert.equal(surfaceStatusLabel(byPath.get("/tested")!.status), "TESTED");
  assert.equal(surfaceTreeRowChrome(byPath.get("/booked")!, { open: true }).showStatusChip, false);
  assert.equal(surfaceTreeRowChrome(byPath.get("/booked")!, { open: true }).tags.length, 1);
  assert.equal(surfaceTreeRowChrome(byPath.get("/novel")!, { open: true }).showNewBadge, true);
  assert.equal(surfaceTreeRowChrome(byPath.get("/quiet")!, { open: true }).showNewBadge, false);
}

testMethodsStayInModelButNotOnTreeChrome();
testCollapsedParentUsesCountsNotSeverityStackOrMaxStatus();
testRenderHasNoMethodChips();
testLedgerProjectionUnchanged();
testOperatorChipsNewTestedNoSeenBook();
console.log("SurfaceTreeView.test.tsx: ok");
