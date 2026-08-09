/**
 * Pure contract: surface identity + status machine (Spec #368 / issue #369).
 * Run: npx tsx src/stores/surface-identity.test.ts
 */
import assert from "node:assert/strict";
import {
  applyStatusAdvance,
  canTransitionStatus,
  isSurfaceStatus,
  mergeMethods,
  mergeParams,
  parseLocation,
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

// --- status machine: never downgrade; upsert cannot set booked ---

{
  assert.equal(isSurfaceStatus("open"), true);
  assert.equal(isSurfaceStatus("booked"), true);
  assert.equal(isSurfaceStatus("nope"), false);
  assert.ok(statusRank("booked") > statusRank("probed"));
  assert.ok(statusRank("probed") > statusRank("in_probe"));
  assert.ok(statusRank("in_probe") > statusRank("open"));
}

{
  // probed + open attempt stays probed
  assert.equal(resolveUpsertStatus("probed", "open"), "probed");
  assert.equal(canTransitionStatus("probed", "open"), false);
  const adv = applyStatusAdvance("probed", "open");
  assert.equal(adv.status, "probed");
  assert.equal(adv.changed, false);
}

{
  // upsert cannot set booked
  assert.equal(resolveUpsertStatus(undefined, "booked"), "open");
  assert.equal(resolveUpsertStatus("open", "booked"), "open");
  assert.equal(resolveUpsertStatus("probed", "booked"), "probed");
  assert.equal(canTransitionStatus("open", "booked"), false);
  assert.equal(canTransitionStatus("open", "booked", { allowBooked: true }), true);
  const viaBooking = applyStatusAdvance("open", "booked", { allowBooked: true });
  assert.equal(viaBooking.status, "booked");
  assert.equal(viaBooking.changed, true);
}

{
  // forward advances
  assert.equal(resolveUpsertStatus("open", "in_probe"), "in_probe");
  assert.equal(resolveUpsertStatus("in_probe", "probed"), "probed");
  assert.equal(resolveUpsertStatus(undefined, "in_probe"), "in_probe");
  assert.equal(resolveUpsertStatus(undefined, undefined), "open");
}

{
  // no lateral between same-rank terminals; booked never downgrades
  assert.equal(canTransitionStatus("probed", "deadend"), false);
  assert.equal(canTransitionStatus("deadend", "probed"), false);
  assert.equal(canTransitionStatus("booked", "probed"), false);
  assert.equal(canTransitionStatus("booked", "open"), false);
  assert.equal(canTransitionStatus("deadend", "booked", { allowBooked: true }), true);
  assert.equal(canTransitionStatus("skipped_roe", "open"), false);
}

{
  // same status is a no-op advance
  assert.equal(canTransitionStatus("open", "open"), true);
  const same = applyStatusAdvance("in_probe", "in_probe");
  assert.equal(same.status, "in_probe");
  assert.equal(same.changed, false);
}

{
  // skip intermediate ranks allowed (open → probed)
  assert.equal(canTransitionStatus("open", "probed"), true);
  assert.equal(resolveUpsertStatus("open", "deadend"), "deadend");
}

// Exhaustive rank monotonicity for non-booked pairs
const ALL: SurfaceStatus[] = [
  "open",
  "in_probe",
  "probed",
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

console.log("surface-identity.test.ts: ok");
