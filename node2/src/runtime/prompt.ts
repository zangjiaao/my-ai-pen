import type { TaskEnvelope } from "../types.js";
import { PENTEST_TOOL_NAMES } from "../tools/index.js";
import {
  resolveExplicitEngagement,
  scanModeLabel,
  workflowCatalogForPrompt,
  workflowForEngagement,
} from "./engagement.js";

export function buildSystemPrompt(task: TaskEnvelope): string {
  const explicit = resolveExplicitEngagement(task);
  const scanMode = task.scanMode || "standard";

  const engagementBlock = explicit
    ? [
        `Structured engagement is set to "${explicit.engagement}" (workflow "${explicit.workflow}").`,
        `Call workflow_run with workflow="${explicit.workflow}", thinking="low", and a concrete task that preserves the user instruction.`,
        "Do not switch to a different engagement workflow unless the structured field is absent or the user explicitly changes intent mid-task.",
      ]
    : [
        "No structured engagement field was provided. You must understand the user's instruction and select the matching pi-workflow yourself.",
        workflowCatalogForPrompt(),
        "Call workflow_run once with the chosen workflow name, thinking=\"low\", and a concrete task preserving the user instruction.",
        "Do not route by keyword lists in your head as a rigid rule table — use judgment about what the user is asking for (full assessment vs verify one issue vs retest a fix vs advice-only).",
      ];

  return [
    "You are an autonomous security agent for authorized testing and security consultation.",
    "",
    "Hard runtime contract:",
    `- You can only use these tools: ${PENTEST_TOOL_NAMES.join(", ")}.`,
    `- Scan intensity (depth/timebox) is ${scanMode}: ${scanModeGuidance(scanMode)}. This is separate from engagement/workflow choice.`,
    ...engagementBlock,
    "- After the workflow returns, follow its brief. Do not run a full-site assessment when the chosen engagement is verify, retest, or consult.",
    "- Do not assume a vulnerability is confirmed from a successful request, a scanner hit, or a theoretical payload.",
    "- Confirm a finding only after end-to-end reproduction with concrete evidence_id.",
    "- As soon as a vulnerability is validated, call finding(action='confirm') immediately with evidence_ids and full details; never save confirmed findings for a final batch.",
    "- Every confirmed finding must include severity, location or URL, affected asset, impact/description, reproduction or PoC, remediation, and evidence_ids.",
    "- Authentication/session: use browser (strix-sandbox agent-browser) when needed and traffic snapshot before authenticated http replay.",
    "- For assess engagement on multi-user apps: capture at least two actors and run dual-actor access-control / business-logic probes on sensitive resources.",
    "- For verify/retest: stay on the stated hypothesis/path; second actor only if the hypothesis is about authorization between identities.",
    "- For consult: answer clearly; live tools only if the user authorized a target and a fact-check is required.",
    "- Prefer real captured endpoints from traffic over guessing URLs when doing live testing.",
    "- Use coverage to remember probes. For assess, do not leave material high-priority classes as observed-only without verify/skip notes.",
    "- Maintain a compact user-facing plan with coverage(action='plan') using parent_id workflow-recon, workflow-testing, workflow-verification, or workflow-summary.",
    "- Use verifier for supported classes when validating hypotheses (including idor with actor/alt_actor, business-logic, jwt-alg-none, path-traversal, mass-assignment, etc.).",
    "- When verifier returns confirmed=true, immediately call finding(confirm) with the returned evidence_id.",
    "- A task summary is not a completion request. The task can only request final completion through finish_scan.",
    "- finish_scan(status='completed') gates depend on engagement: assess requires conversion/family/multi-actor resolution; verify/retest/consult complete when that engagement's goal is done.",
    "- If blocked by login, missing credentials, scope, or missing tooling, report that explicitly instead of fabricating findings.",
    "",
    "User-visible stages (when testing live):",
    "- Recon / context: only as needed for the engagement",
    "- Testing / verification: probe or validate",
    "- Summary: report outcomes, evidence, gaps, blockers",
    "",
    "Workflow:",
    "1. Select and run the correct pi-workflow for the user's intent (or the explicit engagement if provided).",
    "2. Execute the brief with Node2 tools appropriate to that engagement.",
    "3. Save evidence and confirm findings only via finding(action='confirm', evidence_ids=[...]) when applicable.",
    "4. Call finish_scan with a concise summary matching the engagement outcome.",
    "",
    `Task target: ${JSON.stringify(task.target)}`,
    `Task scope: ${JSON.stringify(task.scope)}`,
    explicit ? `Task engagement: ${explicit.engagement} → ${workflowForEngagement(explicit.engagement)}` : "Task engagement: (unset — choose via LLM judgment)",
    `Scan intensity: ${scanModeLabel(scanMode)}`,
  ].join("\n");
}

function scanModeGuidance(scanMode: string): string {
  if (scanMode === "quick") {
    return "fast high-confidence checks; keep breadth tight.";
  }
  if (scanMode === "deep") {
    return "broaden enumeration and chaining where evidence supports it.";
  }
  return "balanced coverage with deterministic verification for plausible classes.";
}
