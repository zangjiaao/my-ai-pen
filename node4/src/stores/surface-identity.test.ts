/**
 * Pure contract: surface identity + status machine (Spec #368 / #369 / #379).
 * Run: npx tsx src/stores/surface-identity.test.ts
 */
import assert from "node:assert/strict";
import {
  applyStatusAdvance,
  canTransitionStatus,
  composeHttpLocation,
  isSurfaceStatus,
  isWriteSurfaceStatus,
  LEGACY_STATUS_MAP,
  mergeMethods,
  mergeParams,
  normalizeSurfaceStatus,
  parseLocation,
  pathFromLocationBlob,
  resolveBookingLocation,
  resolveUpsertStatus,
  statusRank,
  surfaceRowKey,
  type SurfaceStatus,
} from "./surface-identity.js";

// --- parseLocation / origin_key / path_key ---

{
  const p = parseLocation("https://Host.Docker.Internal:3000/api/Users?x=1");
  assert.equal(p.ok, true);
  if (!p.ok) throw new Error("expected parse ok");
  assert.equal(p.origin_key, "https://host.docker.internal:3000");
  assert.equal(p.path_key, "/api/users");
  assert.equal(p.scheme, "https");
  assert.equal(p.host, "host.docker.internal");
  assert.equal(p.port, 3000);
  assert.equal(p.kind, "url");
  assert.equal(surfaceRowKey(p.origin_key, p.path_key), "https://host.docker.internal:3000/api/users");
}

{
  const p = parseLocation("https://h");
  assert.equal(p.ok, true);
  if (!p.ok) throw new Error("expected parse ok");
  assert.equal(p.origin_key, "https://h:443");
  assert.equal(p.path_key, "/");
  assert.equal(p.port, 443);
}

{
  const p = parseLocation("http://example.com/a/b/");
  assert.equal(p.ok, true);
  if (!p.ok) throw new Error("expected parse ok");
  assert.equal(p.origin_key, "http://example.com:80");
  assert.equal(p.path_key, "/a/b");
}

{
  const p = parseLocation("ssh://1.1.1.1:22");
  assert.equal(p.ok, true);
  if (!p.ok) throw new Error("expected parse ok");
  assert.equal(p.origin_key, "ssh://1.1.1.1:22");
  assert.equal(p.path_key, "");
  assert.equal(p.kind, "ssh");
  assert.equal(surfaceRowKey(p.origin_key, p.path_key), "ssh://1.1.1.1:22");
}

{
  // Default ssh port when omitted
  const p = parseLocation("ssh://1.1.1.1");
  assert.equal(p.ok, true);
  if (!p.ok) throw new Error("expected parse ok");
  assert.equal(p.origin_key, "ssh://1.1.1.1:22");
  assert.equal(p.path_key, "");
}

{
  const p = parseLocation("redis://10.0.0.1:6379");
  assert.equal(p.ok, true);
  if (!p.ok) throw new Error("expected parse ok");
  assert.equal(p.origin_key, "redis://10.0.0.1:6379");
  assert.equal(p.path_key, "");
  assert.equal(p.kind, "redis");
}

{
  // Query/fragment not in path identity; same origin+path for different queries
  const a = parseLocation("https://t:443/api?id=1#frag");
  const b = parseLocation("https://t/api?id=2");
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) throw new Error("expected parse ok");
  assert.equal(a.origin_key, b.origin_key);
  assert.equal(a.path_key, b.path_key);
  assert.equal(surfaceRowKey(a.origin_key, a.path_key), surfaceRowKey(b.origin_key, b.path_key));
}

{
  // IPv6 bracket form
  const p = parseLocation("https://[2001:db8::1]/v1");
  assert.equal(p.ok, true);
  if (!p.ok) throw new Error("expected parse ok");
  assert.equal(p.origin_key, "https://[2001:db8::1]:443");
  assert.equal(p.path_key, "/v1");
  assert.equal(p.host, "[2001:db8::1]");
}

