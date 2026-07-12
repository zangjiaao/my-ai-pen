export type PlatformMessage = Record<string, unknown> & { type: string };

export type TaskEnvelope = {
  taskId: string;
  conversationId: string;
  instruction: string;
  target: Record<string, unknown>;
  scope: Record<string, unknown>;
  snapshot?: Record<string, unknown>;
  /** Explicit structured engagement → role pack (not free-text NLP). */
  engagement?: string;
  /** Explicit role alias for engagement. */
  role?: string;
  scanMode?: string;
  /** Optional parent task for future multi-agent platform orchestration (pass-through). */
  parentTaskId?: string;
  /**
   * Explicit structured long-task objective to seed OMP-style goal mode
   * (not free-text NLP on instruction). When set, session starts with goal active.
   */
  goalObjective?: string;
};

export type PlatformSink = {
  send(message: PlatformMessage): Promise<void>;
};

export type ToolRuntime = {
  task: TaskEnvelope;
  workspaceDir: string;
  taskDir: string;
  platform: PlatformSink;
  todo: import("./stores/todo.js").TodoStore;
  evidence: EvidenceStoreLike;
  findingsDir: string;
  goals: import("./stores/goal.js").GoalStore;
  subagents?: import("./runtime/subagent.js").SubagentHost;
  rolePackId?: string;
  /** Optional skill store (CTF/pentest methodology). */
  skills?: import("./stores/skill.js").SkillStore;
  /** Pack-scoped skill ids for skill(list) filter. */
  skillIds?: readonly string[];
  lifecycle: {
    toolsInLastSegment?: number;
    /** Set on failed todo apply; consumed by next harness continue injection. */
    pendingTodoErrorReminder?: string[];
    /** Platform/user cancel only — no session wall/max-time. Tools kill process groups when this fires. */
    abortSignal?: AbortSignal;
    /** Optional collaboration tree tracker for checkpoint.panel_agents. */
    panelAgents?: import("./runtime/panel-agents.js").PanelAgentTracker;
  };
};

export type EvidenceStoreLike = {
  create(input: { type: string; sourceTool: string; summary: string; data: unknown }): Promise<{ id: string; path: string }>;
  read(id: string): Promise<unknown | undefined>;
  list(): Promise<Array<{ id: string; summary: string }>>;
};
