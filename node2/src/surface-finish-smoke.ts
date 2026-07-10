/**
 * Short-term discovery gates smoke:
 * S1 attack-surface / traffic inventory
 * S2 multi-actor breadth
 * S3 weak-skip + bulk-skip discipline
 */
import {
  attackSurfaceGaps,
  buildDiscoveryQueue,
  bulkSkipResolutionGaps,
  finishCompletedEligibility,
  formatDiscoveryQueuePayload,
  isHighPriorityCandidate,
  isNoiseEndpoint,
  isObjectLikeResourcePath,
  isSubstantiveSkipNotes,
  multiActorTestingGaps,
  nextVerifyGuidance,
  weakSkipHighPriority,
} from "./runtime/detection-conversion.js";
import type { CoverageLikeRow } from "./runtime/detection-conversion.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function row(
  endpoint: string,
  param: string,
  vulnClass: string,
  status: string,
  notes?: string,
): CoverageLikeRow {
  return { endpoint, param, vulnClass, status, notes, priority: 250 };
}

// --- S3: weak skip notes ---
assert(!isSubstantiveSkipNotes("skip"), "short notes are weak");
assert(!isSubstantiveSkipNotes("not interesting right now xxxxxx"), "long but no reason keyword is weak");
assert(
  isSubstantiveSkipNotes("duplicate idor pattern already verified on /api/Orders with dual-actor"),
  "pattern-covered notes should be substantive",
);

const weakSkipRows: CoverageLikeRow[] = [
  row("/api/Users/1", "id", "idor", "skipped", "skip"),
  row("/rest/products/search", "q", "sql-injection", "failed", "boolean differential"),
];
const weak = weakSkipHighPriority(weakSkipRows);
assert(weak.length === 1, `expected 1 weak skip, got ${weak.length}`);
const weakBlocked = finishCompletedEligibility(weakSkipRows, {
  status: "completed",
  actorCount: 2,
  actorAuthCount: 2,
  engagement: "assess",
});
assert(!weakBlocked.allowed, `weak skip must block completed: ${weakBlocked.reason}`);

// --- S3: bulk skip ---
const bulkRows: CoverageLikeRow[] = [];
for (let i = 0; i < 10; i++) {
  bulkRows.push(
    row(`/api/Items/${i}`, "id", "idor", "skipped", `duplicate access-control pattern covered by earlier dual-actor probe on basket #${i}`),
  );
}
bulkRows.push(row("/rest/login", "email", "sql-injection", "passed", "no error differential"));
bulkRows.push(row("/api/Users", "role", "mass-assignment", "failed", "role accepted"));
const bulkGaps = bulkSkipResolutionGaps(bulkRows);
assert(bulkGaps.some((gap) => gap.family === "bulk_skip"), `expected bulk_skip gap: ${JSON.stringify(bulkGaps)}`);
const bulkBlocked = finishCompletedEligibility(bulkRows, {
  status: "completed",
  actorCount: 2,
  actorAuthCount: 2,
  engagement: "assess",
});
assert(!bulkBlocked.allowed, `bulk skip must block completed: ${bulkBlocked.reason}`);

// --- S1: traffic inventory empty on multi-endpoint API ---
const surfaceRows: CoverageLikeRow[] = [
  row("/api/Users", "id", "idor", "failed", "dual-actor | actor=a | alt_actor=b"),
  row("/api/Orders", "id", "idor", "failed", "dual-actor | actor=a | alt_actor=b"),
  row("/rest/user/login", "email", "sql-injection", "passed", "no injection"),
  row("/api/Products", "q", "sql-injection", "passed", "no injection"),
  row("/rest/user/whoami", "authorization", "jwt-alg-none", "passed", "rejected"),
];
const trafficGaps = attackSurfaceGaps(surfaceRows, {
  trafficCount: 0,
  trafficEndpointCount: 0,
  trafficCandidateCount: 0,
});
assert(trafficGaps.some((gap) => gap.family === "traffic_inventory"), `expected traffic_inventory: ${JSON.stringify(trafficGaps)}`);

