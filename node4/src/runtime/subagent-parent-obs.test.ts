/**
 * Child package → parent recentObservations for finding proof grounding.
 * Run: npx tsx src/runtime/subagent-parent-obs.test.ts
 */
import assert from "node:assert/strict";
import { injectParentObservationsFromChild } from "../tools/subagent.js";
import { proofGroundedInRecentWork } from "../tools/common.js";
import type { ToolRuntime } from "../types.js";
import { normalizeSubagentResult } from "./subagent-result.js";

const runtime = {
  lifecycle: { recentObservations: [] as import("../tools/common.js").RecentObservation[] },
} as unknown as ToolRuntime;

const structured = normalizeSubagentResult({
  kind: "llm_session",
  structured: {
    ok: true,
    summary: "tested sqli module",
    candidates: [
      {
        title: "SQL Injection",
        location: "http://127.0.0.1:8080/vulnerabilities/sqli/",
        claim: "error-based",
        proof_excerpt:
          "You have an error in your SQL syntax; check the manual that corresponds to your MariaDB server version",
        poc_hint: "GET id=1' → MariaDB syntax error in response body",
      },
    ],
    facts: [{ key: "auth", summary: "logged in as admin" }],
    deadends: [],
    artifacts: [],
  },
});

injectParentObservationsFromChild(runtime, {
  subagentId: "sub_test_1",
  nodeType: "class_probe",
  artifactPath: "/tmp/result.json",
  structured,
  summary: structured.summary,
});

const obs = runtime.lifecycle.recentObservations || [];
assert.ok(obs.length >= 2, `expected package + candidate observations, got ${obs.length}`);

const proof =
  "You have an error in your SQL syntax; check the manual that corresponds to your MariaDB server version";
const grounded = proofGroundedInRecentWork(proof, obs);
assert.equal(grounded.ok, true, `proof should ground: ${JSON.stringify(grounded)}`);

console.log("subagent-parent-obs.test.ts: ok");
