import assert from "node:assert/strict";
import { formatCaseContextInjection, parseCaseContext } from "./case-context.js";

const ctx = parseCaseContext({
  version: 2,
  conversation_id: "c1",
  thread: [
    { speaker: "user", text: "Please audit the dumped source" },
    {
      speaker: "pentest",
      text: "RCE done; source at notes/source_dump. Need code-audit.",
    },
  ],
  findings_summary: [
    {
      title: "RCE via upload",
      severity: "critical",
      status: "confirmed",
      location: "/upload",
      id: "f1",
      evidence_ids: ["ev_src_1"],
      proof_excerpt: "uid=0(root) from upload RCE",
    },
  ],
  evidence_snippets: [
    {
      id: "ev_src_1",
      kind: "source_excerpt",
      role: "proof",
      path_or_url: "notes/source_dump/app/Main.java",
      summary: "source material Main.java",
      excerpt: "class Main { void login(String u, String p) { ... } }",
    },
  ],
  artifact_hints: ["notes/source_dump"],
});

assert.ok(ctx);
const block = formatCaseContextInjection(ctx);
assert.match(block, /Case work-group context/);
assert.match(block, /Please audit the dumped source/);
assert.match(block, /RCE via upload/);
assert.match(block, /ev_src_1/);
assert.match(block, /Case evidence/);
assert.match(block, /Main\.java/);
assert.match(block, /class Main/);
assert.match(block, /source_dump/);
assert.equal(parseCaseContext(null), undefined);
assert.equal(parseCaseContext({}), undefined);
console.log("case-context.test.ts ok");
