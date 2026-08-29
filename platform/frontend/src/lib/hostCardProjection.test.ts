/**
 * Spec #541 — Host-card Surface projection (seam 1).
 * Operator-visible cards from Workset + ledger + Case assets.
 * Run: npx tsx src/lib/hostCardProjection.test.ts  (from platform/frontend)
 */
import assert from "node:assert/strict";
import {
  filterHostCards,
  hostCardIdForFinding,
  isValidLedgerAddress,
  projectHostCards,
  type HostCard,
} from "./hostCardProjection.ts";
import type { SurfaceLedger } from "./surfaceModel.ts";
import type { WorksetItem } from "./workset.ts";
import type { IntelRow } from "./intelView.ts";

const HOSTS = [
  "www.example.com",
  "example.com",
  "mail.example.com",
  "shop.example.com",
  "api.example.com",
  "cdn.example.com",
  "ns1.cloudflare.com",
  "ns2.cloudflare.com",
  "example.net",
  "example.org",
  "staging.example.com",
] as const;

function proposedHost(host: string, index: number): WorksetItem {
  return {
    id: `ws_${String(index + 1).padStart(2, "0")}`,
    family: "t_host",
    title: host,
    status: "proposed",
    payload: {
      host,
      intel_source: "ct",
      attribution: `CT name ${host}`,
      confidence: "medium",
      scope_decision: "pending",
    },
  };
}

function intelApiLedger(): SurfaceLedger {
  return {
    version: 2,
    surfaces: [
      {
        origin_key: "https://crt.sh:443",
        path_key: "/",
        location: "https://crt.sh/",
        status: "touched",
        coverage: "tested",
      },
      {
        origin_key: "https://dns.google:443",
        path_key: "/resolve",
        location: "https://dns.google/resolve",
        status: "touched",
        coverage: "tested",
      },
      {
        origin_key: "https://api.certspotter.com:443",
        path_key: "/v1",
        location: "https://api.certspotter.com/v1",
        status: "seen",
        coverage: "untested",
      },
    ],
  };
}

{
  assert.equal(isValidLedgerAddress("www.example.com"), true);
  assert.equal(isValidLedgerAddress("10.0.0.8"), true);
  assert.equal(isValidLedgerAddress("ns1.cloudflare.com"), true);
  assert.equal(isValidLedgerAddress("*.example.com"), false);
  assert.equal(isValidLedgerAddress("reflected.php"), false);
  assert.equal(isValidLedgerAddress(""), false);
  console.log("ok: ledger address gate");
}

{
  const workset = { items: HOSTS.map((h, i) => proposedHost(h, i)) };
  const cards = projectHostCards({
    workset,
    surfaceLedger: intelApiLedger(),
    assets: [],
    findings: [],
    intel: [],
  });
  assert.equal(cards.length, 11, "11 Workset hosts, zero intel-API cards");
  assert.equal(
    cards.some((c) => /crt\.sh|dns\.google|certspotter/i.test(c.address)),
    false,
  );
  for (const card of cards) {
    assert.equal(card.admission, "pending");
    assert.ok(card.id.startsWith("ws_"), card.id);
    assert.equal(card.worksetItemId, card.id);
    assert.equal(card.paths.length, 0, "pending cards have no path coverage");
  }
  assert.deepEqual(
    cards.map((c) => c.address).sort(),
    [...HOSTS].sort(),
  );
  console.log("ok: pending Workset hosts project; intel APIs omitted");
}

{
  const workset = {
    items: [
      ...HOSTS.map((h, i) => proposedHost(h, i)),
      {
        id: "ws_wild",
        family: "t_host",
        title: "*.example.com",
        status: "proposed",
        payload: { host: "*.example.com" },
      },
    ],
  };
  const cards = projectHostCards({
    workset,
    surfaceLedger: intelApiLedger(),
    assets: [],
  });
  assert.equal(cards.length, 11);
  assert.equal(
    cards.some((c) => c.address.includes("*") || c.id === "ws_wild"),
    false,
  );
  console.log("ok: invalid wildcard host omitted from cards");
}

