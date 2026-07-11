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

/** @deprecated Non-terminal agent notes only — does not settle the run. */
export type FinishScanState = {
  status?: string;
  kind?: string;
  summary: string;
  confirmedFindings?: string[];
  findingsDedupedCount?: number;
  evidenceIds?: string[];
  calledAt: string;
  toolCallId?: string;
  non_terminal?: boolean;
};

export type ToolRuntime = {
  task: TaskEnvelope;
  workspaceDir: string;
  taskDir: string;
  platform: PlatformSink;
  todo: import("./stores/todo.js").TodoStore;
  evidence: EvidenceStoreLike;
  findingsDir: string;
  lifecycle: {
    /** Non-terminal agent status note. */
    lastStatusNote?: FinishScanState & { kind?: string; non_terminal?: boolean };
    /** Legacy alias for lastStatusNote. */
    finishScan?: FinishScanState;
    agentBlocked?: boolean;
    toolsInLastSegment?: number;
  };
};

export type EvidenceStoreLike = {
  create(input: { type: string; sourceTool: string; summary: string; data: unknown }): Promise<{ id: string; path: string }>;
  read(id: string): Promise<unknown | undefined>;
  list(): Promise<Array<{ id: string; summary: string }>>;
};
