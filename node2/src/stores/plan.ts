import type { CoverageStatus, PlanAudit, PlanNode, PlanStatus, PlanStoreLike, WorkResult } from "../types.js";

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
    for (const node of this.nodes.values()) {
      if (node.status === "running") node.status = "done";
      if (node.level === "objective" && node.status === "pending") node.status = "done";
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
      result: "confirmed",
      notes: input.severity ? `severity=${input.severity}` : undefined,
      evidence_ids: input.evidenceIds || [],
      priority: 330,
      source: "finding",
    });
    this.closeRelatedTests(input.title, input.location || "", input.evidenceIds || []);
    this.setPhase("report");
  }

  audit(): PlanAudit {
    const work = this.snapshot().filter((node) => node.level === "work_item");
    const evidenceBackedFindings = work.filter((node) => node.kind === "finding" && node.status === "done" && (node.evidence_ids || []).length);
    const openWorkItems = work.filter((node) => isOpenStatus(node.status) && isGateable(node));
    const inconclusiveWorkItems = work.filter((node) => node.result === "inconclusive" && !isTerminalException(node.status) && isGateable(node));
    const blockedWorkItems = work.filter((node) => node.status === "blocked");
    const findingsWithoutEvidence = work.filter((node) => node.kind === "finding" && node.status === "done" && !(node.evidence_ids || []).length);
    const missingBacklog = work.filter(isGateable).length === 0 && evidenceBackedFindings.length === 0;
    const canComplete = !missingBacklog && openWorkItems.length === 0 && inconclusiveWorkItems.length === 0 && findingsWithoutEvidence.length === 0;
    const summaryParts = [
      `${openWorkItems.length} open work item(s)`,
      `${inconclusiveWorkItems.length} inconclusive item(s)`,
      `${blockedWorkItems.length} blocked item(s)`,
      `${findingsWithoutEvidence.length} confirmed finding(s) without evidence`,
      missingBacklog ? "missing vulnerability test backlog" : "test backlog present",
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

  gapPrompt(): string {
    const audit = this.audit();
    const open = [...audit.openWorkItems, ...audit.inconclusiveWorkItems].slice(0, 20);
    const lines = [
      "Runtime completion gate blocked task completion.",
      audit.summary,
      "",
      "Before writing a final report, update the Plan Tree and resolve these work items:",
    ];
    for (const item of open) {
      lines.push(
        `- ${item.node_id}: ${item.title}; status=${item.status}; endpoint=${item.endpoint || "-"}; param=${item.parameter || "-"}; vuln=${item.vuln_type || "-"}; notes=${clip(item.notes || "", 260)}`,
      );
    }
    if (audit.findingsWithoutEvidence.length) {
      lines.push("", "Confirmed findings missing evidence_ids:");
      for (const item of audit.findingsWithoutEvidence.slice(0, 10)) lines.push(`- ${item.title}`);
    }
    if (audit.missingBacklog) {
      lines.push("", "No vulnerability test backlog exists yet. First discover or enumerate target attack surface, then add concrete Plan Tree test items for plausible endpoint/parameter/vulnerability-class combinations.");
    }
    lines.push(
      "",
      "For each item, either perform concrete verification and call finding(action='confirm') with evidence_ids, mark coverage/test as negative or done with evidence-backed notes, or mark it blocked with a specific reason. Do not produce a final report until this gate is clear.",
    );
    return lines.join("\n");
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
      audit: this.audit(),
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
  if (status === "observed") return "pending";
  if (status === "passed" || status === "failed") return "done";
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