const thinVsTraffic = attackSurfaceGaps(surfaceRows.slice(0, 3), {
  trafficCount: 40,
  trafficEndpointCount: 12,
  trafficCandidateCount: 8,
});
assert(
  thinVsTraffic.some((gap) => gap.family === "traffic_to_coverage" || gap.family === "attack_surface_breadth"),
  `expected traffic→coverage breadth gap: ${JSON.stringify(thinVsTraffic)}`,
);

// --- S2: multi-actor missing / breadth ---
const multiRows: CoverageLikeRow[] = [
  row("/api/Baskets/1", "id", "idor", "observed"),
  row("/api/Orders/1", "id", "idor", "observed"),
  row("/api/Feedbacks/1", "id", "idor", "observed"),
  row("/api/Users/1", "id", "idor", "observed"),
];
const noActor = multiActorTestingGaps(multiRows, 0, 0);
assert(noActor.some((gap) => gap.family === "multi_actor"), `expected multi_actor: ${JSON.stringify(noActor)}`);

// Contract: one dual-actor + pattern-covered skips on remaining object resources clears breadth.
const oneProbePatternCovered: CoverageLikeRow[] = [
  row("/api/Baskets/1", "id", "idor", "failed", "dual-actor | actor=user_a | alt_actor=user_b"),
  row("/api/Orders/1", "id", "idor", "skipped", "same authz pattern already verified on baskets via dual-actor"),
  row("/api/Feedbacks/1", "id", "idor", "skipped", "same authz pattern already verified on baskets via dual-actor"),
  row("/api/Users/1", "id", "idor", "skipped", "same authz pattern already verified on baskets via dual-actor"),
];
const breadthCleared = multiActorTestingGaps(oneProbePatternCovered, 2, 2);
assert(
  !breadthCleared.some((gap) => gap.family === "multi_actor_breadth"),
  `one dual-actor + pattern-covered skips should clear multi_actor_breadth: ${JSON.stringify(breadthCleared)}`,
);

// Contract: one dual-actor with remaining still observed still requires breadth work.
const oneProbeOpen: CoverageLikeRow[] = [
  row("/api/Baskets/1", "id", "idor", "failed", "dual-actor | actor=user_a | alt_actor=user_b"),
  row("/api/Orders/1", "id", "idor", "observed"),
  row("/api/Feedbacks/1", "id", "idor", "observed"),
  row("/api/Users/1", "id", "idor", "observed"),
];
const breadthOpen = multiActorTestingGaps(oneProbeOpen, 2, 2);
assert(
  breadthOpen.some((gap) => gap.family === "multi_actor_breadth"),
  `one dual-actor with open object resources should keep multi_actor_breadth: ${JSON.stringify(breadthOpen)}`,
);

const twoProbes: CoverageLikeRow[] = [
  row("/api/Baskets/1", "id", "idor", "failed", "dual-actor | actor=user_a | alt_actor=user_b"),
  row("/api/Orders/1", "id", "idor", "passed", "dual-actor | actor=user_a | alt_actor=user_b | isolation holds"),
  row("/api/Feedbacks/1", "id", "idor", "skipped", "same authz pattern already verified on baskets and orders via dual-actor"),
  row("/rest/user/login", "email", "sql-injection", "failed", "union evidence"),
  row("/api/Users", "role", "mass-assignment", "failed", "role accepted"),
];
// Close remaining families that surfaceText may suggest so we only assert multi-actor clearance path.
for (const family of ["xss", "auth_session", "csrf", "business_logic", "file_path", "redirect", "injection", "access_control"]) {
  // not needed for multiActorTestingGaps pure helper
  void family;
}
const multiOk = multiActorTestingGaps(twoProbes, 2, 2);
assert(multiOk.length === 0, `dual-actor on two resources should clear multi-actor gaps: ${JSON.stringify(multiOk)}`);

