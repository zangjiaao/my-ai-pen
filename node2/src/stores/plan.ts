import type { CoverageStatus, KanbanBucket, KanbanStage, KanbanSummary, PlanAudit, PlanNode, PlanStatus, PlanStoreLike, WorkResult } from "../types.js";

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
    const audit = this.audit();
    if (!audit.canComplete) {
      this.setPhase("analysis");
      this.phaseNode("analysis").notes = audit.summary;
      return;
    }
    for (const phase of PHASES) this.phaseNode(phase).status = "done";
    // Only settle runtime tool chrome + phase objectives here.
    // Intentional agent checklist items must be closed by the agent via coverage(plan)
    // as work progresses — not silently rewritten at finish time.
    for (const node of this.nodes.values()) {
      if (node.status === "running" && node.source === "pi_tool") node.status = "done";
      if (node.level === "objective" && (node.status === "pending" || node.status === "todo" || node.status === "running")) {
        node.status = "done";
      }
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
  }

  coverageMark(input: { endpoint: string; param: string; vulnClass: string; status: CoverageStatus; notes?: string }): void {
    const result = coverageToResult(input.status);
    const node = this.upsert({
      node_id: `plan-test-${slug(`${input.endpoint}-${input.param}-${input.vulnClass}`)}`,
      title: `Test ${input.vulnClass} on ${input.param || "-"}`,
      status: coverageToPlanStatus(input.status),
      kind: "test",
      level: "work_item",
      parent_id: "plan-objective-analysis-test-plan",
      endpoint: input.endpoint,
      parameter: input.param,
      vuln_type: input.vulnClass,
      result,
      notes: input.notes,
      priority: 230,
      source: "coverage",
    });
    this.closeRelatedCoverage(input, node.status, result);
    this.advanceWorkflow();
  }

  upsert(input: Partial<PlanNode> & { node_id?: string; id?: string; title: string }): PlanNode {
    const nodeId = String(input.node_id || input.id || `plan-agent-${slug(input.title)}`);
    const existing = this.nodes.get(nodeId);
    const status = chooseStatus(existing?.status, input.status);
    const result = normalizeResult(input.result) ?? resultForStatus(status) ?? existing?.result ?? null;
    const next: PlanNode = {
      node_id: nodeId,
      title: input.title,
      status,
      kind: input.kind || existing?.kind || "task",
      level: input.level || existing?.level || "work_item",
      parent_id: input.parent_id ?? existing?.parent_id ?? "plan-objective-analysis-test-plan",
      method: input.method ?? existing?.method ?? null,
      endpoint: input.endpoint ?? existing?.endpoint ?? null,
      parameter: input.parameter ?? existing?.parameter ?? null,
      parameters: input.parameters ?? existing?.parameters ?? [],
      vuln_type: input.vuln_type ?? existing?.vuln_type ?? null,
      result,
      notes: input.notes ?? existing?.notes ?? null,
      evidence_ids: input.evidence_ids ?? existing?.evidence_ids ?? [],
      priority: input.priority ?? existing?.priority ?? 250,
      source: input.source || existing?.source || "agent",
    };
    this.nodes.set(nodeId, next);
    if (next.source !== "pi_tool") this.advanceWorkflow();
    return next;
  }

  findingConfirmed(input: { title: string; severity?: string; location?: string; evidenceIds?: string[] }): void {
    this.upsert({
      node_id: `plan-finding-${slug(input.title)}`,
      title: `Confirmed: ${input.title}`,
      status: "done",
      kind: "finding",
      level: "work_item",
      parent_id: "plan-objective-verify-evidence",
      endpoint: input.location || null,
      result: "confirmed",
      notes: input.severity ? `severity=${input.severity}` : undefined,
      evidence_ids: input.evidenceIds || [],
      priority: 330,
      source: "finding",
    });
    this.closeRelatedTests(input.title, input.location || "", input.evidenceIds || []);
    this.advanceWorkflow();
  }

  audit(): PlanAudit {
    const work = this.snapshot().filter((node) => node.level === "work_item");
    const completedActivity = work.filter((node) => node.status === "done" && (node.source === "pi_tool" || node.kind === "surface" || node.kind === "finding" || node.kind === "test"));
    const runningTools = work.filter((node) => node.source === "pi_tool" && node.status === "running");
    const openWorkItems = runningTools;
    const inconclusiveWorkItems: PlanNode[] = [];
    const blockedWorkItems = work.filter((node) => node.status === "blocked");
    const findingsWithoutEvidence = work.filter((node) => node.kind === "finding" && node.source !== "pi_tool" && node.status === "done" && !(node.evidence_ids || []).length);
    const missingBacklog = completedActivity.length === 0;
    const canComplete = !missingBacklog && openWorkItems.length === 0 && inconclusiveWorkItems.length === 0 && findingsWithoutEvidence.length === 0;
    const summaryParts = [
      `${runningTools.length} running tool(s)`,
      `${blockedWorkItems.length} blocked item(s)`,
      `${findingsWithoutEvidence.length} confirmed finding(s) without evidence`,
      missingBacklog ? "no recorded activity yet" : "activity recorded",
    ];
    return {
      canComplete,
      openWorkItems,
      inconclusiveWorkItems,
      blockedWorkItems,
      findingsWithoutEvidence,
      missingBacklog,
      summary: summaryParts.join("; "),
    };
  }

  openIntentionalChecklist(): PlanNode[] {
    return this.snapshot().filter((node) => isOpenIntentionalChecklistNode(node));
  }

  gapPrompt(): string {
    const audit = this.audit();
    const open = audit.openWorkItems.slice(0, 10);
    const openChecklist = this.openIntentionalChecklist().slice(0, 10);
    const lines = [
      "Runtime completion gate blocked task completion on lightweight safety checks.",
      audit.summary,
      "",
      "Resolve only these runtime blockers before requesting task summary:",
    ];
    for (const item of open) {
      lines.push(
        `- ${item.node_id}: ${item.title}; status=${item.status}; notes=${clip(item.notes || "", 260)}`,
      );
    }
    if (openChecklist.length) {
      lines.push("", "Open intentional Tasks checklist items (update with coverage(plan) as you work — do not leave them pending until the end):");
      for (const item of openChecklist) {
        lines.push(`- ${item.node_id}: ${item.title}; status=${item.status}`);
      }
    }
    if (audit.findingsWithoutEvidence.length) {
      lines.push("", "Confirmed findings missing evidence_ids:");
      for (const item of audit.findingsWithoutEvidence.slice(0, 10)) lines.push(`- ${item.title}`);
    }
    if (audit.missingBacklog) {
      lines.push("", "No runtime activity has been recorded yet. Run at least one appropriate recon, request, verification, or finding step before summarizing.");
    }
    lines.push(
      "",
      "Keep the intentional Tasks checklist current as you execute. Mark each step running when started and done/blocked/skipped when finished.",
    );
    return lines.join("\n");
  }

  snapshot(): PlanNode[] {
    return [...this.nodes.values()]
      .filter((node) => node.level === "work_item")
      .map((node) => ({
        ...node,
        parent_id: node.parent_id && (node.parent_id.startsWith("plan-phase-") || node.parent_id.startsWith("plan-objective-")) ? null : node.parent_id,
      }))
      .sort((left, right) => (left.priority || 0) - (right.priority || 0) || left.node_id.localeCompare(right.node_id));
  }

  checkpoint(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const kanban = this.kanban();
    return {
      ...extra,
      workflow_kind: "pentest",
      workflow_stage: kanban.current_stage,
      progress: this.progress(),
      kanban,
      plan_tree: this.snapshot(),
      audit: this.audit(),
    };
  }

  progress(): { current: number; total: number; percent: number } {
    const totals = this.kanban().totals;
    return { current: totals.processed, total: totals.discovered, percent: totals.percent };
  }

  kanban(): KanbanSummary {
    const snapshot = this.snapshot();
    const work = snapshot.filter((node) => node.level === "work_item");
    const surfaces = work.filter((node) => node.kind === "surface" || node.kind === "request");
    const tests = work.filter(isConcreteTestNode);
    const verification = work.filter((node) => node.kind === "finding" || (node.kind === "test" && isTerminalStatus(node.status)));
    const taskConfirmed = this.phase !== "intake" || this.phaseNode("intake").status === "done";
    const summaryDone = this.phase === "complete";
    const summaryTotal = 1;
    const processed = tests.filter((node) => isTerminalStatus(node.status)).length;
    const discovered = tests.length || surfaces.length;
    const buckets: KanbanBucket[] = [
      {
        id: "task-confirmation",
        title: "Task confirmation",
        done: taskConfirmed ? 1 : 0,
        total: 1,
        status: taskConfirmed ? "done" : this.phase === "intake" ? "running" : "pending",
      },
      {
        id: "attack-surface",
        title: "Attack surface identification",
        done: surfaces.filter((node) => isTerminalStatus(node.status)).length,
        total: surfaces.length,
        status: bucketStatus(surfaces, this.phase === "recon"),
      },
      {
        id: "vulnerability-discovery",
        title: "Vulnerability discovery",
        done: processed,
        total: tests.length,
        status: bucketStatus(tests, this.phase === "analysis" || this.phase === "verify"),
      },
      {
        id: "vulnerability-verification",
        title: "Vulnerability verification",
        done: verification.filter((node) => isTerminalStatus(node.status)).length,
        total: verification.length,
        status: bucketStatus(verification, this.phase === "verify"),
      },
      {
        id: "task-summary",
        title: "Task summary",
        done: summaryDone ? summaryTotal : 0,
        total: summaryTotal,
        status: summaryDone ? "done" : this.phase === "report" ? "running" : "pending",
      },
    ];
    const counts = resultCounts(tests);
    return {
      workflow_kind: "pentest",
      current_stage: currentKanbanStage(this.phase, this.audit().canComplete),
      totals: {
        discovered,
        processed,
        pending: tests.filter((node) => node.status === "todo" || node.status === "pending").length,
        running: tests.filter((node) => node.status === "running").length,
        confirmed: counts.confirmed,
        negative: counts.negative,
        blocked: counts.blocked,
        inconclusive: counts.inconclusive,
        percent: discovered ? Math.round((processed / discovered) * 100) : 0,
      },
      buckets,
    };
  }

  currentPhase(): string {
    return this.phase;
  }

  private advanceWorkflow(): void {
    if (this.phase === "complete") return;
    const work = this.snapshot().filter((node) => node.level === "work_item");
    const surfaces = work.filter((node) => node.kind === "surface" || node.kind === "request");
    const tests = work.filter(isConcreteTestNode);
    const evidenceBackedFindings = work.filter((node) => node.kind === "finding" && node.status === "done" && (node.evidence_ids || []).length);
    const hasAttackSurface = surfaces.length > 0 || tests.length > 0;
    const hasVerifiedWork = tests.length > 0 || evidenceBackedFindings.length > 0;
    const verifiedWorkResolved = tests.length > 0 ? tests.every((node) => isTerminalStatus(node.status)) : evidenceBackedFindings.length > 0;
    const canSummarize = verifiedWorkResolved && this.audit().canComplete;
    const currentIndex = PHASES.indexOf(this.phase as any);

    if (currentIndex < PHASES.indexOf("analysis") && hasAttackSurface) {
      this.setPhase("analysis");
    }
    if (PHASES.indexOf(this.phase as any) < PHASES.indexOf("verify") && hasVerifiedWork) {
      this.setPhase("verify");
    }
    if (PHASES.indexOf(this.phase as any) < PHASES.indexOf("report") && canSummarize) {
      this.setPhase("report");
    }
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

  private closeRelatedTests(title: string, location: string, evidenceIds: string[]): void {
    const normalizedTitle = normalizeText(title);
    const normalizedLocation = location.toLowerCase();
    for (const node of this.nodes.values()) {
      if (node.kind !== "test" || node.status === "done") continue;
      const endpoint = node.endpoint || "";
      const endpointMatches = endpoint && normalizedLocation.includes(endpoint.toLowerCase());
      const vulnMatches = tokenOverlap(normalizedTitle, normalizeText(`${node.vuln_type || ""} ${node.title}`));
      if (!endpointMatches || !vulnMatches) continue;
      node.status = "done";
      node.result = "confirmed";
      node.evidence_ids = [...new Set([...(node.evidence_ids || []), ...evidenceIds])];
      node.notes = appendNote(node.notes, `Closed by confirmed finding: ${title}`);
    }
  }

  private closeRelatedCoverage(input: { endpoint: string; param: string; vulnClass: string; notes?: string }, status: PlanStatus, result: WorkResult): void {
    for (const node of this.nodes.values()) {
      if (node.kind !== "test") continue;
      if (!sameEndpoint(node.endpoint, input.endpoint)) continue;
      if (!sameParam(node, input.param)) continue;
      if (!sameVuln(node.vuln_type, input.vulnClass)) continue;
      node.status = status;
      node.result = result;
      if (input.notes) node.notes = appendNote(node.notes, input.notes);
    }
  }
}

