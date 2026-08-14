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
  next_work: {
    boundary: "case_assign",
    workset_open_count: 2,
    workset_open: [
      { id: "w1", family: "t_surface", title: "/admin", status: "adopted" },
      { id: "h1", family: "t_host", title: "side.lab", status: "proposed" },
    ],
    goal: { status: "running", terminal: null as unknown as undefined },
  },
  scope_intel: {
    version: 1,
    hosts: [
      {
        id: "asset-1",
        address: "host.docker.internal",
        name: "本机docker",
        ports: ["3000"],
        on_ledger: true,
        services: [{ port: "3000", name: "http", note: "JuiceShop" }],
      },
    ],
    prior_findings: { total: 50, open_or_retest: 40, by_severity: { critical: 10, high: 15 } },
    high_priority_sample: [
      { id: "v1", severity: "critical", title: "SQLi login", location: "/rest/user/login" },
    ],
    surface_sketch: { known_paths: ["/rest/user/login", "/api/Users"], this_case_surface_count: 0 },
  },
});

assert.ok(ctx);
assert.ok(ctx!.next_work);
assert.equal(ctx!.next_work!.workset_open_count, 2);
assert.equal(ctx!.next_work!.workset_open?.[0]?.id, "w1");
assert.ok(ctx!.scope_intel);
assert.equal(ctx!.scope_intel!.hosts?.[0]?.address, "host.docker.internal");
const block = formatCaseContextInjection(ctx);
assert.match(block, /Case work-group context/);
assert.match(block, /Please audit the dumped source/);
assert.match(block, /RCE via upload/);
assert.match(block, /Scope Host memory/);
assert.match(block, /host\.docker\.internal/);
assert.match(block, /Prior findings/);
assert.match(block, /SQLi login/);
assert.match(block, /Known path sketch/);
assert.match(block, /This Case findings board/);
assert.match(block, /finding\(confirm\)/);
assert.match(block, /this Case/i);
assert.match(block, /ev_src_1/);
assert.match(block, /Case evidence/);
assert.match(block, /Main\.java/);
assert.match(block, /class Main/);
assert.match(block, /source_dump/);
// Spec #312 S5: next_work retained + formatted
assert.match(block, /Case Next \/ Workset \(open\)/);
assert.match(block, /id=w1/);
assert.match(block, /\/admin/);
assert.match(block, /next_steps/);
assert.equal(parseCaseContext(null), undefined);
assert.equal(parseCaseContext({}), undefined);
// next_work alone is enough to parse
const onlyNext = parseCaseContext({
  next_work: { workset_open_count: 1, workset_open: [{ id: "x", title: "t" }] },
});
assert.ok(onlyNext);
assert.equal(onlyNext!.next_work!.workset_open?.[0]?.id, "x");
// scope_intel alone is enough to parse
const onlyIntel = parseCaseContext({
  scope_intel: { hosts: [{ address: "lab.local", on_ledger: true }] },
});
assert.ok(onlyIntel);
assert.equal(onlyIntel!.scope_intel!.hosts?.[0]?.address, "lab.local");
console.log("case-context.test.ts ok");