// Full eligibility happy path (no traffic empty gap because inventory shows traffic)
const happy = finishCompletedEligibility(
  [
    ...twoProbes,
    row("/family/xss", "family", "xss", "skipped", "risk-family skip: no reflected HTML sinks observed in traffic inventory"),
    row("/family/csrf", "family", "csrf", "skipped", "risk-family skip: API uses bearer tokens without cookie session CSRF surface"),
    row("/family/file_path", "family", "file_path", "skipped", "risk-family skip: no file/path parameters observed after recon"),
    row("/family/redirect", "family", "redirect", "skipped", "risk-family skip: no redirect URL parameters observed"),
    row("/family/business_logic", "family", "business_logic", "skipped", "risk-family skip: no cart/price fields observed beyond idor coverage"),
    row("/family/auth_session", "family", "auth_session", "skipped", "risk-family skip: jwt and session checks not applicable beyond login SQLi"),
  ],
  {
    status: "completed",
    actorCount: 2,
    actorAuthCount: 2,
    engagement: "assess",
    surfaceInventory: { trafficCount: 30, trafficEndpointCount: 12, trafficCandidateCount: 6 },
  },
);
assert(happy.allowed, `happy path should allow completed: ${happy.reason}`);

// incomplete always allowed even with gaps
const incomplete = finishCompletedEligibility(weakSkipRows, { status: "incomplete", engagement: "assess" });
assert(incomplete.allowed, "incomplete must remain allowed");

// --- A: noise endpoint denoise ---
assert(isNoiseEndpoint("/api/FUZZ"), "FUZZ is noise");
assert(isNoiseEndpoint("/api/"), "bare /api/ is noise");
assert(isNoiseEndpoint("/rest/"), "bare /rest/ is noise");
assert(isNoiseEndpoint("/."), "dot path is noise");
assert(!isNoiseEndpoint("/api/Users"), "/api/Users is real");
assert(!isNoiseEndpoint("/rest/products/search"), "search path is real");
assert(isObjectLikeResourcePath("/api/Users/1"), "users object path");
assert(!isObjectLikeResourcePath("/rest/products/search"), "search is not object resource");
assert(!isObjectLikeResourcePath("/api/FUZZ"), "FUZZ not object resource");
assert(
  !isHighPriorityCandidate({ endpoint: "/api/FUZZ", param: "id", vulnClass: "idor", status: "observed", priority: 255 }),
  "noise must not be high-priority",
);
assert(
  !isHighPriorityCandidate({ endpoint: "/api/", param: "id", vulnClass: "idor", status: "observed", priority: 255 }),
  "bare api root must not be high-priority",
);

// Noise paths must not inflate multi_actor_breadth
const noisyAc: CoverageLikeRow[] = [
  row("/api/Users", "id", "idor", "failed", "dual-actor | actor=a | alt_actor=b"),
  row("/api/FUZZ", "id", "idor", "observed"),
  row("/api/", "id", "idor", "observed"),
  row("/rest/", "id", "idor", "observed"),
  row("/api/Orders", "id", "idor", "failed", "dual-actor | actor=a | alt_actor=b"),
];
const noiseBreadth = multiActorTestingGaps(noisyAc, 2, 2);
assert(
  !noiseBreadth.some((gap) => gap.family === "multi_actor_breadth"),
  `FUZZ/bare api must not force multi_actor_breadth: ${JSON.stringify(noiseBreadth)}`,
);

// --- B: guidance steers to live probes, not bulk skip ---
const guidance = nextVerifyGuidance(
  [
    { ...row("/api/Users/1", "id", "idor", "observed"), highPriority: true, priority: 255 },
    { ...row("/api/FUZZ", "id", "idor", "observed"), highPriority: true, priority: 255 },
  ] as any,
  [],
  [
    {
      family: "multi_actor_breadth",
      label: "Dual-actor resource breadth",
      suggestedClasses: ["idor"],
      exampleSurfaces: ["/api/Users", "/api/Orders"],
      reason: "need second dual-actor resource",
    },
  ],
  {
    surfaceInventory: { trafficCount: 40, trafficEndpointCount: 12, trafficCandidateCount: 6 },
    coverageRows: [
      row("/api/Users/1", "id", "idor", "observed"),
      row("/api/Orders", "id", "idor", "observed"),
      row("/rest/products/search", "q", "sql-injection", "failed", "union evidence"),
    ],
  },
);
assert(/NEXT LIVE WORK/i.test(guidance), "guidance must front-load next live work");
assert(/before more coverage skip\/block/i.test(guidance), "guidance must discourage bulk skip");
assert(/second distinct object collection/i.test(guidance), "guidance must push second dual-actor resource");
assert(!guidance.includes("/api/FUZZ"), "guidance must omit FUZZ noise endpoints");
assert(/verifier/i.test(guidance), "guidance should suggest verifier");

