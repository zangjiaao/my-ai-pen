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
assert.match(block, /^### Case/m);
assert.doesNotMatch(block, /### Thread/);
assert.doesNotMatch(block, /Please audit the dumped source/);
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
assert.match(block, /Case Workset \(pending admission\)/);
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
const withHost = parseCaseContext({
  next_work: { workset_open: [{ id: "x", family: "t_host", host: "a.example.com" }] },
});
assert.equal(withHost!.next_work!.workset_open?.[0]?.host, "a.example.com");
const intakeOnly = parseCaseContext({
  next_work: { asset_intake: { mode: "enroll_group", group_name: "example公司" } },
});
assert.ok(intakeOnly);
assert.equal(intakeOnly!.next_work!.asset_intake?.mode, "enroll_group");
assert.match(formatCaseContextInjection(intakeOnly), /enroll_group/);
assert.match(formatCaseContextInjection(intakeOnly), /example公司/);
assert.match(formatCaseContextInjection(intakeOnly), /Not user-confirmed/);
assert.doesNotMatch(formatCaseContextInjection(intakeOnly), /Eligible new hosts enroll/);
const intakeUser = parseCaseContext({
  next_work: { asset_intake: { mode: "enroll_group", group_name: "example公司", set_by: "user" } },
});
assert.match(formatCaseContextInjection(intakeUser), /user-confirmed/);
assert.match(formatCaseContextInjection(intakeUser), /Eligible new hosts enroll/);
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

{
  const withCoverage = formatCaseContextInjection({
    scope_intel: {
      hosts: [{ id: "asset-1", address: "lab.example", ports: ["443"], on_ledger: true }],
      surface_sketch: {
        this_case_surface_count: 4,
        new: 1,
        untested: 2,
        tested: 1,
        skipped: 1,
        untested_samples: ["/login", "/api/Users"],
      },
      prior_findings: { total: 3, open_or_retest: 2 },
    },
    next_work: {
      workset_open_count: 1,
      workset_open: [{ id: "ws_1", family: "t_host", title: "side.lab", status: "proposed" }],
      asset_intake: { mode: "enroll_group", group_name: "lab", set_by: "user" },
    },
    intel_summary: [{ id: "i1", summary: "cookie session", kind: "credential_status" }],
  });
  assert.match(withCoverage, /id=asset-1/);
  assert.match(withCoverage, /Coverage/);
  assert.match(withCoverage, /untested=2/);
  assert.match(withCoverage, /tested=1/);
  assert.match(withCoverage, /skipped=1/);
  assert.match(withCoverage, /\/login/);
  assert.match(withCoverage, /Living notebook/);
  assert.match(withCoverage, /enroll_group/);
  assert.match(withCoverage, /ws_1|side\.lab/);
  assert.match(withCoverage, /Prior findings/);
  assert.doesNotMatch(withCoverage, /platform_list_assets first/i);
  assert.doesNotMatch(withCoverage, /list_assets first/i);
}

{
  const capped = formatCaseContextInjection({
    scope_intel: {
      hosts: [{ id: "asset-1", address: "lab.example", on_ledger: true }],
      surface_sketch: {
        untested: 8,
        untested_samples: ["/a", "/b", "/c", "/d", "/e", "/f", "/g"],
      },
    },
  });
  assert.match(capped, /\/a/);
  assert.match(capped, /\/e/);
  assert.doesNotMatch(capped, /\/f/);
}

{
  const mixed = formatCaseContextInjection(
    {
      scope_intel: {
        hosts: [{ address: "host.docker.internal", on_ledger: true, ports: ["3000", "8080"] }],
        prior_findings: { total: 196, open_or_retest: 196 },
        surface_sketch: {
          known_paths: ["/rest/user"],
          sample_urls: [
            "http://host.docker.internal:3000/",
            "http://host.docker.internal:8080/vulnerabilities/sqli/",
          ],
        },
      },
    },
    { engagementPort: "3000" },
  );
  assert.match(mixed, /on Scope port :3000/);
  assert.match(mixed, /:3000\//);
  assert.doesNotMatch(mixed, /vulnerabilities\/sqli/);
}
{
  const sessionFacts = formatCaseContextInjection({
    conversation_id: "c-sess",
    session_confirms: 2,
    session_new_identities: 1,
    findings_summary: [
      { title: "SQLi", status: "confirmed", location: "/login", created: true },
      { title: "XSS", status: "confirmed", location: "/search", created: false },
    ],
  });
  assert.match(sessionFacts, /This session: confirms=2 new_ledger_identities=1/);
  assert.doesNotMatch(sessionFacts, /platform_list_vulnerabilities/);
}

console.log("case-context.test.ts ok");
