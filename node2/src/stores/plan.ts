import type { CoverageStatus, PlanNode, PlanStatus, PlanStoreLike } from "../types.js";

const PHASES = ["intake", "recon", "analysis", "verify", "report", "complete"] as const;

const PHASE_LABELS: Record<string, string> = {
  intake: "Target and authorization scope",
  recon: "Attack surface discovery",
  analysis: "Coverage analysis and test plan",
  verify: "Verification and evidence",
  report: "Report preparation",
  complete: "Task complete",
};

const OBJECTIVES: Array<{ node_id: string; phase: string; title: string; priority: number }> = [
  { node_id: "plan-objective-recon-attack-surface", phase: "recon", title: "Discover testable attack surface", priority: 110 },
  { node_id: "plan-objective-recon-traffic", phase: "recon", title: "Collect high-value requests", priority: 120 },
  { node_id: "plan-objective-analysis-test-plan", phase: "analysis", title: "Build vulnerability test backlog", priority: 210 },
  { node_id: "plan-objective-verify-evidence", phase: "verify", title: "Verify findings with evidence", priority: 310 },
  { node_id: "plan-objective-report-final", phase: "report", title: "Prepare final report", priority: 410 },
];

export class PlanStore implements PlanStoreLike {
  private readonly nodes = new Map<string, PlanNode>();
  private phase = "intake";

  constructor() {
    this.seed();
  }

  start(): void {
    this.setPhase("recon");
  }

  complete(): void {
    for (const phase of PHASES) {
      this.phaseNode(phase).status = "done";
    }
    for (const node of this.nodes.values()) {
      if (node.status === "running") node.status = "done";
    }
    this.phase = "complete";
  }

  fail(message?: string): void {
    this.phaseNode(this.phase).status = "failed";
    if (message) this.phaseNode(this.phase).notes = message;
  }

  setPhase(phase: string): void {
    if (!PHASES.includes(phase as any)) return;
    this.phase = phase;
    const currentIndex = PHASES.indexOf(phase as any);
    for (const [index, key] of PHASES.entries()) {
      const node = this.phaseNode(key);
      if (index < currentIndex) node.status = "done";
      else if (index === currentIndex) node.status = "running";
      else if (node.status !== "done") node.status = "pending";
    }
  }

  toolStart(toolCallId: string, toolName: string, args: Record<string, unknown> = {}): void {
    const phase = phaseForTool(toolName, args);
    this.setPhase(phase);
    this.upsert({
      node_id: `plan-tool-${slug(toolCallId)}`,
      title: toolTitle(toolName, args),
      status: "running",
      kind: toolName,
      level: "work_item",
      parent_id: parentForTool(toolName),
      endpoint: endpointForArgs(args),
      parameter: paramForArgs(args),
      vuln_type: vulnClassForArgs(args),
      notes: shortJson(args),
      priority: priorityForTool(toolName),
      source: "pi_tool",
    });
  }

  toolEnd(toolCallId: string, toolName: string, isError: boolean, notes?: string): void {
    const node = this.nodes.get(`plan-tool-${slug(toolCallId)}`);
    if (!node) return;
    node.status = isError ? "failed" : "done";
    if (notes) node.notes = notes.slice(0, 500);
    if (toolName === "finding" && !isError) this.setPhase("report");
  }

  coverageMark(input: { endpoint: string; param: string; vulnClass: string; status: CoverageStatus; notes?: string }): void {
    this.setPhase(input.status === "passed" || input.status === "failed" ? "verify" : "analysis");
    this.upsert({
      node_id: `plan-test-${slug(`${input.endpoint}-${input.param}-${input.vulnClass}`)}`,
      title: `Test ${input.vulnClass} on ${input.param || "-"}`,
      status: coverageToPlanStatus(input.status),
      kind: "test",
      level: "work_item",
      parent_id: "plan-objective-analysis-test-plan",
      endpoint: input.endpoint,
      parameter: input.param,
      vuln_type: input.vulnClass,
      notes: input.notes,
      priority: 230,
      source: "coverage",
    });
  }

  upsert(input: Partial<PlanNode> & { node_id?: string; id?: string; title: string }): PlanNode {
    const nodeId = String(input.node_id || input.id || `plan-agent-${slug(input.title)}`);
    const existing = this.nodes.get(nodeId);
    const next: PlanNode = {
      node_id: nodeId,
      title: input.title,
      status: normalizeStatus(input.status || existing?.status || "pending"),
      kind: input.kind || existing?.kind || "task",
      level: input.level || existing?.level || "work_item",
      parent_id: input.parent_id ?? existing?.parent_id ?? "plan-objective-analysis-test-plan",
      endpoint: input.endpoint ?? existing?.endpoint ?? null,
      parameter: input.parameter ?? existing?.parameter ?? null,
      vuln_type: input.vuln_type ?? existing?.vuln_type ?? null,
      notes: input.notes ?? existing?.notes ?? null,
      evidence_ids: input.evidence_ids ?? existing?.evidence_ids ?? [],
      priority: input.priority ?? existing?.priority ?? 250,
      source: input.source || existing?.source || "agent",
    };
    this.nodes.set(nodeId, next);
    return next;
  }

