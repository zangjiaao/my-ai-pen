/**
 * Verbatim booking from subagent candidates.
 * Run: npx tsx src/runtime/subagent-booking.test.ts
 */
import assert from "node:assert/strict";
import {
  rememberSubagentEvidence,
  resolveBookingMaterialFromSubagentEvidence,
  fallbackProofFromInjectedCandidates,
  pathKey,
  pathsMatch,
  formatBookingHelpHint,
} from "./subagent-booking.js";
import { injectParentObservationsFromChild } from "../tools/subagent.js";
import { proofGroundedInRecentWork } from "../tools/common.js";
import { normalizeSubagentResult } from "./subagent-result.js";
import { evaluateCandidatesForAcceptance } from "./subagent-result.js";
import type { ToolRuntime } from "../types.js";

const runtime = {
  lifecycle: {
    recentObservations: [] as import("../tools/common.js").RecentObservation[],
    subagentEvidenceCache: [] as import("./subagent-booking.js").LastSubagentEvidence[],
  },
} as unknown as ToolRuntime;

const proof =
  "You have an error in your SQL syntax; check the manual that corresponds to your MariaDB server version for the right syntax to use near ''' at line 1";
const structured = normalizeSubagentResult({
  structured: {
    ok: true,
    summary: "sqli ok",
    candidates: [
      {
        title: "SQL Injection",
        location: "http://127.0.0.1:8080/vulnerabilities/sqli/?id=1%27%20UNION%20SELECT%201",
        claim: "error-based",
        proof_excerpt: proof,
        poc_hint: "GET id=1' → MariaDB syntax error in response body",
      },
    ],
    facts: [],
    deadends: [],
    artifacts: [],
  },
});

injectParentObservationsFromChild(runtime, {
  subagentId: "sub_1",
  nodeType: "class_probe",
  structured,
  summary: structured.summary,
});
const acceptance = evaluateCandidatesForAcceptance(structured.candidates);
rememberSubagentEvidence(runtime, {
  subagentId: "sub_1",
  nodeType: "class_probe",
  candidates: structured.candidates,
  acceptance,
  at: Date.now(),
});

// Empty shell package must NOT wipe cache
rememberSubagentEvidence(runtime, {
  subagentId: "sub_shell",
  nodeType: "class_probe",
  candidates: [],
  at: Date.now(),
});
assert.ok(
  (runtime.lifecycle.subagentEvidenceCache || []).some((p) => p.subagentId === "sub_1"),
  "cache keeps prior package with candidates",
);

// pathKey ignores query / + vs %20
assert.equal(
  pathKey("http://t/vulnerabilities/sqli/?id=1%27+UNION"),
  pathKey("http://t/vulnerabilities/sqli/?id=1' UNION"),
);
assert.ok(
  pathsMatch(
    "http://127.0.0.1:8080/vulnerabilities/sqli/?id=1%27+UNION+SELECT",
    "http://127.0.0.1:8080/vulnerabilities/sqli/?id=1%27%20UNION%20SELECT%201",
  ),
);

// Matched by location with different query encoding
const mat = resolveBookingMaterialFromSubagentEvidence(runtime, {
  title: "SQL 注入",
  location: "http://127.0.0.1:8080/vulnerabilities/sqli/?id=1%27+UNION+SELECT+user()",
  proof: "there was a database error somehow",
  poc: "short",
});
assert.ok(mat, "expected material");
assert.equal(mat!.proof, proof);
assert.match(mat!.poc, /GET id/);

const g = proofGroundedInRecentWork(mat!.proof, runtime.lifecycle.recentObservations);
assert.equal(g.ok, true, `ground: ${g.reason}`);

const byIdx = resolveBookingMaterialFromSubagentEvidence(runtime, {
  title: "x",
  location: "http://127.0.0.1:8080/vulnerabilities/sqli/",
  candidate_index: 0,
});
assert.equal(byIdx?.proof, proof);

const fb = fallbackProofFromInjectedCandidates(runtime, {
  title: "SQL Injection",
  location: "/vulnerabilities/sqli/",
});
assert.equal(fb?.proof, proof);

const hint = formatBookingHelpHint(runtime);
assert.match(hint, /candidate_index|global#|\[0\]/);

console.log("subagent-booking.test.ts: ok");
