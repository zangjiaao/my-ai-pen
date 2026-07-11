export type PlatformMessage = Record<string, unknown> & { type: string };

export type TaskEnvelope = {
  taskId: string;
  conversationId: string;
  instruction: string;
  target: Record<string, unknown>;
  scope: Record<string, unknown>;
  snapshot?: Record<string, unknown>;
  engagement?: string;
  scanMode?: string;
};

export type PlatformSink = {
  send(message: PlatformMessage): Promise<void>;
};

export type FinishScanState = {
  status: "completed" | "incomplete" | "blocked";
  summary: string;
  confirmedFindings?: string[];
  findingsDedupedCount?: number;
  evidenceIds?: string[];
  calledAt: string;
  toolCallId: string;
};

export type ToolRuntime = {
  task: TaskEnvelope;
  workspaceDir: string;
  taskDir: string;
  platform: PlatformSink;
  todo: import("./stores/todo.js").TodoStore;
  evidence: EvidenceStoreLike;
  findingsDir: string;
  lifecycle: { finishScan?: FinishScanState };
};

export type EvidenceStoreLike = {
  create(input: { type: string; sourceTool: string; summary: string; data: unknown }): Promise<{ id: string; path: string }>;
  read(id: string): Promise<unknown | undefined>;
  list(): Promise<Array<{ id: string; summary: string }>>;
};
