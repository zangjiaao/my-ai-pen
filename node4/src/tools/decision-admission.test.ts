/**
 * Host admission tool result + live Scope apply (review: no false adopt; refresh Scope).
 * Run: npx tsx src/tools/decision-admission.test.ts
 */
import assert from "node:assert/strict";
import { applyServerScopeToTask, hostAdmissionContinueMessage } from "./decision.js";

{
  const msg = hostAdmissionContinueMessage({
    adoptedTHostIds: ["ws_1"],
    boundWorkset: true,
    authorizedHosts: false,
  });
  assert.match(String(msg), /adopted matching Workset t_host/);
}

{
  const msg = hostAdmissionContinueMessage({
    adoptedTHostIds: [],
    boundWorkset: true,
    authorizedHosts: false,
  });
  assert.match(String(msg), /did not adopt/);
  assert.match(String(msg), /Do not claim Hosts were admitted/);
  assert.match(String(msg), /platform_list_assets/);
  assert.match(String(msg), /do not emit another decision card/);
  assert.doesNotMatch(String(msg), /ask for a Host id/);
  assert.doesNotMatch(String(msg), /adopted matching Workset t_host/);
}

{
  const msg = hostAdmissionContinueMessage({
    adoptedTHostIds: [],
    boundWorkset: true,
    authorizedHosts: true,
  });
  assert.match(String(msg), /did not adopt those Workset rows/);
  assert.match(String(msg), /stay proposed/);
  assert.match(String(msg), /Scope was not written/);
  assert.match(String(msg), /do not emit another decision card/);
  assert.doesNotMatch(String(msg), /ask for a Host id/);
  assert.doesNotMatch(String(msg), /authorized those Hosts as this Case Scope/);
  assert.doesNotMatch(String(msg), /adopted matching Workset t_host/);
}

{
  const msg = hostAdmissionContinueMessage({
    adoptedTHostIds: [],
    boundWorkset: true,
    authorizedHosts: false,
    admissionAmbiguous: [{ host: "example.com", asset_ids: ["a", "b"] }],
  });
  assert.match(String(msg), /identity is ambiguous/);
  assert.match(String(msg), /Surface/);
  assert.doesNotMatch(String(msg), /ask for a Host id/);
}

{
  const msg = hostAdmissionContinueMessage({
    adoptedTHostIds: [],
    boundWorkset: false,
    authorizedHosts: true,
  });
  assert.match(String(msg), /Continue from this Case Scope\/Workset/);
  assert.match(String(msg), /platform_list_assets/);
  assert.doesNotMatch(String(msg), /did not adopt/);
}

{
  const msg = hostAdmissionContinueMessage({
    adoptedTHostIds: [],
    boundWorkset: false,
    authorizedHosts: false,
    customAnswer: true,
  });
  assert.match(String(msg), /custom answer/);
  assert.match(String(msg), /did not NLP/);
  assert.match(String(msg), /newly named/);
  assert.match(String(msg), /not every proposed Workset row/);
  assert.match(String(msg), /Do not ask for a Host id/);
  assert.doesNotMatch(String(msg), /those still-proposed Workset hostnames/);
  assert.doesNotMatch(String(msg), /User named or described which hosts to admit/);
  assert.doesNotMatch(String(msg), /already-adopted Hosts were not admitted/);
}

{
  const msg = hostAdmissionContinueMessage({
    adoptedTHostIds: [],
    liveAdoptedTHostIds: ["ws_www"],
    boundWorkset: false,
    authorizedHosts: false,
    customAnswer: true,
  });
  assert.match(String(msg), /already has adopted Hosts/);
  assert.match(String(msg), /newly named/);
  assert.match(String(msg), /not every proposed Workset row/);
  assert.match(String(msg), /Do not claim already-adopted Hosts were not admitted/);
  assert.doesNotMatch(String(msg), /Call workset\(adopt, hosts=the proposed/);
  assert.doesNotMatch(String(msg), /those still-proposed Workset hostnames/);
}

{
  const msg = hostAdmissionContinueMessage({
    adoptedTHostIds: [],
    boundWorkset: false,
    authorizedHosts: false,
  });
  assert.equal(msg, null);
}

{
  const task = { scope: { allow: ["old.example"], asset_ids: [] as string[] } };
  applyServerScopeToTask(task, {
    allow: ["example.com", "www.example.com"],
    asset_ids: ["aid-1"],
  });
  assert.deepEqual(task.scope.allow, ["example.com", "www.example.com"]);
  assert.deepEqual(task.scope.asset_ids, ["aid-1"]);
}

console.log("decision-admission.test.ts: ok");