{
  assert.equal(parseLocation("").ok, false);
  assert.equal(parseLocation("not-a-url").ok, false);
  assert.equal(parseLocation("/relative/path").ok, false);
}

// --- Spec #382 resolveBookingLocation (D7) ---

{
  assert.equal(pathFromLocationBlob("PUT /api/Products/{id} (note)"), "/api/products/{id}");
  assert.equal(composeHttpLocation("h.local", 3000, "/api/x"), "http://h.local:3000/api/x");
}

{
  const r = resolveBookingLocation({
    location: "PUT /api/Products/{id} (IDOR)",
    host: "host.docker.internal",
    port: 3000,
    locationKey: "/api/products/{id}",
  });
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error("expected resolve ok");
  assert.equal(r.origin_key, "http://host.docker.internal:3000");
  assert.equal(r.path_key, "/api/products/{id}");
}

{
  const r = resolveBookingLocation({
    location: "PUT /api/Orders/1",
    proof: "Request: PUT http://juice:3000/api/Orders/1\n200 OK",
  });
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error("expected proof resolve ok");
  assert.equal(r.origin_key, "http://juice:3000");
  assert.equal(r.path_key, "/api/orders/1");
}

{
  const r = resolveBookingLocation({ location: "PUT /api/Products/{id}" });
  assert.equal(r.ok, false);
}

// --- methods / params union merge ---

{
  assert.deepEqual(mergeMethods(["get", "POST"], ["post", "PUT", ""]), ["GET", "POST", "PUT"]);
  assert.deepEqual(mergeMethods(undefined, ["get"]), ["GET"]);
  assert.deepEqual(mergeMethods(["GET"], null), ["GET"]);
  assert.deepEqual(mergeMethods(), []);
}

{
  assert.deepEqual(mergeParams(["id", "name"], ["name", "token", ""]), ["id", "name", "token"]);
  assert.deepEqual(mergeParams(["a"], ["b", "a"]), ["a", "b"]);
  assert.deepEqual(mergeParams(undefined, undefined), []);
}

// --- status machine v2: seen → touched → booked; legacy map; never downgrade ---

{
  // Accept both legacy and v2 on read
  assert.equal(isSurfaceStatus("open"), true);
  assert.equal(isSurfaceStatus("seen"), true);
  assert.equal(isSurfaceStatus("touched"), true);
  assert.equal(isSurfaceStatus("in_probe"), true);
  assert.equal(isSurfaceStatus("probed"), true);
  assert.equal(isSurfaceStatus("booked"), true);
  assert.equal(isSurfaceStatus("nope"), false);
  assert.equal(isWriteSurfaceStatus("open"), false);
  assert.equal(isWriteSurfaceStatus("seen"), true);
  assert.equal(isWriteSurfaceStatus("touched"), true);
  assert.equal(isWriteSurfaceStatus("probed"), false);
}

{
  // Legacy → v2 migration map
  assert.equal(normalizeSurfaceStatus("open"), "seen");
  assert.equal(normalizeSurfaceStatus("in_probe"), "touched");
  assert.equal(normalizeSurfaceStatus("probed"), "touched");
  assert.equal(normalizeSurfaceStatus("booked"), "booked");
  assert.equal(normalizeSurfaceStatus("seen"), "seen");
  assert.equal(normalizeSurfaceStatus("touched"), "touched");
  // Optional terminals retained (not collapsed to touched)
  assert.equal(normalizeSurfaceStatus("deadend"), "deadend");
  assert.equal(normalizeSurfaceStatus("skipped_roe"), "skipped_roe");
  assert.equal(LEGACY_STATUS_MAP.open, "seen");
  assert.equal(LEGACY_STATUS_MAP.in_probe, "touched");
  assert.equal(LEGACY_STATUS_MAP.probed, "touched");
  assert.equal(normalizeSurfaceStatus("NOPE"), null);
  // Case / trim tolerant
  assert.equal(normalizeSurfaceStatus("  Open "), "seen");
  assert.equal(normalizeSurfaceStatus("IN_PROBE"), "touched");
}

