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
   * Alias of scenario Graph id when using Graph work mode.
   */
  engagementTemplate?: string;
  /**
   * Explicit scenario Graph id (Free when unset/none).
   * Prefer over engagementTemplate when both set. Structured only — no NLP.
   */
  graphId?: string;
  /**
   * Graph Main act discipline override (structured).
   * delegate_preferred = soft prompt; delegate_only = strip Main act tools.
   * Env NODE4_GRAPH_MAIN_ACT may also set this.
   */
  graphMainAct?: "delegate_preferred" | "delegate_only";
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
  /**
   * Node-configured output language: auto | zh-CN | en.
   * Controls chat replies + finding title/description narrative (not tool stdout).
   */
  agentLanguage?: string;
};

export type PlatformSink = {
  send(message: PlatformMessage): Promise<void>;
};

/** HTTP access to platform ledger APIs (Node token auth). */
export type PlatformApiAccess = {
  baseUrl: string;
  nodeToken: string;
};

export type ToolRuntime = {
  task: TaskEnvelope;
  workspaceDir: string;
  taskDir: string;
  platform: PlatformSink;
  /** Optional Node→platform HTTP for ledger tools (default seat). */
  platformApi?: PlatformApiAccess;
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
  /** Process cognition facts (taskDir/facts) — separate from finding booking. */
  processFacts?: import("./stores/process-fact.js").ProcessFactStore;
  /** Attack-surface ledger (taskDir/surfaces/ledger.json) — recon coverage truth. */
  surfaceLedger?: import("./stores/surface-ledger.js").SurfaceLedgerStore;
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
    /**
     * Recent act tool observations (memory only) for grounding finding(proof).
     * Not Case evidence — product evidence is created at booking time.
     */
    recentObservations?: import("./tools/common.js").RecentObservation[];
    /**
     * Subagent nest depth: 0 = top-level agent tools; >=1 rejects further subagent (D3).
     */
    subagentDepth?: number;
    /**
     * Optional pentest scenario Graph (Free vs Graph mode).
     * Set by session-runner when pack is pentest.
     */
    pentestGraph?: import("./runtime/pentest-graph.js").PentestGraphContext;
    /**
     * Last subagent evidence package for verbatim finding(confirm) booking.
     */
    lastSubagentEvidence?: import("./runtime/subagent-booking.js").LastSubagentEvidence;
    /** Multi-package cache (newest last); empty shell packages do not wipe prior candidates. */
    subagentEvidenceCache?: import("./runtime/subagent-booking.js").LastSubagentEvidence[];
    /** Flattened index rebuilt from cache for pathname matching / candidate_index. */
    subagentCandidateIndex?: import("./runtime/subagent-booking.js").CachedCandidate[];
    /**
     * Pathname → how many times Main already dispatched a subagent package for it.
     * Soft-limits re-dispatch spam (default max 2 per path).
     */
    subagentPathDispatchCounts?: Record<string, number>;
    /**
     * OMP-style idle workers parked by agent_id after a package finishes.
     * Warm resume only via explicit resume_agent_id + same-path affinity.
     * Disposed on task end. Disable: NODE4_SUBAGENT_IDLE=0.
     */
    subagentIdlePool?: import("./runtime/subagent-idle-pool.js").SubagentIdlePool;
  };
};

export type EvidenceStoreLike = {
  create(input: { type: string; sourceTool: string; summary: string; data: unknown }): Promise<{ id: string; path: string }>;
  read(id: string): Promise<unknown | undefined>;
  list(): Promise<Array<{ id: string; summary: string }>>;
};