  findingConfirmed(input: { title: string; severity?: string; location?: string; evidenceIds?: string[] }): void {
    this.setPhase("verify");
    this.upsert({
      node_id: `plan-finding-${slug(input.title)}`,
      title: `Confirmed: ${input.title}`,
      status: "done",
      kind: "finding",
      level: "work_item",
      parent_id: "plan-objective-verify-evidence",
      endpoint: input.location || null,
      notes: input.severity ? `severity=${input.severity}` : undefined,
      evidence_ids: input.evidenceIds || [],
      priority: 330,
      source: "finding",
    });
    this.setPhase("report");
  }

  snapshot(): PlanNode[] {
    return [...this.nodes.values()].sort((left, right) => (left.priority || 0) - (right.priority || 0) || left.node_id.localeCompare(right.node_id));
  }

  checkpoint(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ...extra,
      phase: this.phase,
      completed_phases: this.snapshot().filter((node) => node.level === "phase" && node.status === "done").map((node) => node.node_id.replace("plan-phase-", "")),
      plan_tree: this.snapshot(),
    };
  }

  progress(): { current: number; total: number; percent: number } {
    const total = PHASES.length;
    const done = this.snapshot().filter((node) => node.level === "phase" && node.status === "done").length;
    const running = this.snapshot().some((node) => node.level === "phase" && node.status === "running") ? 1 : 0;
    const current = Math.min(total, done + running);
    return { current, total, percent: Math.round((current / total) * 100) };
  }

  currentPhase(): string {
    return this.phase;
  }

  private seed(): void {
    for (const [index, phase] of PHASES.entries()) {
      this.nodes.set(`plan-phase-${phase}`, {
        node_id: `plan-phase-${phase}`,
        title: PHASE_LABELS[phase],
        status: index === 0 ? "running" : "pending",
        kind: "phase",
        level: "phase",
        parent_id: null,
        priority: index * 100,
        source: "runtime",
      });
    }
    for (const item of OBJECTIVES) {
      this.nodes.set(item.node_id, {
        node_id: item.node_id,
        title: item.title,
        status: "pending",
        kind: "objective",
        level: "objective",
        parent_id: `plan-phase-${item.phase}`,
        priority: item.priority,
        source: "runtime",
      });
    }
  }

  private phaseNode(phase: string): PlanNode {
    const node = this.nodes.get(`plan-phase-${phase}`);
    if (!node) throw new Error(`missing phase node: ${phase}`);
    return node;
  }
}

function phaseForTool(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "browser" || toolName === "traffic" || toolName === "scan") return "recon";
  if (toolName === "coverage" || toolName === "skill") return "analysis";
  if (toolName === "http" || toolName === "poc" || toolName === "finding") return "verify";
  if (String(args.action || "") === "confirm") return "verify";
  return "analysis";
}

function parentForTool(toolName: string): string {
  if (toolName === "browser" || toolName === "traffic" || toolName === "scan") return "plan-objective-recon-attack-surface";
  if (toolName === "finding") return "plan-objective-verify-evidence";
  if (toolName === "http" || toolName === "poc") return "plan-objective-verify-evidence";
  return "plan-objective-analysis-test-plan";
}

function priorityForTool(toolName: string): number {
  if (toolName === "browser" || toolName === "traffic" || toolName === "scan") return 150;
  if (toolName === "coverage" || toolName === "skill") return 240;
  if (toolName === "http" || toolName === "poc" || toolName === "finding") return 340;
  return 250;
}

function toolTitle(toolName: string, args: Record<string, unknown>): string {
  const action = typeof args.action === "string" ? ` ${args.action}` : "";
  const target = endpointForArgs(args);
  return `${toolName}${action}${target ? `: ${target}` : ""}`;
}

function endpointForArgs(args: Record<string, unknown>): string | null {
  for (const key of ["url", "target", "endpoint"]) {
    if (typeof args[key] === "string" && args[key]) return args[key] as string;
  }
  return null;
}

function paramForArgs(args: Record<string, unknown>): string | null {
  for (const key of ["param", "parameter"]) {
    if (typeof args[key] === "string" && args[key]) return args[key] as string;
  }
  return null;
}

function vulnClassForArgs(args: Record<string, unknown>): string | null {
  for (const key of ["vuln_class", "vuln_type", "scanner"]) {
    if (typeof args[key] === "string" && args[key]) return args[key] as string;
  }
  return null;
}

function coverageToPlanStatus(status: CoverageStatus): PlanStatus {
  if (status === "passed" || status === "failed") return "done";
  if (status === "blocked") return "blocked";
  if (status === "skipped") return "skipped";
  return "running";
}

function normalizeStatus(status: string): PlanStatus {
  if (["pending", "running", "done", "blocked", "failed", "skipped"].includes(status)) return status as PlanStatus;
  if (status === "completed") return "done";
  if (status === "error") return "failed";
  return "pending";
}

function shortJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return "";
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 90) || "item";
}