{
  // Ranks: booked > touched(=deadend peers) > seen; legacy ranks via normalize
  assert.ok(statusRank("booked") > statusRank("touched"));
  assert.ok(statusRank("touched") > statusRank("seen"));
  assert.equal(statusRank("touched"), statusRank("probed"));
  assert.equal(statusRank("seen"), statusRank("open"));
  assert.equal(statusRank("touched"), statusRank("in_probe"));
  assert.equal(statusRank("touched"), statusRank("deadend"));
  assert.equal(statusRank("touched"), statusRank("skipped_roe"));
}

{
  // touched + seen attempt stays touched (never downgrade); legacy inputs normalize
  assert.equal(resolveUpsertStatus("probed", "open"), "touched");
  assert.equal(resolveUpsertStatus("touched", "seen"), "touched");
  assert.equal(canTransitionStatus("probed", "open"), false);
  assert.equal(canTransitionStatus("touched", "seen"), false);
  const adv = applyStatusAdvance("probed", "open");
  assert.equal(adv.status, "touched");
  assert.equal(adv.changed, false);
}

{
  // ordinary upsert/settle cannot set booked
  assert.equal(resolveUpsertStatus(undefined, "booked"), "seen");
  assert.equal(resolveUpsertStatus("open", "booked"), "seen");
  assert.equal(resolveUpsertStatus("seen", "booked"), "seen");
  assert.equal(resolveUpsertStatus("probed", "booked"), "touched");
  assert.equal(resolveUpsertStatus("touched", "booked"), "touched");
  assert.equal(canTransitionStatus("open", "booked"), false);
  assert.equal(canTransitionStatus("seen", "booked"), false);
  assert.equal(canTransitionStatus("open", "booked", { allowBooked: true }), true);
  assert.equal(canTransitionStatus("seen", "booked", { allowBooked: true }), true);
  const viaBooking = applyStatusAdvance("open", "booked", { allowBooked: true });
  assert.equal(viaBooking.status, "booked");
  assert.equal(viaBooking.changed, true);
  const viaV2 = applyStatusAdvance("seen", "booked", { allowBooked: true });
  assert.equal(viaV2.status, "booked");
  assert.equal(viaV2.changed, true);
}

{
  // Spec #411: ordinary upsert cannot fake TESTED (touched) without allowTested
  assert.equal(resolveUpsertStatus("seen", "touched"), "seen", "agent cannot elevate to TESTED");
  assert.equal(resolveUpsertStatus("open", "in_probe"), "seen");
  assert.equal(resolveUpsertStatus(undefined, "touched"), "seen", "new row stays seen");
  assert.equal(resolveUpsertStatus(undefined, "in_probe"), "seen");
  assert.equal(
    resolveUpsertStatus("touched", "touched"),
    "touched",
    "already TESTED preserved (no downgrade via capped request)",
  );
  assert.equal(resolveUpsertStatus("seen", "deadend"), "deadend", "deadend still allowed");
  assert.equal(resolveUpsertStatus("seen", "skipped_roe"), "skipped_roe");
}

{
  // Traffic-objective allowTested: forward advances (v2 + legacy synonyms)
  const traffic = { allowTested: true };
  assert.equal(resolveUpsertStatus("seen", "touched", traffic), "touched");
  assert.equal(resolveUpsertStatus("open", "in_probe", traffic), "touched");
  assert.equal(resolveUpsertStatus("in_probe", "probed", traffic), "touched");
  assert.equal(resolveUpsertStatus(undefined, "in_probe", traffic), "touched");
  assert.equal(resolveUpsertStatus(undefined, "touched", traffic), "touched");
  assert.equal(resolveUpsertStatus(undefined, undefined), "seen");
  assert.equal(resolveUpsertStatus(undefined, "seen"), "seen");
}

