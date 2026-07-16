import assert from "node:assert/strict";
import {
  assessBookingChainQuality,
  FINDING_TOOL_DESCRIPTION,
  eagerBookingInjection,
} from "../runtime/booking-harness.js";
import {
  bookTimeEvidenceData,
  proofGroundedInRecentWork,
  type RecentObservation,
} from "./common.js";
import {
  countEvidenceReuse,
  evidenceExcerptSupportsLocation,
  extractSupportMaterial,
  locationTokens,
  MAX_OTHER_FINDINGS_PER_EVIDENCE,
  pocDemonstratesIssue,
} from "./finding.js";

assert.ok(locationTokens("http://host/vulnerabilities/sqli/").some((t) => t.includes("sqli") || t.includes("vulnerabilities")));
assert.ok(evidenceExcerptSupportsLocation("got First name from /vulnerabilities/sqli/?id=1", "http://x/vulnerabilities/sqli/"));
assert.ok(
  pocDemonstratesIssue(
    "1) Visit /vulnerabilities/sqli/?id=1 OR 1=1&Submit=Submit → returns all users First name rows",
  ).ok,
  "Visit + path + observation counts as PoC action",
);

const reuse = countEvidenceReuse([
  { evidence_ids: ["ev_a", "ev_b"] },
  { evidence_ids: ["ev_a"] },
]);
assert.equal(reuse.get("ev_a"), 2);
assert.ok(MAX_OTHER_FINDINGS_PER_EVIDENCE >= 2);

const support = extractSupportMaterial({
  summary: "session login",
  data: { method: "POST", url: "http://x/login.php", status: 302, body_preview: "Redirect" },
});
assert.ok(support.ok, "login can be optional supporting material");

// Book-time proof grounding
const recent: RecentObservation[] = [
  {
    sourceTool: "shell",
    summary: "shell exit=0",
    excerpt:
      "=== SQLi ===\n<pre>You have an error in your SQL syntax; check the manual near ''1''' at line 1</pre>",
    path_or_url: "http://x/vulnerabilities/sqli/",
    at: Date.now(),
  },
];
const grounded = proofGroundedInRecentWork(
  "You have an error in your SQL syntax; check the manual near ''1''' at line 1",
  recent,
);
assert.ok(grounded.ok, "proof must match recent tool output");
assert.ok(grounded.match, "match carries how-captured observation");
const halluc = proofGroundedInRecentWork("totally fabricated uid=0(root) never seen", recent);
assert.equal(halluc.ok, false, "hallucinated proof rejected");

// How-captured payload includes command when match has capture
const withCap: RecentObservation[] = [
  {
    sourceTool: "shell",
    summary: "shell",
    excerpt: "uid=33(www-data) gid=33(www-data)",
    path_or_url: "http://x/vulnerabilities/exec/",
    capture: {
      via: "shell",
      command: "curl -s -d 'ip=127.0.0.1;id' http://x/vulnerabilities/exec/",
      status: 0,
    },
    at: Date.now(),
  },
];
const g2 = proofGroundedInRecentWork("uid=33(www-data) gid=33(www-data)", withCap);
assert.ok(g2.ok && g2.match?.capture?.command);
const payload = bookTimeEvidenceData({
  title: "CMDi",
  location: "/vulnerabilities/exec/",
  proofText: "uid=33(www-data) gid=33(www-data)",
  match: g2.match,
});
assert.ok(String(payload.command || "").includes("id"), "book-time evidence keeps shell command");
assert.ok(String(payload.how_captured || "").length > 0, "how_captured label set");
assert.equal(payload.observation, "uid=33(www-data) gid=33(www-data)");

// Stored XSS pattern: write script → run → book proof from stdout → keep script body + result
import { recordActObservation, enrichMatchWithScriptBody } from "./common.js";
// (recordActObservation needs runtime — covered by integration smoke; unit-check enrich only)
const writeObs: RecentObservation = {
  sourceTool: "write",
  summary: "write scripts/x.py",
  excerpt: "import requests\nprint('hi')",
  path_or_url: "scripts/x.py",
  capture: { via: "write", script_path: "scripts/x.py", script_preview: "import requests\nprint('hi')" },
  at: 1,
};
const runObs: RecentObservation = {
  sourceTool: "shell",
  summary: "run",
  excerpt: "Name: <script>alert(1)</script>",
  capture: { via: "shell", command: "python3 scripts/x.py" },
  at: 2,
};
const enriched = enrichMatchWithScriptBody(runObs, [writeObs, runObs]);
assert.ok(String(enriched.capture?.script_preview || "").includes("import requests"), "attach script body from write");

assert.ok(FINDING_TOOL_DESCRIPTION.includes("proof"), "tool describes proof field");
assert.ok(eagerBookingInjection().includes("proof"), "eager booking mentions proof");
assert.ok(FINDING_TOOL_DESCRIPTION.includes("do not look up"), "primary path avoids evidence_ids hunt");

// Single book-time proof is healthy
const single = assessBookingChainQuality({
  evidenceIds: ["ev_booked"],
  location: "http://x/vulnerabilities/xss_r/",
  proofExcerpts: [
    {
      evidence_id: "ev_booked",
      excerpt: "Hello <script>alert(1)</script>",
      role: "proof",
    },
  ],
  reuseCounts: new Map(),
  locationSupported: evidenceExcerptSupportsLocation,
});
assert.equal(single.nudge, "", "single strong proof: no soft nag");

console.log("finding.reuse.test.ts ok");