// --- Mid-run discovery queue: families + traffic + post-confirm breadth ---
const queueRows: CoverageLikeRow[] = [
  row("/api/Users/1", "id", "idor", "failed", "dual-actor | actor=a | alt_actor=b"),
  row("/rest/products/search", "q", "sql-injection", "failed", "boolean differential"),
  row("/rest/user/login", "email", "sql-injection", "observed"),
  row("/api/Feedbacks", "id", "idor", "observed"),
];
const queue = buildDiscoveryQueue(queueRows, {
  actorCount: 2,
  actorAuthCount: 2,
  surfaceInventory: {
    trafficCount: 25,
    trafficEndpointCount: 10,
    trafficCandidateCount: 6,
    trafficPaths: ["/api/Users/1", "/rest/basket/1", "/api/Feedbacks", "/metrics"],
    trafficCandidateUrls: ["http://example.test/rest/basket/1", "http://example.test/metrics"],
  },
  limit: 12,
});
assert(queue.length >= 3, `expected discovery queue items, got ${queue.length}: ${JSON.stringify(queue)}`);
assert(
  queue.some((item) => item.kind === "multi_actor" || item.kind === "coverage_candidate" || item.kind === "traffic_expand" || item.kind === "post_confirm_breadth" || item.kind === "risk_family"),
  "queue should include live-probe kinds",
);
assert(
  queue.some((item) => item.kind === "post_confirm_breadth" || /xss|business-logic|browser/i.test(`${item.title} ${item.toolHint}`)),
  `after confirmed findings, queue should expand families: ${JSON.stringify(queue.map((i) => i.title))}`,
);
assert(
  queue.some((item) => item.kind === "traffic_expand" || (item.endpoint && item.endpoint.includes("basket"))),
  `queue should surface traffic-only paths like basket: ${JSON.stringify(queue)}`,
);
assert(!queue.some((item) => (item.endpoint || "").includes("FUZZ")), "queue must not schedule FUZZ noise");

const payload = formatDiscoveryQueuePayload(queueRows, {
  actorCount: 2,
  actorAuthCount: 2,
  surfaceInventory: {
    trafficCount: 25,
    trafficEndpointCount: 10,
    trafficCandidateCount: 6,
    trafficPaths: ["/rest/basket/1"],
  },
});
assert(payload.count === payload.next_work.length && payload.count > 0, "payload next_work count");
assert(payload.guidance.startsWith("NEXT LIVE WORK"), "payload guidance front-loaded");
assert(/Live proofs|skip/i.test(payload.guidance), "payload guidance mentions live proofs vs skip");

console.log(
  JSON.stringify(
    {
      ok: true,
      checks: [
        "weak_skip_blocks_completed",
        "bulk_skip_blocks_completed",
        "traffic_inventory_gap",
        "traffic_breadth_gap",
        "multi_actor_required",
        "multi_actor_breadth_clears_with_pattern_skips",
        "multi_actor_breadth_open_when_remaining_observed",
        "dual_resource_clears_multi_actor",
        "happy_path_completed",
        "incomplete_allowed",
        "noise_endpoint_denoise",
        "noise_not_high_priority",
        "noise_not_multi_actor_breadth",
        "guidance_prefers_live_probes",
        "discovery_queue_mid_run",
        "discovery_queue_post_confirm_breadth",
        "discovery_queue_traffic_expand",
        "discovery_payload_front_loaded",
      ],
      queue_sample: queue.slice(0, 5).map((item) => ({ kind: item.kind, title: item.title, priority: item.priority })),
    },
    null,
    2,
  ),
);