function parentForTool(toolName: string): string {
  if (toolName === "browser" || toolName === "traffic" || toolName === "scan") return "plan-objective-recon-attack-surface";
  if (toolName === "finding") return "plan-objective-verify-evidence";
  if (toolName === "http" || toolName === "poc") return "plan-objective-verify-evidence";
  return "plan-objective-analysis-test-plan";
}

function priorityForTool(toolName: string): number {
  if (toolName === "browser" || toolName === "traffic" || toolName === "scan") return 150;
  if (toolName === "coverage" || toolName.startsWith("workflow_")) return 240;
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
  if (status === "observed") return "pending";
  if (status === "tried" || status === "passed" || status === "failed") return "done";
  if (status === "blocked") return "blocked";
  if (status === "skipped") return "skipped";
  return "running";
}

function coverageToResult(status: CoverageStatus): WorkResult {
  if (status === "failed") return "confirmed";
  if (status === "passed" || status === "skipped") return "negative";
  if (status === "blocked") return "blocked";
  return "inconclusive";
}

function normalizeStatus(status: string): PlanStatus {
  if (["todo", "pending", "running", "done", "blocked", "failed", "skipped"].includes(status)) return status as PlanStatus;
  if (status === "completed") return "done";
  if (status === "error") return "failed";
  if (status === "queued") return "todo";
  return "pending";
}