{
  const adoptedId = "host-www-1";
  const items: WorksetItem[] = HOSTS.map((h, i) => {
    if (h !== "www.example.com") return proposedHost(h, i);
    return {
      ...proposedHost(h, i),
      status: "adopted",
    };
  });
  const cards = projectHostCards({
    workset: { items },
    surfaceLedger: {
      version: 2,
      surfaces: [
        ...intelApiLedger().surfaces,
        {
          origin_key: "https://www.example.com:443",
          path_key: "/login",
          location: "https://www.example.com/login",
          status: "seen",
          coverage: "untested",
          is_new: true,
        },
      ],
    },
    assets: [
      {
        id: adoptedId,
        address: "www.example.com",
        aliases: ["example-www"],
      },
    ],
    findings: [
      {
        id: "f-sqli",
        title: "SQLi",
        finding_kind: "vuln",
        asset_id: adoptedId,
        location: "https://www.example.com/login",
      },
    ],
    intel: [
      { id: "i1", asset_id: adoptedId, summary: "login cookie", kind: "config" },
      { id: "i2", asset_id: "other-host", summary: "noise" },
    ],
  });
  const www = cards.find((c) => c.address === "www.example.com");
  assert.ok(www);
  assert.equal(www!.admission, "admitted");
  assert.equal(www!.id, adoptedId);
  assert.equal(www!.hostId, adoptedId);
  assert.equal(cards.filter((c) => c.address === "www.example.com").length, 1, "no dual card");
  assert.equal(www!.findingCount, 1);
  assert.equal(www!.intel.length, 1);
  assert.equal(www!.paths.length, 1);
  assert.equal(www!.paths[0]!.path, "/login");
  assert.equal(www!.untestedCount, 1);
  const pending = cards.filter((c) => c.admission === "pending");
  assert.equal(pending.length, 10);
  assert.equal(hostCardIdForFinding(cards, { asset_id: adoptedId }), adoptedId);
  console.log("ok: adopted host is 已准入, keyed by Host id, paths hang on that card");
}

{
  const findings = [
    { id: "v1", title: "XSS", finding_kind: "vuln", asset_id: "h1" },
    { id: "k1", title: "password dump", finding_kind: "auth", asset_id: "h1" },
  ];
  const intel: IntelRow[] = [
    { id: "i1", summary: "cookie", asset_id: "h1" },
    { id: "i2", summary: "jwt in localStorage", asset_id: "h1" },
  ];
  const cards = projectHostCards({
    workset: { items: [] },
    assets: [{ id: "h1", address: "lab.example" }],
    findings,
    intel,
    surfaceLedger: { version: 2, surfaces: [] },
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.findingCount, findings.length);
  assert.equal(cards[0]!.intel.length, 2);
  console.log("ok: findings count is confirmed findings only");
}

{
  const cards: HostCard[] = projectHostCards({
    workset: {
      items: [
        proposedHost("pending.lab", 0),
        { ...proposedHost("in.lab", 1), status: "adopted" },
      ],
    },
    assets: [{ id: "h-in", address: "in.lab" }],
    findings: [{ id: "f1", title: "RCE", finding_kind: "vuln", asset_id: "h-in" }],
    surfaceLedger: {
      version: 2,
      surfaces: [
        {
          origin_key: "https://in.lab:443",
          path_key: "/x",
          location: "https://in.lab/x",
          coverage: "untested",
        },
      ],
    },
  });
  assert.equal(filterHostCards(cards, "", "pending").map((c) => c.address).join(), "pending.lab");
  assert.equal(filterHostCards(cards, "", "admitted").map((c) => c.id).join(), "h-in");
  assert.equal(filterHostCards(cards, "", "untested").map((c) => c.id).join(), "h-in");
  assert.equal(filterHostCards(cards, "", "findings").map((c) => c.id).join(), "h-in");
  assert.equal(filterHostCards(cards, "pending", "all").length, 1);
  console.log("ok: Host-card filters");
}

{
  assert.equal(projectHostCards({ workset: { items: [] }, assets: [], surfaceLedger: intelApiLedger() }).length, 0);
  console.log("ok: empty portrait when no Hosts / Workset");
}

console.log("hostCardProjection.test.ts: all ok");
