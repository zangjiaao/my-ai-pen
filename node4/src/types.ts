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
  /**
   * Product engagement template (app_assessment | redteam_deep | …).
   * Structured only — never derived from instruction free text.
   */
  engagementTemplate?: string;
  /**
   * Rules-of-engagement: allow host post-ex / lateral.
   * When undefined, derived from engagementTemplate (default false).
   */
  allowPostex?: boolean;
  /** Optional test accounts / credentials provided by the customer (structured). */
  accounts?: unknown;
  scanMode?: string;
  /** Optional parent task for future multi-agent platform orchestration (pass-through). */
  parentTaskId?: string;
  /**
   * Explicit structured long-task objective to seed OMP-style goal mode
   * (not free-text NLP on instruction). When set, session starts with goal active.
   */
  goalObjective?: string;
  /** Product expert persona for UI labels (not the physical node name). */
  expertName?: string;
  expertId?: string;
  /**
   * Same-case work-group context from the platform (thread + findings board).
   * Experts joining mid-case should read this like a group chat.
   */
  caseContext?: import("./runtime/case-context.js").CaseContext;
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
    /** OMP mid-run todo reconciliation (mutations since last todo / nudge budget). */
    midRunTodo?: import("./runtime/todo-harness.js").MidRunTodoTracker;
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
