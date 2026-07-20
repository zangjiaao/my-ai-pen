/**
 * Unit tests: subagent structured result contract.
 * Run: npx tsx src/runtime/subagent-result.test.ts
 */
import assert from "node:assert/strict";
import {
  normalizeSubagentResult,
  formatSubagentReturnContractPrompt,
} from "./subagent-result.js";

const n1 = normalizeSubagentResult({
  ok: true,
  summary: "probed login",
  candidates: [
    {
      title: "SQLi",
      location: "http://t/login",
      claim: "error-based",
      proof_excerpt: "SQL syntax error",
    },
  ],
  facts: [{ key: "ports", summary: "80 open" }],
  deadends: ["xss blocked"],
  artifacts: ["notes/a.txt"],
});
assert.equal(n1.ok, true);
assert.equal(n1.candidates.length, 1);
assert.equal(n1.candidates[0]!.title, "SQLi");
assert.equal(n1.facts[0]!.key, "ports");
assert.deepEqual(n1.deadends, ["xss blocked"]);

const n2 = normalizeSubagentResult({
  data: {
    summary: "nested",
    candidates: [{ location: "/x", claim: "c" }],
  },
});
assert.match(n2.summary, /nested/);
assert.equal(n2.candidates[0]!.location, "/x");

const n3 = normalizeSubagentResult(null, "fallback summary");
assert.equal(n3.summary, "fallback summary");
assert.equal(n3.candidates.length, 0);

assert.match(formatSubagentReturnContractPrompt(), /result\.json/);
assert.match(formatSubagentReturnContractPrompt(), /finding/);
assert.match(formatSubagentReturnContractPrompt(), /non-empty/);

// Nested structured candidates (llm_session payload shape from lab)
const nested = normalizeSubagentResult({
  kind: "llm_session",
  summary: "outer",
  structured: {
    ok: true,
    summary: "inner tested sqli",
    candidates: [
      {
        title: "SQLi",
        location: "http://t/sqli",
        claim: "union",
        proof_excerpt: "You have an error in your SQL syntax near",
        poc_hint: "GET id=1' → syntax error",
      },
    ],
    facts: [],
    deadends: [],
    artifacts: [],
  },
});
assert.equal(nested.candidates.length, 1);
assert.match(nested.candidates[0]!.proof_excerpt || "", /SQL syntax/);

import {
  buildParentObservationBlob,
  evaluateCandidatesForAcceptance,
} from "./subagent-result.js";
const blob = buildParentObservationBlob(nested);
assert.match(blob, /SQL syntax/);

// Acceptance: ready vs needs_more
const accReady = evaluateCandidatesForAcceptance([
  {
    title: "SQLi",
    location: "http://t/sqli",
    claim: "union",
    proof_excerpt: "You have an error in your SQL syntax near ''' at line 1",
    poc_hint: "GET id=1' → MariaDB syntax error in response body",
  },
]);
assert.equal(accReady.ready_to_book.length, 1);
assert.equal(accReady.needs_more_evidence.length, 0);
assert.match(accReady.ready_to_book[0]!.proof_excerpt, /SQL syntax/);

const accGap = evaluateCandidatesForAcceptance([
  {
    title: "Maybe XSS",
    location: "",
    proof_excerpt: "short",
    poc_hint: "try alert",
  },
]);
assert.equal(accGap.ready_to_book.length, 0);
assert.ok(accGap.needs_more_evidence.length === 1);
assert.ok(accGap.needs_more_evidence[0]!.gaps.length >= 2);

const accEmpty = evaluateCandidatesForAcceptance([], { usedCommandOnly: true });
assert.ok(accEmpty.package_gaps.some((g) => /command=/.test(g)));

// Surfaces normalize + surface package gap
const withSurfaces = normalizeSubagentResult({
  summary: "mapped modules",
  surfaces: [
    { location: "http://t/vulnerabilities/sqli/", kind: "form", params: ["id"] },
    "http://t/vulnerabilities/xss_r/",
  ],
  candidates: [],
});
assert.equal(withSurfaces.surfaces.length, 2);
assert.equal(withSurfaces.surfaces[0]!.kind, "form");

const nestedSurf = normalizeSubagentResult({
  structured: {
    surfaces: [{ location: "/admin", kind: "page" }],
    candidates: [],
  },
});
assert.equal(nestedSurf.surfaces[0]!.location, "/admin");

const surfaceGap = evaluateCandidatesForAcceptance([], {
  nodeType: "surface",
  surfaces: [],
});
assert.ok(surfaceGap.package_gaps.some((g) => /surfaces\[\]/.test(g)));

const surfaceOk = evaluateCandidatesForAcceptance([], {
  nodeType: "surface",
  surfaces: [{ location: "http://t/login.php" }],
});
assert.equal(surfaceOk.surfaces_accepted, 1);
assert.ok(!surfaceOk.package_gaps.some((g) => /surfaces\[\]/.test(g)));

const classEmpty = evaluateCandidatesForAcceptance([], { nodeType: "class_probe" });
assert.ok(classEmpty.package_gaps.some((g) => /candidates\[\]/.test(g)));

console.log("subagent-result.test.ts: ok");
