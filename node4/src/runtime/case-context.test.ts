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
      {
        id: "v1",
        severity: "critical",
        title: "SQLi login",
        location: "/rest/user/login",
        summary: "UNION extract on /rest/user/login id=",
        discoveries: 4,
      },
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
assert.match(block, /^### Case/m);
assert.match(block, /Please audit the dumped source/);
assert.match(block, /RCE via upload/);
assert.match(block, /### Scope hosts/);
assert.match(block, /host\.docker\.internal/);
assert.match(block, /Prior findings/);
assert.match(block, /SQLi login/);
assert.match(block, /UNION extract/);
assert.match(block, /×4/);
assert.match(block, /### Prior catalog/);
assert.doesNotMatch(block, /interleaved re-verify/i);
assert.doesNotMatch(block, /\{"[a-z_]+":/);
assert.match(block, /### Paths seen/);
assert.match(block, /### This Case findings/);
assert.match(block, /ev_src_1/);
assert.match(block, /### Evidence/);
assert.match(block, /Main\.java/);
assert.match(block, /class Main/);
assert.match(block, /source_dump/);
assert.match(block, /### Next \(open\)/);
assert.match(block, /w1/);
assert.match(block, /\/admin/);
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
const onlyClues = parseCaseContext({
  intel_summary: [{ id: "i1", summary: "admin:admin invalid", kind: "credential_status", asset_id: "a1" }],
});
assert.ok(onlyClues);
assert.equal(onlyClues!.intel_summary?.[0]?.id, "i1");
assert.match(formatCaseContextInjection(onlyClues), /Living notebook/);
assert.match(formatCaseContextInjection(onlyClues), /admin:admin invalid/);
assert.match(formatCaseContextInjection(onlyClues), /fact\(op=get/);
assert.doesNotMatch(formatCaseContextInjection(onlyClues), /platform_get_intel/);

// Living creds must outrank prior-finding dumps and non-login clues (ef6326fd: agent
// saw gordonb/test123 but recovered hashes via RCE after default admin/password).
const credsVsPriors = formatCaseContextInjection({
  intel_summary: [
    { id: "p1", summary: "instructions.php?doc= whitelist only", kind: "path_hint", asset_id: "a1", port: "8080" },
    { id: "c1", summary: "DVWA 8080 登录凭据：gordonb/test123 有效", kind: "credential_status", asset_id: "a1", port: "8080" },
  ],
  scope_intel: {
    hosts: [{ address: "host.docker.internal", on_ledger: true, ports: ["8080"] }],
    prior_findings: { total: 298, open_or_retest: 298, by_severity: { critical: 67 } },
    high_priority_sample: [{ id: "v1", severity: "critical", title: "Unauth RCE cmd_shell.php" }],
  },
});
const credAt = credsVsPriors.indexOf("gordonb/test123");
assert.ok(credAt >= 0, "credential summary must be injected");
assert.ok(credAt < credsVsPriors.indexOf("Prior findings"), "living notebook before prior dump");
assert.ok(credAt < credsVsPriors.indexOf("instructions.php"), "credential kind before path_hint");
assert.match(credsVsPriors, /Use first \(try these creds/);
console.log("case-context.test.ts ok");
