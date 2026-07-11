export type PlatformMessage = Record<string, unknown> & { type: string };

export type TaskEnvelope = {
  taskId: string;
  conversationId: string;
  instruction: string;
  scanMode?: ScanMode;
  /**
   * Optional structured engagement from the product UI/API.
   * Free-text intent must NOT be keyword-parsed into this field by platform code;
   * when absent, the agent selects the pi-workflow via LLM judgment.
   */
  engagement?: Engagement;
  target: Record<string, unknown>;
  scope: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  /**
   * Per-node runtime budgets from 节点管理 (task_assign.worker_limits).
   * Falls back to env defaults when absent.
   */
  workerLimits?: WorkerLimits;
};

/** Wall-clock / turn / concurrency budgets for main agent + in-process workers. */
export type WorkerLimits = {
  /** Hard wall-clock ms per worker package (default 300_000). */
  maxMs?: number;
  /** Max tool-using turns before graceful stop (default 12). */
  maxTurns?: number;
  /** Timeouts allowed before package is marked failed (default 2). */
  maxTimeoutRetries?: number;
  /** Whole-task main-agent wall-clock ms (default 1_800_000). */
  mainMaxMs?: number;
  /** Main-agent max tool-using turns before graceful stop (default 80). */
  mainMaxTurns?: number;
  /** Max simultaneous in-process workers (default 1). */
  maxConcurrentWorkers?: number;
  /** Node default scan intensity when task does not set scan_mode. */
  defaultScanMode?: ScanMode;
};

export type ScanMode = "quick" | "standard" | "deep";

/** Structured task intent; maps to a pi-workflow and completion gates. */
export type Engagement = "assess" | "verify" | "retest" | "consult";

export type PlatformSink = {
  send(message: PlatformMessage): Promise<void>;
};

export type ToolRuntime = {
  task: TaskEnvelope;
  workspaceDir: string;
  platform: PlatformSink;
  plan: PlanStoreLike;
  /** OMP-style session todo (user Tasks map). Optional for legacy smokes. */
  todo?: TodoStoreLike;
  coverage: CoverageStoreLike;
  evidence: EvidenceStoreLike;
  traffic: TrafficStoreLike;
  /** Multi-identity sessions for horizontal/vertical privilege testing. */
  actors?: ActorStoreLike;
  pocCatalogPath: string;
  workflowRuns: WorkflowRunSummary[];
  lifecycle: RuntimeLifecycle;
  trafficProxyUrl?: string;
  externalTrafficSource?: ExternalTrafficSourceLike;
  scannerSandbox?: ScannerSandboxConfig;
  /**
   * Optional context to launch in-process worker subagents that share this runtime.
   * Populated by session-runner for full task runs; smokes may omit it.
   */
  workerLaunch?: {
    config: unknown;
    model: unknown;
    authStorage: unknown;
    modelRegistry: unknown;
    settingsManager: unknown;
    taskDir: string;
    /** Merge worker session token usage into parent task llm_usage. */
    mergeWorkerUsage?: (usage: {
      requests: number;
      input_tokens: number;
      output_tokens: number;
      cached_tokens: number;
      cache_write_tokens: number;
      reasoning_tokens: number;
      total_tokens: number;
      cost: number;
      agent_count?: number;
      model?: string;
      tool_calls?: number;
    }) => void | Promise<void>;
    /** Append a diagnostics/runtime event for worker lifecycle. */
    noteWorker?: (type: string, details: Record<string, unknown>) => void | Promise<void>;
  };
};

export type ActorStoreLike = {
  list(): Array<{ id: string; label: string; roleHint?: string; headers: Record<string, string>; meta: Record<string, unknown>; updatedAt: string }>;
  count(): number;
  get(id: string): { id: string; label: string; roleHint?: string; headers: Record<string, string>; meta: Record<string, unknown>; updatedAt: string } | undefined;
  active(): { id: string; label: string; roleHint?: string; headers: Record<string, string>; meta: Record<string, unknown>; updatedAt: string } | undefined;
  activeIdValue(): string | undefined;
  upsert(input: Record<string, unknown>): { id: string; label: string; roleHint?: string; headers: Record<string, string>; meta: Record<string, unknown>; updatedAt: string };
  activate(id: string): { id: string; label: string; roleHint?: string; headers: Record<string, string>; meta: Record<string, unknown>; updatedAt: string };
  clearActive(): void;
  headersFor(id?: string | null): Record<string, string>;
  capture(
    id: string,
    material: { headers?: Record<string, string>; authorization?: string; cookie?: string; meta?: Record<string, unknown>; label?: string; roleHint?: string },
    options?: { replaceHeaders?: boolean; activate?: boolean },
  ): { id: string; label: string; roleHint?: string; headers: Record<string, string>; meta: Record<string, unknown>; updatedAt: string };
  summary(): { active?: string; count: number; actors: Array<{ id: string; label: string; roleHint?: string; hasAuth: boolean; meta: Record<string, unknown> }> };
};