{
  // no lateral between same-rank peers; booked never downgrades
  assert.equal(canTransitionStatus("touched", "deadend"), false);
  assert.equal(canTransitionStatus("probed", "deadend"), false);
  assert.equal(canTransitionStatus("deadend", "probed"), false);
  assert.equal(canTransitionStatus("deadend", "touched"), false);
  assert.equal(canTransitionStatus("booked", "probed"), false);
  assert.equal(canTransitionStatus("booked", "touched"), false);
  assert.equal(canTransitionStatus("booked", "open"), false);
  assert.equal(canTransitionStatus("booked", "seen"), false);
  assert.equal(canTransitionStatus("deadend", "booked", { allowBooked: true }), true);
  assert.equal(canTransitionStatus("skipped_roe", "open"), false);
  assert.equal(canTransitionStatus("skipped_roe", "seen"), false);
}

{
  // same status is a no-op advance (legacy in_probe normalizes to touched)
  assert.equal(canTransitionStatus("open", "open"), true);
  assert.equal(canTransitionStatus("seen", "seen"), true);
  const same = applyStatusAdvance("in_probe", "in_probe");
  assert.equal(same.status, "touched");
  assert.equal(same.changed, false);
  const sameV2 = applyStatusAdvance("touched", "touched");
  assert.equal(sameV2.status, "touched");
  assert.equal(sameV2.changed, false);
}

{
  // skip intermediate ranks allowed (seen → booked with allow; open → deadend)
  assert.equal(canTransitionStatus("open", "probed"), true); // open→seen, probed→touched
  assert.equal(canTransitionStatus("seen", "touched"), true);
  assert.equal(resolveUpsertStatus("open", "deadend"), "deadend");
  assert.equal(resolveUpsertStatus("seen", "deadend"), "deadend");
}

// Exhaustive rank monotonicity for write-status pairs (non-booked without allowBooked)
const ALL: SurfaceStatus[] = [
  "seen",
  "touched",
  "booked",
  "deadend",
  "skipped_roe",
];
for (const from of ALL) {
  for (const to of ALL) {
    if (to === "booked") {
      assert.equal(
        canTransitionStatus(from, to),
        false,
        `upsert path must refuse ${from}→booked`,
      );
      continue;
    }
    const allowed = canTransitionStatus(from, to);
    if (from === to) {
      assert.equal(allowed, true, `${from}→${to} no-op`);
    } else if (statusRank(to) > statusRank(from)) {
      assert.equal(allowed, true, `${from}→${to} forward`);
    } else {
      assert.equal(allowed, false, `${from}→${to} no downgrade/lateral`);
    }
  }
}

// Legacy input pairs: agent path (no allowTested) cannot fake TESTED; traffic path can.
const LEGACY_AGENT_PAIRS: Array<[string, string, SurfaceStatus]> = [
  ["open", "in_probe", "seen"], // capped — no fake TESTED
  ["open", "probed", "seen"],
  ["in_probe", "open", "touched"], // already TESTED rank; no downgrade
  ["probed", "open", "touched"],
  ["open", "booked", "seen"], // booked ignored on upsert
  ["probed", "booked", "touched"],
];
for (const [from, to, expect] of LEGACY_AGENT_PAIRS) {
  assert.equal(resolveUpsertStatus(from, to), expect, `agent legacy ${from}+${to}→${expect}`);
}
const LEGACY_TRAFFIC_PAIRS: Array<[string, string, SurfaceStatus]> = [
  ["open", "in_probe", "touched"],
  ["open", "probed", "touched"],
  ["in_probe", "open", "touched"],
  ["probed", "open", "touched"],
];
for (const [from, to, expect] of LEGACY_TRAFFIC_PAIRS) {
  assert.equal(
    resolveUpsertStatus(from, to, { allowTested: true }),
    expect,
    `traffic legacy ${from}+${to}→${expect}`,
  );
}

console.log("surface-identity.test.ts: ok");
