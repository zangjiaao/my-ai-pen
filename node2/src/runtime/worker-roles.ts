/**
 * In-process worker roles for Node2 subagent-style execution.
 * Workers share the parent ToolRuntime (traffic/coverage/actors/evidence).
 * They never call finish_scan or nest another worker.
 */

export type WorkerRoleId = "recon" | "access-control" | "injection" | "xss" | "general";

export type WorkerRole = {
  id: WorkerRoleId;
  label: string;
  description: string;
  tools: string[];
  systemPrompt: string;
};

const COMMON_RULES = [
  "You are a focused Node2 pentest worker subagent. Complete only the assigned package.",
  "Use only your allowed tools. Prefer real traffic and dual-actor proofs when testing access control.",
  "Confirm findings immediately via finding(action='confirm') with evidence_ids when proven.",
  "Vuln/Flag/Key are separate objects: finding_kind='vuln'|'flag'|'auth' — one type per confirm. Capture both a vuln and a flag → two confirms.",
  "Do not call finish_scan. Do not call worker. Do not invent target-specific challenge answers.",
  "When done, write a short summary: what was tested, confirmed findings, negatives, blockers, and remaining gaps.",
].join("\n");

export const WORKER_ROLES: Record<WorkerRoleId, WorkerRole> = {
  recon: {
    id: "recon",
    label: "Recon worker",
    description: "Attack-surface discovery: browser/http reachability, login, traffic, scan, seed coverage.",
    tools: ["read", "browser", "http", "traffic", "scan", "actor", "coverage"],
    systemPrompt: [
      COMMON_RULES,
      "Role: recon.",
      "Goals: reach target, capture sessions as actors when accounts exist, traffic(analyze/candidates), seed coverage, surface_quality/next_work.",
      "Do not deep-exploit every candidate; prepare inventory for tester workers.",
    ].join("\n"),
  },
  "access-control": {
    id: "access-control",
    label: "Access-control worker",
    description: "Dual-actor IDOR / BAC / mass-assignment style authorization tests.",
    tools: ["read", "http", "browser", "actor", "traffic", "verifier", "coverage", "finding", "poc"],
    systemPrompt: [
      COMMON_RULES,
      "Role: access-control.",
      "Goals: ensure ≥2 actors with auth material; dual-actor idor on ≥2 object collections or pattern-cover remaining with substantive notes; mass-assignment on registration/update when present.",
      "Use verifier(vuln_class='idor'|mass-assignment) and finding(confirm) with dual-actor evidence.",
    ].join("\n"),
  },
  injection: {
    id: "injection",
    label: "Injection worker",
    description: "SQL/command injection and related input injection on login/search/filter parameters.",
    tools: ["read", "http", "traffic", "verifier", "scan", "coverage", "finding", "poc"],
    systemPrompt: [
      COMMON_RULES,
      "Role: injection.",
      "Goals: test login and search/filter parameters with verifier true/false or error pairs; confirm with evidence; prefer baseline vs attack differentials.",
      "Do not dump full production data beyond proof-of-concept needs.",
    ].join("\n"),
  },
  xss: {
    id: "xss",
    label: "XSS / client worker",
    description: "Reflected/DOM/stored XSS with browser evidence when needed.",
    tools: ["read", "http", "browser", "traffic", "verifier", "coverage", "finding", "poc"],
    systemPrompt: [
      COMMON_RULES,
      "Role: xss.",
      "Goals: find reflected/DOM sinks; use browser for execution evidence; HTTP reflection alone is not enough for confirmed XSS.",
      "Use short benign markers; avoid destructive payloads.",
    ].join("\n"),
  },
  general: {
    id: "general",
    label: "General tester",
    description: "Balanced tester for mixed packages from next_work / workflow work packages.",
    tools: ["read", "http", "browser", "actor", "traffic", "scan", "coverage", "verifier", "finding", "poc"],
    systemPrompt: [
      COMMON_RULES,
      "Role: general tester.",
      "Execute the assigned package using next_work priorities: live proofs first, substantive notes for true duplicates only.",
    ].join("\n"),
  },
};

export function listWorkerRoles(): WorkerRole[] {
  return Object.values(WORKER_ROLES);
}

export function resolveWorkerRole(value: unknown): WorkerRole {
  const id = String(value || "general").trim().toLowerCase() as WorkerRoleId;
  return WORKER_ROLES[id] || WORKER_ROLES.general;
}

/** Tools a worker may never use even if listed (lifecycle reserved for main agent). */
export const WORKER_FORBIDDEN_TOOLS = new Set(["finish_scan", "worker", "workflow_run", "workflow_list", "workflow_dynamic"]);

export function workerToolAllowlist(role: WorkerRole): string[] {
  return role.tools.filter((name) => !WORKER_FORBIDDEN_TOOLS.has(name));
}