export type ScannerSandboxConfig = {
  enabled: boolean;
  image: string;
};

/** Normalized worker terminal outcome for plan/panel display. */
export type WorkerOutcome = "completed" | "timeout" | "failed" | "aborted";

export type WorkerRunRecord = {
  workerId: string;
  role: string;
  task: string;
  ok: boolean;
  /** completed | timeout | failed | aborted — preferred over ok alone for UI. */
  outcome?: WorkerOutcome;
  at: string;
  durationMs?: number;
  toolCallCount?: number;
  summary?: string;
  error?: string;
};

/** Open packages that timed out/failed and still need main-session or re-dispatch work. */
export type OpenWorkerPackage = {
  packageId: string;
  workerId: string;
  role: string;
  task: string;
  outcome: WorkerOutcome;
  at: string;
  resolved?: boolean;
  resolvedAt?: string;
  resolveNote?: string;
  /** How many times this package lineage has timed out (including first). */
  timeoutAttempts?: number;
  /** True when retries are exhausted and package is terminal failed. */
  retriesExhausted?: boolean;
  /** Operator-facing adjustment advice when retries are exhausted. */
  advice?: string;
  /** Stable lineage key so retries resolve the same open row. */
  lineageKey?: string;
};

export type RuntimeLifecycle = {
  finishScan?: FinishScanState;
  /** Recorded in-process worker runs for finish gates and panel rollup. */
  workerRuns?: WorkerRunRecord[];
  /** Timeout/failed packages not yet re-dispatched or completed in main session. */
  openWorkerPackages?: OpenWorkerPackage[];
  /** How many times finish_scan(completed) was rejected this run (anti-thrash). */
  finishCompletedRejects?: number;
};

export type FinishScanState = {
  status: "completed" | "incomplete" | "blocked";
  summary: string;
  confirmedFindings?: string[];
  /** Optional LLM-supplied titles kept for forensics; disk findings are authoritative. */
  llmConfirmedFindings?: string[];
  findingsRawCount?: number;
  findingsDedupedCount?: number;
  coverageGaps?: string[];
  blockers?: string[];
  evidenceIds?: string[];
  calledAt: string;
  toolCallId: string;
};

export type WorkflowRunSummary = {
  runId: string;
  status?: string;
  specPath?: string;
  taskSummary?: string;
  openCommand?: string;
  toolCallId?: string;
};

export type PlanStatus = "todo" | "pending" | "running" | "done" | "blocked" | "failed" | "skipped";

export type WorkResult = "confirmed" | "negative" | "inconclusive" | "blocked";

export type PlanNode = {
  node_id: string;
  title: string;
  status: PlanStatus;
  kind: string;
  level: "phase" | "objective" | "work_item";
  parent_id?: string | null;
  method?: string | null;
  endpoint?: string | null;
  parameter?: string | null;
  parameters?: string[];
  vuln_type?: string | null;
  result?: WorkResult | null;
  notes?: string | null;
  evidence_ids?: string[];
  priority?: number;
  source?: string;
};

export type PlanAudit = {
  canComplete: boolean;
  openWorkItems: PlanNode[];
  inconclusiveWorkItems: PlanNode[];
  blockedWorkItems: PlanNode[];
  findingsWithoutEvidence: PlanNode[];
  missingBacklog: boolean;
  summary: string;
};

export type KanbanStage = "confirming" | "executing" | "summarizing" | "completed" | "incomplete";

export type KanbanBucket = {
  id: "task-confirmation" | "attack-surface" | "vulnerability-discovery" | "vulnerability-verification" | "task-summary";
  title: string;
  done: number;
  total: number;
  status: PlanStatus;
};

