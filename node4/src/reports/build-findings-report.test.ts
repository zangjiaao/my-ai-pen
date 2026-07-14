/**
 * Run via: npx tsx src/reports/build-findings-report.test.ts
 * Asserts pure report builder includes real finding titles (no theater).
 */
import { buildFindingsReportMarkdown } from "./build-findings-report.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const md = buildFindingsReportMarkdown({
  title: "Lab report",
  target: "http://127.0.0.1:8080",
  scope: "http://127.0.0.1:8080",
  engagement: "pentest",
  findings: [
    {
      title: "SQL Injection on /search",
      severity: "high",
      description: "Boolean differential on q",
      remediation: "parameterized queries",
      evidence_ids: ["ev-a"],
    },
    {
      title: "Stored XSS guestbook",
      severity: "medium",
      description: "script persists",
    },
  ],
  evidenceById: { "ev-a": { summary: "diff status 200 vs 500" } },
});

assert(md.includes("SQL Injection on /search"), "title high finding");
assert(md.includes("Stored XSS guestbook"), "title medium finding");
assert(md.includes("high"), "severity high");
assert(md.includes("parameterized queries"), "remediation from source");
assert(md.includes("ev-a"), "evidence id");
assert(md.includes("_(none in source data)_"), "no invented CVE when absent");
assert(!md.includes("CVE-2099-9999"), "no fake CVE");
console.log(JSON.stringify({ ok: true, chars: md.length }, null, 2));
