import assert from "node:assert/strict";
import { formatCaseContextInjection, parseCaseContext } from "./case-context.js";

const ctx = parseCaseContext({
  version: 1,
  conversation_id: "c1",
  thread: [
    { speaker: "user", text: "Please audit the dumped source" },
    {
      speaker: "pentest",
      text: "RCE done; source at /tmp/source_dump. Need code-audit.",
    },
  ],
  findings_summary: [
    {
      title: "RCE via upload",
      severity: "critical",
      status: "confirmed",
      location: "/upload",
      id: "f1",
    },
  ],
  artifact_hints: ["/tmp/source_dump"],
});

assert.ok(ctx);
const block = formatCaseContextInjection(ctx);
assert.match(block, /Case work-group context/);
assert.match(block, /Please audit the dumped source/);
assert.match(block, /RCE via upload/);
assert.match(block, /source_dump/);
assert.equal(parseCaseContext(null), undefined);
assert.equal(parseCaseContext({}), undefined);
console.log("case-context.test.ts ok");