function chooseStatus(existing: PlanStatus | undefined, incoming: string | undefined): PlanStatus {
  const next = normalizeStatus(incoming || existing || "pending");
  if (!existing) return next;
  if (isTerminalStatus(existing) && (next === "pending" || next === "todo" || next === "running")) return existing;
  return next;
}

function isTerminalStatus(status: PlanStatus): boolean {
  return status === "done" || status === "blocked" || status === "failed" || status === "skipped";
}

const INTENTIONAL_CHECKLIST_SOURCES = new Set(["agent", "plan", "strix_todo"]);
const INTENTIONAL_CHECKLIST_KINDS = new Set([
  "plan",
  "summary",
  "task",
  "work",
  "work_item",
  "package",
  "objective",
  "stage",
]);

/** User-facing Tasks panel rows the agent must maintain (not tool/coverage telemetry). */
export function isIntentionalChecklistNode(node: PlanNode): boolean {
  if (node.level !== "work_item") return false;
  if (node.source === "pi_tool" || node.source === "coverage" || node.source === "finding" || node.source === "worker") {
    return false;
  }
  const kind = String(node.kind || "");
  if (["tool", "browser", "http", "poc", "scan", "traffic", "verifier", "test", "coverage", "finish_scan", "workflow"].includes(kind)) {
    return false;
  }
  return (
    INTENTIONAL_CHECKLIST_SOURCES.has(String(node.source || "")) ||
    INTENTIONAL_CHECKLIST_KINDS.has(kind)
  );
}

