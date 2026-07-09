/**
 * Engagement selects which pi-workflow and completion gates apply.
 * Intensity remains scanMode: quick | standard | deep.
 *
 * Intent source of truth (in order):
 * 1) Explicit structured task.engagement (or equivalent field from the product UI)
 * 2) Workflow the agent actually ran (persisted on runtime.workflowRuns)
 * 3) Conservative default: assess / pentest-web
 *
 * Free-text instruction is NOT keyword-scanned here. The LLM chooses the workflow.
 */

import type { ScanMode, TaskEnvelope, WorkflowRunSummary } from "../types.js";

export type Engagement = "assess" | "verify" | "retest" | "consult";

export type EngagementResolution = {
  engagement: Engagement;
  workflow: string;
  source: "explicit" | "workflow" | "default";
  rationale: string;
};

const WORKFLOW_BY_ENGAGEMENT: Record<Engagement, string> = {
  assess: "pentest-web",
  verify: "pentest-verify",
  retest: "pentest-retest",
  consult: "pentest-consult",
};

const ENGAGEMENT_BY_WORKFLOW: Record<string, Engagement> = {
  "pentest-web": "assess",
  "pentest-verify": "verify",
  "pentest-retest": "retest",
  "pentest-consult": "consult",
};

export const ENGAGEMENT_WORKFLOWS = Object.values(WORKFLOW_BY_ENGAGEMENT);

export function workflowForEngagement(engagement: Engagement): string {
  return WORKFLOW_BY_ENGAGEMENT[engagement] || WORKFLOW_BY_ENGAGEMENT.assess;
}

export function engagementForWorkflowName(nameOrPath: string | undefined): Engagement | undefined {
  if (!nameOrPath) return undefined;
  for (const [workflow, engagement] of Object.entries(ENGAGEMENT_BY_WORKFLOW)) {
    if (
      nameOrPath === workflow ||
      nameOrPath.includes(`/${workflow}`) ||
      nameOrPath.includes(`${workflow}/`) ||
      nameOrPath.includes(workflow)
    ) {
      return engagement;
    }
  }
  return undefined;
}

export function isKnownPentestWorkflow(nameOrPath: string | undefined): boolean {
  return Boolean(engagementForWorkflowName(nameOrPath));
}

/**
 * Resolve engagement from explicit structured fields only.
 * Does not parse natural-language instructions.
 */
export function resolveExplicitEngagement(task: TaskEnvelope): EngagementResolution | undefined {
  const explicit = normalizeEngagement(
    firstString(
      task.engagement,
      (task as { intent?: unknown }).intent,
      task.snapshot?.engagement,
      task.snapshot?.intent,
      task.snapshot?.task_type,
    ),
  );
  if (!explicit) return undefined;
  return {
    engagement: explicit,
    workflow: workflowForEngagement(explicit),
    source: "explicit",
    rationale: `Task envelope explicitly set engagement=${explicit}`,
  };
}

/**
 * Default used only for prompt catalog / pre-run hints when the product did not set engagement.
 * The agent is still expected to pick the workflow via LLM judgment.
 */
export function defaultEngagementResolution(): EngagementResolution {
  return {
    engagement: "assess",
    workflow: workflowForEngagement("assess"),
    source: "default",
    rationale:
      "No structured engagement on the task; default catalog entry is assess/pentest-web. The agent must still choose the workflow that matches the user's intent.",
  };
}

/**
 * Effective engagement for gates after the agent has acted:
 * explicit task field > completed/known workflow run > default assess.
 */
export function resolveEffectiveEngagement(
  task: TaskEnvelope,
  workflowRuns: WorkflowRunSummary[] = [],
): EngagementResolution {
  const explicit = resolveExplicitEngagement(task);
  if (explicit) return explicit;

  const fromWorkflow = engagementFromWorkflowRuns(workflowRuns);
  if (fromWorkflow) return fromWorkflow;

  return defaultEngagementResolution();
}

export function engagementFromWorkflowRuns(workflowRuns: WorkflowRunSummary[]): EngagementResolution | undefined {
  // Prefer the latest completed known workflow; else latest known.
  const known = workflowRuns
    .map((run) => {
      const engagement = engagementForWorkflowName(run.specPath) || engagementForWorkflowName(run.openCommand);
      return engagement
        ? {
            engagement,
            workflow: workflowForEngagement(engagement),
            status: run.status,
            runId: run.runId,
          }
        : undefined;
    })
    .filter(Boolean) as Array<{ engagement: Engagement; workflow: string; status?: string; runId: string }>;

  if (!known.length) return undefined;

  const completed = [...known].reverse().find((item) => item.status === "completed");
  const chosen = completed || known[known.length - 1]!;
  return {
    engagement: chosen.engagement,
    workflow: chosen.workflow,
    source: "workflow",
    rationale: `Derived from pi-workflow run ${chosen.runId} (${chosen.workflow}, status=${chosen.status || "unknown"})`,
  };
}

/** Structured enum only — product UI / API values, not free-text NLP. */
export function normalizeEngagement(value: unknown): Engagement | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (raw === "assess" || raw === "verify" || raw === "retest" || raw === "consult") return raw;
  // Narrow aliases that are structured product labels, not instruction NLP.
  if (raw === "assessment" || raw === "full-assessment" || raw === "pentest") return "assess";
  if (raw === "validation" || raw === "validate") return "verify";
  if (raw === "regression" || raw === "fix-check") return "retest";
  if (raw === "advice" || raw === "qa" || raw === "question") return "consult";
  return undefined;
}

export function engagementRequiresMultiActorGate(engagement: Engagement): boolean {
  return engagement === "assess";
}

export function engagementRequiresFullCoverageGate(engagement: Engagement): boolean {
  return engagement === "assess";
}

export function scanModeLabel(scanMode: ScanMode | string | undefined): string {
  const mode = String(scanMode || "standard").toLowerCase();
  if (mode === "quick") return "quick (tight timebox, high-signal only)";
  if (mode === "deep") return "deep (broaden after evidence supports it)";
  return "standard (balanced)";
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Catalog text for the agent — LLM chooses; code does not parse the user prompt. */
export function workflowCatalogForPrompt(): string {
  return [
    "Available pi-workflows (choose exactly one with workflow_run based on your understanding of the user instruction):",
    `- pentest-web (engagement=assess): full authorized assessment — recon, multi-actor when applicable, risk-family coverage, broad discovery.`,
    `- pentest-verify (engagement=verify): validate a specific vulnerability hypothesis or PoC path only — minimal recon, no full-site sweep.`,
    `- pentest-retest (engagement=retest): re-check a previously reported finding or claimed fix along the same path.`,
    `- pentest-consult (engagement=consult): answer methodology/security questions; live probing only if the user authorized a target and a fact-check is required.`,
    "Do not default to pentest-web when the user only wants verification, retest, or advice. Infer intent with judgment, not keyword matching.",
  ].join("\n");
}