export type KanbanSummary = {
  workflow_kind?: string;
  current_stage: KanbanStage;
  totals: {
    discovered: number;
    processed: number;
    pending: number;
    running: number;
    confirmed: number;
    negative: number;
    blocked: number;
    inconclusive: number;
    percent: number;
  };
  buckets: KanbanBucket[];
};

export type PlanStoreLike = {
  start(): void;
  complete(): void;
  fail(message?: string): void;
  setPhase(phase: string): void;
  toolStart(toolCallId: string, toolName: string, args?: Record<string, unknown>): void;
  toolEnd(toolCallId: string, toolName: string, isError: boolean, notes?: string): void;
  coverageMark(input: { endpoint: string; param: string; vulnClass: string; status: CoverageStatus; notes?: string }): void;
  upsert(input: Partial<PlanNode> & { node_id?: string; id?: string; title: string }): PlanNode;
  findingConfirmed(input: { title: string; severity?: string; location?: string; evidenceIds?: string[] }): void;
  audit(): PlanAudit;
  /** User-facing intentional TODOs still open (agent/plan checklist), not tool telemetry. */
  openIntentionalChecklist(): PlanNode[];
  gapPrompt(): string;
  snapshot(): PlanNode[];
  checkpoint(extra?: Record<string, unknown>): Record<string, unknown>;
  progress(): { current: number; total: number; percent: number };
  kanban(): KanbanSummary;
  currentPhase(): string;
};

/** Session todo map (Harness v2 / OMP-aligned). */
export type TodoStoreLike = {
  snapshot(): Array<{ name: string; tasks: Array<{ content: string; status: string }> }>;
  openCount(): number;
  apply(params: {
    op: string;
    list?: Array<{ phase: string; items: string[] }>;
    task?: string;
    phase?: string;
    items?: string[];
  }): {
    phases: Array<{ name: string; tasks: Array<{ content: string; status: string }> }>;
    errors: string[];
    readOnly: boolean;
    completedTasks: Array<{ phase: string; content: string }>;
  };
  toPlanNodes(): Array<{
    node_id: string;
    title: string;
    status: "pending" | "running" | "done" | "skipped";
    kind: string;
    level: "phase" | "work_item";
    parent_id?: string | null;
    source: string;
    priority: number;
  }>;
};

export type CoverageStatus = "observed" | "tried" | "passed" | "failed" | "blocked" | "skipped";

export type CoverageStoreLike = {
  mark(input: {
    endpoint: string;
    param: string;
    vulnClass: string;
    status: CoverageStatus;
    notes?: string;
  }): Promise<Record<string, unknown>>;
  list(filter?: { endpoint?: string; param?: string; vulnClass?: string }): Promise<Record<string, unknown>[]>;
  listSync?(filter?: { endpoint?: string; param?: string; vulnClass?: string }): Record<string, unknown>[];
  untested(candidates: Array<{ endpoint: string; param: string }>, vulnClasses: string[]): Promise<Record<string, unknown>[]>;
  summary(): Promise<Record<string, unknown>>;
};

export type EvidenceStoreLike = {
  create(input: {
    type: string;
    sourceTool: string;
    summary: string;
    data: unknown;
  }): Promise<{ id: string; path: string }>;
  read(id: string): Promise<unknown | undefined>;
  list(): Promise<Array<{ id: string; type: string; sourceTool: string; summary: string; path: string }>>;
};

export type TrafficStoreLike = {
  add(input: CapturedTraffic): string;
  list(filter?: { urlContains?: string; method?: string; limit?: number; replayableOnly?: boolean }): CapturedTraffic[];
  get(id: string): CapturedTraffic | undefined;
  endpoints(): Array<{ endpoint: string; method: string; params: string[]; count: number; trafficIds: string[] }>;
  candidates(limit?: number): CapturedTraffic[];
  snapshot(): Record<string, unknown> | undefined;
  setSnapshot(snapshot: Record<string, unknown>): void;
};

export type ExternalTrafficSourceLike = {
  kind: string;
  status(): Promise<Record<string, unknown>>;
  list(filter?: { urlContains?: string; method?: string; limit?: number }): Promise<CapturedTraffic[]>;
  get(id: string): Promise<CapturedTraffic | undefined>;
};

export type CapturedTraffic = {
  id?: string;
  source?: string;
  method: string;
  url: string;
  status?: number;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  tags?: string[];
  evidenceId?: string;
  parentTrafficId?: string;
  receivedAt?: string;
};