export function isOpenIntentionalChecklistNode(node: PlanNode): boolean {
  if (!isIntentionalChecklistNode(node)) return false;
  return node.status === "todo" || node.status === "pending" || node.status === "running";
}

function bucketStatus(nodes: PlanNode[], running: boolean): PlanStatus {
  if (!nodes.length) return running ? "running" : "pending";
  if (nodes.some((node) => node.status === "running")) return "running";
  if (nodes.every((node) => isTerminalStatus(node.status))) return "done";
  if (running) return "running";
  return "pending";
}

function currentKanbanStage(phase: string, canComplete: boolean): KanbanStage {
  if (phase === "complete") return "completed";
  if (phase === "intake") return "confirming";
  if (phase === "report") return "summarizing";
  return "executing";
}

function resultCounts(nodes: PlanNode[]): Record<WorkResult, number> {
  const counts: Record<WorkResult, number> = { confirmed: 0, negative: 0, inconclusive: 0, blocked: 0 };
  for (const node of nodes) {
    const result = normalizeResult(node.result) || resultForStatus(node.status);
    if (result) counts[result] += 1;
    else if (!isTerminalStatus(node.status)) counts.inconclusive += 1;
  }
  return counts;
}

function normalizeResult(value: unknown): WorkResult | null {
  if (["confirmed", "negative", "inconclusive", "blocked"].includes(String(value))) return value as WorkResult;
  return null;
}

