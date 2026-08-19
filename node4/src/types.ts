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
   * Product engagement template (app_assessment | redteam_deep; Soft retired).
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
   * Product default: delegate_preferred (Main may act). delegate_only = lab hard strip.
   * Env NODE4_GRAPH_MAIN_ACT may also set this.
   */
  graphMainAct?: "delegate_preferred" | "delegate_only";
  /**
   * Expert Graph discipline (structured only — no NLP).
   * "hard" → Graph × Pi runner owns stage order (see hard-graph-*).
   * Product assessment templates also resolve to Expert Graph without this field (#76).
   * Soft scenario product mode is retired — "soft" is legacy/ignored.
   */
  graphDiscipline?: "soft" | "hard";
  /**
   * Expert Graph execution mode (structured only — no NLP). #78 C1 / #282:
   * - omit / "full" on first Graph start → Hard Graph runner
   * - "continue" after Graph task_complete → free-in-envelope chat (no full re-run) (C1)
   * - "resume" after incomplete/interrupted Graph → Hard Graph path (not C1 Free cold OMP)
   * Structured retest/re-entry is `graphExecution=full` (map #81 later).
   */
  graphExecution?: "full" | "continue" | "resume";
  /**
   * Optional finding ids for dig-deeper / focused re-verify (map #81).
   * Structured only — platform/Agent may set; never NLP-invented by Node.
   * Wire: focus_finding_ids | focusFindingIds only.
   */
  focusFindingIds?: string[];
  /**
   * Optional short focus note for dig-deeper (map #81).
   * Structured only — not free-text intent routing.
   */
  focusNote?: string;
  /**
   * Rules-of-engagement: allow host post-ex / lateral.
   * When undefined, derived from engagementTemplate (default false).
   */
  allowPostex?: boolean;
  /** Spec #139 NC-RoE-Destructive: lab may set true; product default false/undefined. */
  allowDestructive?: boolean;
  /**
   * Authorized handoff card body (Default proposed_action). This-turn
   * `### Handoff` only — never the user-turn utterance (#455 / prompt-layers).
   */
  handoffSummary?: string;
  /** Optional test accounts / credentials provided by the customer (structured). */
  accounts?: unknown;
  scanMode?: string;
  /**
   * Parent work-unit task id for multi-agent / sub-agent package workers.
   * Spec #427: sticky pen-sandbox is keyed by (conversationId, expertId), not this field.
   * parentTaskId remains useful for package worker routing / logging.
   */
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
   * Current Case/session title from the platform (e.g. default "新会话").
   * Spec #457 / #482: Main Task layer auto-names when still a placeholder + structured target.
   */
  conversationTitle?: string;
  /**
   * Same-case work-group context from the platform (thread + findings board).
   * Experts joining mid-case should read this like a group chat.
   */
  caseContext?: import("./runtime/case-context.js").CaseContext;
  /**
   * Spec #313 L3: platform-issued one-shot Free todo.init replace grant.
   * Set only after explicit user permission (ChoiceCard replace_todo_map or
   * structured todo_replace_permission). Agent allow_replace alone is never enough.
   */
  todoReplaceAllowed?: boolean;
  /**
   * Spec #354 S4: incomplete Todo snapshot from Case pending-handoff holding
   * (same-expert auto-handoff after Session Delete). Structured only.
   */
  pendingHandoffTodos?: unknown;
  /** Spec #354: true when this assign consumes a Case pending hold (force drop ghost park). */
  pendingHandoff?: boolean;
  /**
   * Spec #455: same-Session dialogue continue (package is accounting only).
   * Park-hit prompts utterance only; unread Case speech is harness prefix, not a second user turn.
   */
  sessionContinue?: boolean;
  /**
   * Node-configured output language — registry wire code only
   * (auto | zh-CN | zh-TW | en | ja). Normalized at the envelope boundary.
   * Agent-authored narrative surfaces; raw tool stdout is never rewritten.
   * See runtime/agent-language.ts + agent-language-catalog.json.
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
  /**
   * This pi-agent-core instance dir:
   * `{workspace}/case-{caseId}/expert-{expertId}/pi-{sessionId}`.
   * Not a Task package id. Park continue reuses it; Reset mints a new one.
   */
  piDir: string;
  /** `{workspace}/case-{caseId}` — Case-shared findings/evidence/surfaces. */
  caseDir?: string;
  /** `{workspace}/case-{caseId}/expert-{expertId}` — Session sandbox + cookies. */
  sessionDir?: string;
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
  /** Process cognition facts (pi instance `facts/`) — separate from finding booking. */
  processFacts?: import("./stores/process-fact.js").ProcessFactStore;
  /**
   * Legacy JSON surface ledger (caseDir/surfaces/ledger.json).
   * Prefer surfaceSqlite for gates; kept for migrate/tests only (#371).
   */
  surfaceLedger?: import("./stores/surface-ledger.js").SurfaceLedgerStore;
  /**
   * Case Surface working store (caseDir/surfaces/ledger.sqlite) — Agent tool + Graph gate SoT (#370–#371).
   * Offline ok without Platform. Online dual-write (#374) via surface_upsert when platformApi set.
   */
  surfaceSqlite?: import("./stores/surface-sqlite.js").SurfaceSqliteStore;
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
     * Spec #308: mutable Worker audit scope for package process frames
     * (agent_id + package_turn_id). Updated each package turn on warm resume.
     */
    workerAudit?: {
      agentId: string;
      packageTurnId: string;
      workerOrdinal?: number;
    } | null;
    /**
     * Spec #493: last Worker `yield` this package (child sessions only).
     */
    workerYield?: import("./runtime/worker-yield.js").WorkerYieldRecord;
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
     * Pathname → how many times Main dispatched a subagent package for it this task.
     * Observability only (Spec #302) — does **not** hard-kill further same-path packages.
     */
    subagentPathDispatchCounts?: Record<string, number>;
    /**
     * Cumulative packages **admitted** (after validation) this task for spawn/queue.
     * Spec #302: NODE4_SUBAGENT_TASK_BUDGET (default 128, max 1024). Exhaustion → clear tool error.
     */
    subagentPackagesAdmitted?: number;
    /**
     * OMP-style idle workers by agent_id (keep-alive after package, incl. soft-fail).
     * Resume: resume_agent_id + same-path affinity.
     * Release: idle TTL timer, maxIdle LRU, maxPackages, op=release, task end disposeAll.
     * Disable: NODE4_SUBAGENT_IDLE=0.
     */
    subagentIdlePool?: import("./runtime/subagent-idle-pool.js").SubagentIdlePool;
    /**
     * Optional seat-scoped sandbox dispose (Session delete / tests).
     * Spec #427: task-end cleanup does **not** call this — sticky env outlives work-bursts.
     */
    browserSandbox?: {
      dispose(seatKey: string): Promise<void>;
    };
    /**
     * finding(confirm) ground-fail counts by title|location — anti-thrash for identical retries.
     * After ≥2 failures, errors include bookable_unbooked judgment guidance.
     */
    findingConfirmFailCounts?: Record<string, number>;
    /**
     * Single Hard Graph run owner (L1/L2 plan, usage, panel, current stage).
     * Set by Hard Graph task path; stages and todo tool read this object only.
     */
    hardGraphRun?: {
      plan: import("./runtime/hard-graph-plan.js").HardGraphPlanStore;
      usage: import("./runtime/llm-usage.js").LlmUsageLedger;
      panel: import("./runtime/panel-agents.js").PanelAgentTracker;
      /** Current stage id while a stage session runs (todo → L2 merge). */
      stageId?: string;
      /**
       * Spec #274: current stage has hypothesis_work_mode: true.
       * Main hypothesis tool writes require this flag.
       */
      hypothesisWorkMode?: boolean;
      /**
       * Spec #139 graph-run Product state (not package honesty).
       * prior seed, L1 refine accounting, unbookable rows, close-out snapshot.
       */
      graphQuality?: import("./runtime/graph-run-quality.js").GraphRunQualityState;
    };
    /**
     * Spec #116 process quality (Finding Store + package honesty + attempt budgets).
     * Single run-wide object shared by stage children — see package-honesty-host.
     * Includes Spec #274 hypothesisStore (run-local queue).
     */
    processQuality?: import("./runtime/package-honesty-host.js").ProcessQualityState;
    /**
     * Spec #274 Wave 2: skill body fingerprints (id → sha256 hex) for reload dedupe.
     * Not gate SOT; does not store full skill bodies.
     */
    skillBodyFingerprints?: Record<string, string>;
  };
};

export type EvidenceStoreLike = {
  create(input: { type: string; sourceTool: string; summary: string; data: unknown }): Promise<{ id: string; path: string }>;
  read(id: string): Promise<unknown | undefined>;
  list(): Promise<Array<{ id: string; summary: string }>>;
};
