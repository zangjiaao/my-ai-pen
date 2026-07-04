export type PlatformMessage = Record<string, unknown> & { type: string };

export type TaskEnvelope = {
  taskId: string;
  conversationId: string;
  instruction: string;
  target: Record<string, unknown>;
  scope: Record<string, unknown>;
  snapshot: Record<string, unknown>;
};

export type PlatformSink = {
  send(message: PlatformMessage): Promise<void>;
};

export type ToolRuntime = {
  task: TaskEnvelope;
  workspaceDir: string;
  platform: PlatformSink;
  plan: PlanStoreLike;
  coverage: CoverageStoreLike;
  evidence: EvidenceStoreLike;
  traffic: TrafficStoreLike;
};

export type PlanStatus = "pending" | "running" | "done" | "blocked" | "failed" | "skipped";

export type PlanNode = {
  node_id: string;
  title: string;
  status: PlanStatus;
  kind: string;
  level: "phase" | "objective" | "work_item";
  parent_id?: string | null;
  endpoint?: string | null;
  parameter?: string | null;
  vuln_type?: string | null;
  notes?: string | null;
  evidence_ids?: string[];
  priority?: number;
  source?: string;
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
  snapshot(): PlanNode[];
  checkpoint(extra?: Record<string, unknown>): Record<string, unknown>;
  progress(): { current: number; total: number; percent: number };
  currentPhase(): string;
};

export type CoverageStatus = "tried" | "passed" | "failed" | "blocked" | "skipped";

export type CoverageStoreLike = {
  mark(input: {
    endpoint: string;
    param: string;
    vulnClass: string;
    status: CoverageStatus;
    notes?: string;
  }): Promise<Record<string, unknown>>;
  list(filter?: { endpoint?: string; param?: string; vulnClass?: string }): Promise<Record<string, unknown>[]>;
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
  list(filter?: { urlContains?: string; method?: string; limit?: number }): CapturedTraffic[];
  get(id: string): CapturedTraffic | undefined;
  endpoints(): Array<{ endpoint: string; method: string; params: string[]; count: number }>;
  snapshot(): Record<string, unknown> | undefined;
  setSnapshot(snapshot: Record<string, unknown>): void;
};

export type CapturedTraffic = {
  id?: string;
  method: string;
  url: string;
  status?: number;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  receivedAt?: string;
};