function resultForStatus(status: PlanStatus): WorkResult | null {
  if (status === "blocked") return "blocked";
  if (status === "skipped") return "negative";
  return null;
}

function isOpenStatus(status: PlanStatus): boolean {
  return status === "todo" || status === "pending" || status === "running";
}

function isTerminalException(status: PlanStatus): boolean {
  return status === "blocked" || status === "skipped";
}

function isGateable(node: PlanNode): boolean {
  if (node.source === "pi_tool") return false;
  if (node.kind === "surface") return false;
  if (node.kind === "finding") return false;
  return node.level === "work_item";
}

function isConcreteTestNode(node: PlanNode): boolean {
  if (!isGateable(node)) return false;
  if (node.kind === "test") return true;
  if (node.vuln_type) return true;
  return Boolean(node.endpoint && node.parameter);
}

function clip(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokenOverlap(left: string, right: string): boolean {
  const leftTokens = new Set(left.split(/\s+/).filter((token) => token.length >= 3));
  const rightTokens = new Set(right.split(/\s+/).filter((token) => token.length >= 3));
  for (const token of leftTokens) {
    if (rightTokens.has(token)) return true;
    if (token === "xss" && (rightTokens.has("reflected") || rightTokens.has("stored") || rightTokens.has("dom"))) return true;
    if (token === "sql" && rightTokens.has("injection")) return true;
  }
  return false;
}

function appendNote(existing: string | null | undefined, note: string): string {
  if (!existing) return note;
  return existing.includes(note) ? existing : `${existing}\n${note}`;
}

function sameEndpoint(left: string | null | undefined, right: string): boolean {
  return normalizePath(left || "") === normalizePath(right);
}

function sameParam(node: PlanNode, param: string): boolean {
  const wanted = splitParamKey(param);
  const current = splitParamKey(node.parameter || (node.parameters || []).join(","));
  if (!wanted.size || !current.size) return true;
  for (const item of wanted) {
    if (current.has(item)) return true;
  }
  return false;
}

function sameVuln(left: string | null | undefined, right: string): boolean {
  const normalizedLeft = normalizeText(left || "");
  const normalizedRight = normalizeText(right);
  return normalizedLeft === normalizedRight || normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft);
}

function splitParamKey(value: string): Set<string> {
  return new Set(value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
}

function normalizePath(value: string): string {
  try {
    return new URL(value).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return value.replace(/\/+$/, "") || "/";
  }
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
