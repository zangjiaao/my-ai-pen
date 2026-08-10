import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import Sidebar from "../components/Sidebar";
import {
  HOME_CHAT_PATH,
  casePath,
  isCaseId,
} from "../lib/caseRoutes";
import TopBar from "../components/TopBar";
import RightPanel from "../components/RightPanel";
import MessageRenderer, {
  AgentPendingCard,
  agentDisplayName,
  shouldShowAgentSpeakerLabel,
} from "../components/MessageRenderer";
import VulnDetailDialog from "../components/VulnDetailDialog";
import AssetDetailDialog from "../components/AssetDetailDialog";
import EvidenceDetailDialog from "../components/EvidenceDetailDialog";
import { useConversationStore } from "../stores/conversationStore";
import { useWebSocket } from "../hooks/useWebSocket";
import { ApiError, authFetch } from "../lib/api";
import { mergeThinkingStatus, mergeToolLifecycleStatus } from "../lib/status";
import { PHASES, phaseLabel } from "../lib/phase";
import {
  findAgentByIdExact,
  legacyWorkerDisplayName,
  scrubWorkerPurpose,
} from "../lib/workerPresentation";
import { filterMainChannelMessages, isWorkerAuditScoped } from "../lib/workerAuditChannel";
import { applyDisplayNameOverrides } from "../lib/workerDisplayName";
import { upsertTrafficExchange, type TrafficExchange } from "../lib/trafficAuditView";
import {
  emptySurfaceLedger,
  ensureSurfaceLedger,
  upsertSurfaceLedger,
  type SurfaceLedger,
  type SurfaceLedgerRow,
} from "../lib/surfaceModel";
import WorkerAuditDialog from "../components/WorkerAuditDialog";
import type { PlanNode, StrixAgentStatus } from "../lib/panelTypes";
import {
  nextViewedRevisionId,
  normalizeTaskMapRevisions,
  type TaskMapRevision,
} from "../lib/taskMapHistory";
import {
  isStrixAgentStatus,
  upsertSubagentChild,
  mergeLivePanelAgents,
  mergeSnapshotAgentsPreserveHarness,
  patchMainAgentActivity,
  preferRicherPlanTree,
  mergePlanTreeByOwner,
  upsertWorkerAgent,
} from "../lib/panelAgentsState";
import {
  projectStreamWithDaySeparators,
  shouldRenderStatusNotice,
} from "../lib/chatStreamChrome";
import {
  buildPendingSendSuccessEvent,
  clearLiveStreams,
  durableStreamSnapshots,
  isProgressiveActivityFrame,
  liveFrameToMessageLike,
  mergeMessagesWithLiveStreams,
  messageListKey,
  pendingChromeSpeakerContent,
  pendingChromeVisible,
  pruneLiveCatchUp,
  reducePendingChrome,
  upsertLiveByStreamId,
  type LiveStreamFrame,
  type PendingChrome,
} from "../lib/messageStreamIdentity";
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { Check, ChevronDown, PanelRight, PanelRightClose, Target, Upload } from "lucide-react";
import type { AgentIdentity, Conversation, Message } from "../lib/types";
import type { SecurityAsset, SecurityEvidence, SecurityVulnerability } from "../lib/securityTypes";
import {
  ENGAGEMENT_TEMPLATES,
  composerEngagementWireFields,
  ENGAGEMENT_UNSPECIFIED_LABEL,
  expertLabel,
  isExpertSchedulable,
  resolveExpertColor,
  type EngagementTemplateId,
  type ExpertId,
} from "../lib/experts";
import { currentInProgressWorksetItemId } from "../lib/workset";
import {
  buildConfirmOptionsText,
  expandSelectedOptions,
  isChoiceDecisionFinal,
  type ChoiceDecision,
} from "../lib/choiceCard";
import {
  composerLiveSeconds,
  composerTimerVisible,
  formatWorkSeconds,
  selectResultAnchorMessageIds,
  type WorkBurstProjection,
} from "../lib/workBurstTime";

const ACTIVE_CONVERSATION_KEY = "active_conversation_id";
/** Set by AssetPage when launching a task from selected hosts/ports. */
const PENDING_ASSET_TASK_KEY = "pending_asset_task";
/**
 * Set by Sidebar「新建会话」. Survives React StrictMode remount (unlike a one-shot
 * consume-before-remount session flag alone). Cleared after blank restore.
 */
const PREFER_BLANK_CHAT_KEY = "prefer_blank_chat";
/**
 * Status panel open/closed preference.
 * Default is collapsed; auto-expands when a task / work surface appears.
 * Manual toggle still wins until the next auto-expand edge or conversation switch.
 */
const RIGHT_PANEL_COLLAPSED_KEY = "right_panel_collapsed";
const MESSAGE_PAGE_SIZE = 200;

function readRightPanelCollapsed(): boolean {
  try {
    const raw = localStorage.getItem(RIGHT_PANEL_COLLAPSED_KEY);
    // Default collapsed (ordinary chat). Only explicit "0" means user left it open.
    if (raw === "0") return false;
    return true;
  } catch {
    return true;
  }
}

type ConversationLocationState = {
  preferBlankChat?: boolean;
};

/** Product expert instance from /api/experts (routable via @name). */
type ProductExpert = {
  id: string;
  name: string;
  display_name?: string;
  pack_id: string;
  node_id: string;
  node_name?: string | null;
  node_status?: string | null;
  enabled?: boolean;
  /** Expert management: sole default partner for new chats. */
  is_default?: boolean;
  description?: string | null;
  color?: string | null;
};

/** @mention picker entry: workspace assistant (default seat) or product expert. */
type MentionTarget = {
  kind: "expert" | "default" | "platform";
  /** Stable key for React list. */
  key: string;
  /** Token after @ */
  name: string;
  label: string;
  subtitle: string;
  nodeId: string;
  packId?: string;
  expertId?: string;
  /** Accent color for partner chip / list (#RRGGBB). */
  color?: string;
  status?: string;
  /** Spec #299: offline-bound experts are listed but not selectable. */
  selectable?: boolean;
};

type Progress = { current: number; total: number; percent: number };
type KanbanBucket = { id: string; title: string; done: number; total: number; status: string };
type KanbanSummary = {
  workflow_kind?: string;
  elapsed_seconds?: number;
  current_stage?: string;
  totals?: Record<string, number>;
  buckets?: KanbanBucket[];
};
type CaseRunSummary = {
  started_at?: string;
  last_active_at?: string;
  participant_count?: number;
  llm_usage?: {
    total_tokens?: number;
    cost?: number;
    requests?: number;
  };
};
type StrixNote = {
  id: string;
  title: string;
  content?: string;
  category?: string;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
};
type StrixRun = {
  run_id?: string;
  run_name?: string;
  status?: string;
  start_time?: string;
  end_time?: string;
  scan_mode?: string;
  targets_info?: Array<{ type?: string; target?: string; original?: string }>;
  llm_usage?: {
    requests?: number;
    input_tokens?: number;
    cached_tokens?: number;
    output_tokens?: number;
    reasoning_tokens?: number;
    total_tokens?: number;
    cost?: number;
    agent_count?: number;
  };
};
type AgentNode = {
  id: string;
  name: string;
  type: AgentIdentity | string;
  status: string;
  token_required?: boolean;
  /** Installed expert pack ids from node.config.offers (default effective: pentest). */
  offers?: string[] | null;
};
type MentionState = { start: number; query: string } | null;

type MessageRecord = Record<string, unknown>;
type MessagesInfiniteData = InfiniteData<MessageRecord[], unknown>;
type ImportStatus = { level: "success" | "error" | "info"; text: string } | null;
type ImportReportResult = {
  conversation_id: string;
  messages_imported?: number;
  assets_imported?: number;
  vulns_imported?: number;
  evidence_imported?: number;
};

type ConversationSnapshot = {
  conversation?: Conversation;
  /** Session-level expert work-burst flag (Node busy / workers). */
  working?: boolean;
  workers?: Array<Record<string, unknown>>;
  participants?: Array<Record<string, unknown>>;
  case_run?: CaseRunSummary;
  /** Spec #325 S2 work-burst time ledger (composer C1 + B1). */
  work_burst?: WorkBurstProjection;
  agent_state?: Record<string, unknown>;
  progress?: Progress;
  kanban?: KanbanSummary;
  plan_tree?: PlanNode[];
  strix_agents?: StrixAgentStatus[];
  strix_notes?: StrixNote[];
  strix_run?: StrixRun;
  findings?: Array<Record<string, unknown>>;
  assets?: Array<Record<string, unknown>>;
  pending_approvals?: Array<Record<string, unknown>>;
  evidence?: Array<Record<string, unknown>>;
  /** Authorized task target / scope from conversation.context.task */
  task_context?: Record<string, unknown>;
  /** Spec #163 Graph engagement close-out (same JSON as Node taskDir file) */
  engagement_closeout?: Record<string, unknown>;
  /** Spec #308 Case Worker display_name overrides */
  worker_display_names?: Record<string, string>;
  /** Spec #309 Case traffic audit store */
  traffic_exchanges?: TrafficExchange[];
  /** Spec #368 / #375 Case surface_ledger (Surface tab SoT) */
  surface_ledger?: SurfaceLedger;
  /** Spec #311 Case Workset (Next) — display-only panel projection */
  workset?: Record<string, unknown>;
  goal_outer?: Record<string, unknown> | null;
  /** Spec #321 Task Map history */
  task_map_revisions?: unknown[];
  live_revision_id?: string | null;
  live_sealed?: boolean;
};


export default function ConversationPage() {
  const { conversations, fetchAll, patchConversation } = useConversationStore();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const { caseId: caseIdParam } = useParams<{ caseId?: string }>();
  /** Canonical Case URL (`/:caseId`). URL is SoT for which session is open. */
  const routeCaseIdRaw = (caseIdParam || "").trim() || null;
  const routeCaseId = routeCaseIdRaw && isCaseId(routeCaseIdRaw) ? routeCaseIdRaw : null;
  const routeCaseIdInvalid = Boolean(routeCaseIdRaw && !routeCaseId);
  // Seed from URL so cross-page open does not flash blank welcome before load.
  const [activeId, setActiveId] = useState<string | null>(() => routeCaseId);
  /**
   * Case id whose messages/state were already loaded (or intentionally opened)
   * for the current mount. Prevents re-loadConversation on URL pin after first
   * send (which would wipe optimistic rows). Null = blank home loaded.
   */
  const caseRouteLoadedRef = useRef<string | null | undefined>(undefined);
  const [homeRestoreDone, setHomeRestoreDone] = useState(false);
  const [stateSnapshotLoaded, setStateSnapshotLoaded] = useState(false);
  const messageScrollerRef = useRef<HTMLDivElement | null>(null);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const stateRefreshSeqRef = useRef(0);
  const pendingScrollRestoreRef = useRef<{ top: number; height: number } | null>(null);
  const pendingScrollToBottomRef = useRef(false);
  const shouldStickToBottomRef = useRef(true);
  const [input, setInput] = useState("");
  /** Explicit long-task Goal mode (structured field → Node4; not NLP). */
  const [goalModeEnabled, setGoalModeEnabled] = useState(false);
  /** Expert Graph template only (S2/U1 #78) — null off-pentest; free is Default seat. */
  const [engagementTemplate, setEngagementTemplate] = useState<EngagementTemplateId | null>(null);
  /** Post-task out-of-scope hosts → user picks next Scope (new task). */
  const [importingReport, setImportingReport] = useState(false);
  const [importStatus, setImportStatus] = useState<ImportStatus>(null);
  /** Selected conversation partner (expert or platform). */
  const [selectedMention, setSelectedMention] = useState<MentionTarget | null>(null);
  const selectedMentionRef = useRef<MentionTarget | null>(null);
  const [partnerMenuOpen, setPartnerMenuOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const partnerMenuRef = useRef<HTMLDivElement | null>(null);
  const modeMenuRef = useRef<HTMLDivElement | null>(null);
  const [agentNodes, setAgentNodes] = useState<AgentNode[]>([]);
  const [productExperts, setProductExperts] = useState<ProductExpert[]>([]);
  const [activeConversationNodeId, setActiveConversationNodeId] = useState<string | null>(null);
  const [agentState, setAgentState] = useState<Record<string, unknown>>({});
  const [progress, setProgress] = useState<Progress | undefined>();
  const [kanban, setKanban] = useState<KanbanSummary | undefined>();
  const [pendingWorkflowKind, setPendingWorkflowKind] = useState<string>("");
  const [planTree, setPlanTree] = useState<PlanNode[]>([]);
  /** Spec #321 Task Map history — product-state revisions; FE selection is view-only. */
  const [taskMapRevisions, setTaskMapRevisions] = useState<TaskMapRevision[]>([]);
  const [liveRevisionId, setLiveRevisionId] = useState<string | null>(null);
  const [pendingHandoffExpertIds, setPendingHandoffExpertIds] = useState<string[]>([]);
  const [viewedRevisionId, setViewedRevisionId] = useState<string | null>(null);
  /** Prior live id for selection policy (follow live after archive unless viewing history). */
  const liveRevisionIdRef = useRef<string | null>(null);
  const [strixAgents, setStrixAgents] = useState<StrixAgentStatus[]>([]);
  const [strixNotes, setStrixNotes] = useState<StrixNote[]>([]);
  const [strixRun, setStrixRun] = useState<StrixRun | undefined>();
  const [caseRun, setCaseRun] = useState<CaseRunSummary | undefined>();
  /** User preference: hide Status panel (like sidebar collapse). Independent of content availability. */
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(readRightPanelCollapsed);
  const [findings, setFindings] = useState<Array<Record<string, unknown>>>([]);
  const [assets, setAssets] = useState<Array<Record<string, unknown>>>([]);
  const [pendingApprovals, setPendingApprovals] = useState<Array<Record<string, unknown>>>([]);
  const [evidence, setEvidence] = useState<Array<Record<string, unknown>>>([]);
  const [taskContext, setTaskContext] = useState<Record<string, unknown> | undefined>();
  /** Spec #163: latest Graph engagement close-out from conversation.context / WS */
  const [engagementCloseout, setEngagementCloseout] = useState<Record<string, unknown> | undefined>();
  /** Spec #308: Case Worker display_name overrides (agent_id → name). */
  const [workerDisplayNames, setWorkerDisplayNames] = useState<Record<string, string>>({});
  /** Spec #308: open Worker audit dialog from collaboration tree. */
  const [workerAuditTarget, setWorkerAuditTarget] = useState<{
    agentId: string;
    panelName?: string;
    workerOrdinal?: number;
  } | null>(null);
  /** Spec #309: Case traffic audit (right-panel Traffic tab). */
  const [trafficExchanges, setTrafficExchanges] = useState<TrafficExchange[]>([]);
  /** Spec #368 / #375: Case surface_ledger (right-panel Surface tab SoT). */
  const [surfaceLedger, setSurfaceLedger] = useState<SurfaceLedger>(() => emptySurfaceLedger());
  /** Spec #311 Case Workset (Next) — display-only panel projection; separate from Tasks */
  const [workset, setWorkset] = useState<Record<string, unknown> | undefined>();
  const [running, setRunning] = useState(false);
  /** Spec #325: work-burst time ledger projection (composer timer + B1). */
  const [workBurst, setWorkBurst] = useState<WorkBurstProjection | null>(null);
  const [composerTickMs, setComposerTickMs] = useState(() => Date.now());
  const composerTickAnchorRef = useRef<{ seconds: number; atMs: number } | null>(null);
  /** True while interrupt was sent and nodes have not yet reported idle. */
  const [interrupting, setInterrupting] = useState(false);
  /**
   * Live progressive frames (text/thinking) updated on every WS frame.
   * Keyed by stream_id only (Spec #276). Pending is chrome, not a live-slot Message.
   */
  const [liveStreams, setLiveStreams] = useState<Record<string, LiveStreamFrame>>({});
  /** List-tail “思考中…” after send — not a Message in RQ or live map. */
  const [pendingChrome, setPendingChrome] = useState<PendingChrome>(null);
  const [selectedVulnerability, setSelectedVulnerability] = useState<Partial<SecurityVulnerability> | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<Partial<SecurityAsset> | null>(null);
  const [selectedEvidence, setSelectedEvidence] = useState<Partial<SecurityEvidence> | null>(null);
  const [highlightedApprovalId, setHighlightedApprovalId] = useState<string | null>(null);
  /** Debounce high-frequency plan_tree_updated so Status/Tasks does not flicker. */
  const planTreeDebounceRef = useRef<number | null>(null);
  const planTreeRefreshThrottleRef = useRef<number>(0);
  /**
   * Optimistic "task just launched" flag. Prevents empty/created snapshots from
   * flipping the composer between Send (disabled) and Interrupt while the backend
   * catches up to status=running / work_status.
   */
  const launchOptimisticRef = useRef(false);
  /** Prevents double-fire of the asset-page handoff effect. */
  const pendingAssetLaunchDoneRef = useRef(false);
  /**
   * Structured target/scope from Asset「创建任务」— applied on first send after
   * user picks an expert (no auto-dispatch).
   */
  const pendingAssetTaskRef = useRef<{
    conversationId: string;
    text: string;
    target: { type: string; value: string } | null;
    scope: { allow: string[]; deny: string[] } | null;
  } | null>(null);
  /** Latest loaders for the one-shot asset-page launch (avoids stale mount closure). */
  const loadConversationRef = useRef<(id: string | null) => Promise<void>>(async () => {});
  const launchTaskMessageRef = useRef<(opts: {
    displayText: string;
    text: string;
    target?: { type: string; value: string } | null;
    scope?: { allow: string[]; deny: string[] } | null;
    forceNewConversation?: boolean;
    conversationId?: string | null;
    goalMode?: boolean;
    goalObjective?: string;
    engagement?: string;
    engagementTemplate?: string;
    allowPostex?: boolean;
    expertId?: string;
  }) => Promise<void>>(async () => {});

  const messageQuery = useInfiniteQuery({
    queryKey: ["conversation-messages", activeId],
    queryFn: ({ pageParam }) => fetchConversationMessagesPage(activeId!, pageParam),
    enabled: Boolean(activeId),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => lastPage.length === MESSAGE_PAGE_SIZE ? allPages.reduce((sum, page) => sum + page.length, 0) : undefined,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  const messages = useMemo(() => messagesFromQueryData(activeId, messageQuery.data as MessagesInfiniteData | undefined), [activeId, messageQuery.data]);
  const displayMessages = useMemo(() => {
    // Spec #308 S-channel: Main chat never renders Worker audit process frames.
    const base = filterMainChannelMessages(messages.filter(isRenderableMessage));
    const mainLive: typeof liveStreams = {};
    for (const [sid, frame] of Object.entries(liveStreams)) {
      if (!isWorkerAuditScoped({ msg_type: frame.msgType, content: frame.content || {} })) {
        mainLive[sid] = frame;
      }
    }
    const merged = mergeMessagesWithLiveStreams(base, mainLive, {
      activeConversationId: activeId,
      liveToMessage: (frame) => {
        const like = liveFrameToMessageLike(frame);
        // Do not invent created_at (epoch or Date.now()) for live frames — stream
        // chrome must wait for durable server time, or stamps flash/wipe on merge.
        return {
          id: like.id,
          conversation_id: like.conversation_id || activeId || "",
          role: "agent" as const,
          msg_type: like.msg_type,
          content: like.content,
          parent_msg_id: null,
          created_at: like.created_at || "",
        } satisfies Message;
      },
    });
    return groupConsecutiveToolMessages(merged);
  }, [messages, liveStreams, activeId]);
  /** Spec #326: messenger day separators over the renderable stream. */
  const streamChromeItems = useMemo(
    () => projectStreamWithDaySeparators(displayMessages),
    [displayMessages],
  );
  const showPendingChrome = pendingChromeVisible(pendingChrome, activeId);
  const activeConversation = useMemo(() => conversations.find(c => c.id === activeId), [activeId, conversations]);
  /**
   * Session work indicator: prefer platform/Node SOT (conversation.working or status=running),
   * then local optimistic launch. Do not show Send while any expert is mid work-burst.
   */
  const isActiveConversationRunning = Boolean(
    running
    || interrupting
    || activeConversation?.working
    || activeConversation?.status === "running"
    || launchOptimisticRef.current,
  );

  // Spec #325 C1: tick composer timer while accruing (pause on authorize).
  const showComposerTimer = composerTimerVisible(workBurst, isActiveConversationRunning);
  useEffect(() => {
    if (!showComposerTimer || workBurst?.authorize_paused || workBurst?.accruing === false) {
      return;
    }
    const id = window.setInterval(() => setComposerTickMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [showComposerTimer, workBurst?.authorize_paused, workBurst?.accruing, workBurst?.active_burst_id]);

  const composerTimerText = useMemo(() => {
    if (!showComposerTimer) return null;
    const secs = composerLiveSeconds(workBurst, {
      nowMs: composerTickMs,
      tickAnchor: workBurst?.authorize_paused || workBurst?.accruing === false
        ? null
        : composerTickAnchorRef.current,
    });
    if (secs == null) return null;
    return formatWorkSeconds(secs);
  }, [showComposerTimer, workBurst, composerTickMs]);

  const resultAnchorSecondsByMessageId = useMemo(() => {
    return selectResultAnchorMessageIds(
      displayMessages.map((m) => ({
        id: m.id,
        role: m.role,
        msg_type: m.msg_type,
        content: m.content as Record<string, unknown>,
      })),
      workBurst?.finalized_work_seconds,
    );
  }, [displayMessages, workBurst?.finalized_work_seconds]);
  const activeWorkflowKind = useMemo(() => {
    if (kanban?.workflow_kind) return kanban.workflow_kind;
    const nodeId = activeConversation?.node_id || activeConversationNodeId || "";
    return String(agentNodes.find(node => node.id === nodeId)?.type || pendingWorkflowKind || "");
  }, [activeConversation?.node_id, activeConversationNodeId, agentNodes, kanban?.workflow_kind, pendingWorkflowKind]);
  /**
   * True when this Case has a real task / engagement surface (target, todos, findings…).
   * Used to auto-expand the Status panel — not to gate whether the user may open it.
   */
  const hasTaskSurface = useMemo(() => {
    if (!activeId) return false;

    const hasRealTarget = Boolean(
      (taskContext as { target?: { value?: string } } | null | undefined)?.target?.value
      || (strixRun?.targets_info || []).some((t) => Boolean(t && (t as { target?: string }).target)),
    );
    const hasWorkProducts = Boolean(
      strixNotes.length
      || findings.length
      || assets.length
      || planTree.some((node) =>
        ["strix_todo", "agent", "coverage", "auditor", "worker", "pi_tool", "pi_workflow", "plan"].includes(String(node.source || "")),
      ),
    );
    // Real multi-worker tree (not a single failed main chat agent).
    const hasWorkerTree = strixAgents.some((a) => {
      const role = String((a as { role?: string }).role || "").toLowerCase();
      const parent = String((a as { parent_id?: string }).parent_id || "");
      return role === "worker" || (parent && parent !== "null");
    });
    // Multi-role Case participants (even after idle) count as task surface.
    const hasMultiRole = strixAgents.filter((a) => !a.parent_id).length > 1
      || strixAgents.some((a) => Boolean(a.expert_id) || String(a.id || "").startsWith("role-"));

    if (!hasRealTarget && !hasWorkProducts && !hasWorkerTree && !hasMultiRole) {
      return false;
    }

    if (hasWorkProducts || hasWorkerTree || hasMultiRole) return true;
    if (hasRealTarget && strixAgents.length) return true;
    if (strixRun && hasRealTarget && (strixRun.start_time || strixRun.scan_mode)) return true;

    const assignedNodeId = activeConversation?.node_id || activeConversationNodeId || "";
    if (!assignedNodeId) return false;

    if (!hasRealTarget && !hasWorkProducts) return false;
    const stage = String(kanban?.current_stage || "").toLowerCase();
    if (kanban && stage && stage !== "idle" && stage !== "confirming") return true;
    if (["pentest", "strix"].includes(String(kanban?.workflow_kind || "")) && stage && hasRealTarget) return true;
    if (isActiveConversationRunning && hasRealTarget && (Boolean(agentState.phase) || Boolean(agentState.activeTool) || planTree.length > 0 || Boolean(kanban))) {
      return true;
    }
    const status = String(activeConversation?.status || "").toLowerCase();
    if (["completed", "incomplete", "failed", "paused"].includes(status) && (hasWorkProducts || (hasRealTarget && (Boolean(kanban) || planTree.length > 0)))) {
      return true;
    }
    return false;
  }, [
    activeConversation?.node_id,
    activeConversation?.status,
    activeConversationNodeId,
    activeId,
    agentState.activeTool,
    agentState.phase,
    assets.length,
    findings.length,
    isActiveConversationRunning,
    kanban,
    planTree,
    strixAgents,
    strixNotes.length,
    strixRun,
    taskContext,
  ]);
  /** Any open conversation can open Status; ordinary chat stays collapsed by default. */
  const rightPanelAvailable = Boolean(activeId);
  const rightPanelOpen = rightPanelAvailable && !rightPanelCollapsed;
  const setRightPanelCollapsedPersist = useCallback((collapsed: boolean) => {
    setRightPanelCollapsed(collapsed);
    try {
      localStorage.setItem(RIGHT_PANEL_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, []);
  const toggleRightPanel = useCallback(() => {
    setRightPanelCollapsedPersist(!rightPanelCollapsed);
  }, [rightPanelCollapsed, setRightPanelCollapsedPersist]);
  /** Rising-edge tracker for auto-expand when a task appears. */
  const prevHasTaskSurfaceRef = useRef(false);
  const rightPanelConvRef = useRef<string | null>(null);

  // Conversation switch → start collapsed; task surface will rising-edge expand after load.
  useEffect(() => {
    if (!activeId) {
      rightPanelConvRef.current = null;
      prevHasTaskSurfaceRef.current = false;
      return;
    }
    if (rightPanelConvRef.current !== activeId) {
      rightPanelConvRef.current = activeId;
      // Assume "had task" until cleared state settles, so stale surface cannot false-trigger expand.
      prevHasTaskSurfaceRef.current = true;
      setRightPanelCollapsedPersist(true);
    }
  }, [activeId, setRightPanelCollapsedPersist]);

  // Auto-expand only on false → true (new task / snapshot with work products).
  useEffect(() => {
    if (!activeId) return;
    const had = prevHasTaskSurfaceRef.current;
    const has = hasTaskSurface;
    if (has && !had) {
      setRightPanelCollapsedPersist(false);
    }
    prevHasTaskSurfaceRef.current = has;
  }, [activeId, hasTaskSurface, setRightPanelCollapsedPersist]);
  const platformAgentNodeId = useMemo(() => agentNodes.find(node => node.type === "platform")?.id || null, [agentNodes]);
  const fallbackPentestNodeId = useMemo(() => {
    const pentestNodeIds = agentNodes.filter(node => node.type === "pentest").map(node => node.id);
    return activeConversation?.node_id || activeConversationNodeId || (pentestNodeIds.length === 1 ? pentestNodeIds[0] : null);
  }, [activeConversation?.node_id, activeConversationNodeId, agentNodes]);
  /** Display labels: product expert id → name only (never physical node name as speaker). */
  const agentNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const e of productExperts) {
      map[e.id] = e.name;
    }
    return map;
  }, [productExperts]);
  const approvalDecisionByRequestId = useMemo(() => {
    const decisions: Record<string, ChoiceDecision> = {};
    for (const message of messages) {
      if (message.msg_type !== "decision") continue;
      const requestId = readString(message.content.request_id);
      const decision = readString(message.content.decision);
      // Spec #277 §3.3 14a / #312 L9: free-text or confirm freezes the card.
      if (requestId && isChoiceDecisionFinal(decision)) {
        decisions[requestId] = decision as ChoiceDecision;
      }
    }
    return decisions;
  }, [messages]);

  /**
   * Spec #312 / US23: disable controls only while tools are mid-flight — not while
   * the Session is blocked on an open ChoiceCard. Waiting for next_steps/authorize
   * still reports conversation.working/running; those cards must stay clickable.
   */
  const hasOpenInteractiveChoice = useMemo(() => {
    for (const item of pendingApprovals) {
      const requestId = String(item.request_id || "").trim();
      if (requestId && !approvalDecisionByRequestId[requestId]) return true;
    }
    for (const message of messages) {
      if (message.msg_type !== "confirm_card" && message.msg_type !== "choice_card") continue;
      const requestId = readString(message.content.request_id);
      if (requestId && !approvalDecisionByRequestId[requestId]) return true;
    }
    return false;
  }, [pendingApprovals, messages, approvalDecisionByRequestId]);

  /** Spec #312: hydrate next_steps checkboxes from structured decision payload. */
  const choiceSelectedByRequestId = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const message of messages) {
      if (message.msg_type !== "decision") continue;
      const requestId = readString(message.content.request_id);
      if (!requestId) continue;
      const raw = message.content.selected_option_ids;
      if (!Array.isArray(raw) || !raw.length) continue;
      map[requestId] = raw.map((x) => String(x || "").trim()).filter(Boolean);
    }
    return map;
  }, [messages]);

  const applyConversationState = useCallback((snapshot: ConversationSnapshot, fallback?: ConversationSnapshot) => {
    setAgentState(hasValues(snapshot.agent_state) ? snapshot.agent_state! : fallback?.agent_state || {});
    setProgress(snapshot.progress || fallback?.progress);
    setKanban(snapshot.kanban || fallback?.kanban);
    // Do not let a snapshot without Graph L1 stages wipe a live Expert Graph plan map
    // (platform used to strip phase nodes as "legacy" — keep richer live tree).
    // Never invent or stick archaeology `plan-phase-*` shells for Default chat Tasks.
    setPlanTree((prev) => {
      const next = snapshot.plan_tree?.length
        ? snapshot.plan_tree
        : fallback?.plan_tree?.length
          ? fallback.plan_tree
          : [];
      return preferRicherPlanTree(prev, next);
    });
    // Spec #354 S4: pending incomplete-map holds for collab badge.
    {
      const raw =
        (snapshot as { pending_handoff_expert_ids?: unknown }).pending_handoff_expert_ids ??
        (fallback as { pending_handoff_expert_ids?: unknown } | undefined)?.pending_handoff_expert_ids;
      if (Array.isArray(raw)) {
        setPendingHandoffExpertIds(raw.map((x) => String(x || "").trim()).filter(Boolean));
      } else {
        setPendingHandoffExpertIds([]);
      }
    }
    // Spec #321: Task Map revisions from product-state (do not invent history on FE).
    // Keep intentional history selection; if user was on live, follow new live after archive.
    {
      const revs = normalizeTaskMapRevisions(
        snapshot.task_map_revisions ?? fallback?.task_map_revisions,
      );
      const liveId =
        (snapshot.live_revision_id != null && String(snapshot.live_revision_id).trim()) ||
        (fallback?.live_revision_id != null && String(fallback.live_revision_id).trim()) ||
        null;
      if (revs.length) {
        setTaskMapRevisions(revs);
      }
      if (liveId) {
        const prevLive = liveRevisionIdRef.current;
        liveRevisionIdRef.current = liveId;
        setLiveRevisionId(liveId);
        setViewedRevisionId((prevView) =>
          nextViewedRevisionId({
            prevViewedId: prevView,
            prevLiveId: prevLive,
            nextLiveId: liveId,
            revisions: revs,
          }),
        );
      } else if (!revs.length) {
        // Brand-new Session: honest empty Tasks, no phantom history.
        setTaskMapRevisions([]);
        liveRevisionIdRef.current = null;
        setLiveRevisionId(null);
        setViewedRevisionId(null);
      }
    }
    // Backend case_participants is SoT for Subagent history — but live Free/Graph badge
    // and pi session_id must not flash off when a mid-stream snapshot omits them.
    const nextAgents = snapshot.strix_agents?.length
      ? snapshot.strix_agents
      : fallback?.strix_agents || [];
    setStrixAgents((prev) => mergeSnapshotAgentsPreserveHarness(prev, nextAgents));
    setStrixNotes(snapshot.strix_notes?.length ? snapshot.strix_notes : fallback?.strix_notes || []);
    // Never replace a populated live run with an empty snapshot object ({} is truthy).
    const nextRun = hasStrixRunSummary(snapshot.strix_run)
      ? snapshot.strix_run
      : hasStrixRunSummary(fallback?.strix_run)
        ? fallback?.strix_run
        : undefined;
    if (nextRun) {
      setStrixRun((prev) => mergeStrixRun(prev, nextRun));
    }
    const nextCaseRun = snapshot.case_run && Object.keys(snapshot.case_run).length
      ? snapshot.case_run
      : fallback?.case_run;
    if (nextCaseRun) setCaseRun(nextCaseRun);
    // Spec #325: work-burst ledger for C1/B1 (prefer snapshot; keep prior if empty).
    const nextWb = snapshot.work_burst && Object.keys(snapshot.work_burst).length
      ? snapshot.work_burst
      : fallback?.work_burst;
    if (nextWb) {
      setWorkBurst(nextWb);
      const live = nextWb.live_work_seconds;
      if (nextWb.active_burst_id && live != null && nextWb.accruing) {
        composerTickAnchorRef.current = { seconds: Number(live) || 0, atMs: Date.now() };
      } else {
        composerTickAnchorRef.current = null;
      }
    } else if (!snapshot.working && !(fallback?.working)) {
      setWorkBurst(null);
      composerTickAnchorRef.current = null;
    }
    // Spec #280: empty ledger arrays are correct — do not fall back to chat archaeology.
    setFindings(Array.isArray(snapshot.findings) ? snapshot.findings : (fallback?.findings || []));
    setAssets(snapshot.assets?.length ? snapshot.assets : fallback?.assets || []);
    setPendingApprovals(snapshot.pending_approvals?.length ? snapshot.pending_approvals : fallback?.pending_approvals || []);
    setEvidence(Array.isArray(snapshot.evidence) ? snapshot.evidence : (fallback?.evidence || []));
    // Spec #309: empty traffic list is correct (tool-channel only).
    setTrafficExchanges(
      Array.isArray(snapshot.traffic_exchanges)
        ? (snapshot.traffic_exchanges as TrafficExchange[])
        : Array.isArray(fallback?.traffic_exchanges)
          ? (fallback?.traffic_exchanges as TrafficExchange[])
          : [],
    );
    // Spec #375: empty surface_ledger is correct (no deposit yet).
    setSurfaceLedger(
      ensureSurfaceLedger(
        snapshot.surface_ledger != null
          ? snapshot.surface_ledger
          : fallback?.surface_ledger,
      ),
    );
    setTaskContext(
      snapshot.task_context && Object.keys(snapshot.task_context).length
        ? snapshot.task_context
        : fallback?.task_context,
    );
    const nextCloseout =
      snapshot.engagement_closeout && Object.keys(snapshot.engagement_closeout).length
        ? snapshot.engagement_closeout
        : fallback?.engagement_closeout;
    if (nextCloseout && Object.keys(nextCloseout).length) {
      setEngagementCloseout(nextCloseout);
    }
    const namesRaw =
      snapshot.worker_display_names && typeof snapshot.worker_display_names === "object"
        ? snapshot.worker_display_names
        : fallback?.worker_display_names;
    if (namesRaw && typeof namesRaw === "object") {
      const nextNames: Record<string, string> = {};
      for (const [k, v] of Object.entries(namesRaw)) {
        const name = String(v || "").trim();
        if (k && name) nextNames[k] = name;
      }
      setWorkerDisplayNames(nextNames);
    }
    // Spec #311: always apply snapshot workset when present (incl. empty projection)
    // so a Case with no open items clears the previous Case's Next list.
    if (snapshot.workset != null && typeof snapshot.workset === "object" && !Array.isArray(snapshot.workset)) {
      setWorkset(snapshot.workset);
    } else if (fallback?.workset != null && typeof fallback.workset === "object" && !Array.isArray(fallback.workset)) {
      setWorkset(fallback.workset);
    }
    const snapshotConversation = snapshot.conversation || fallback?.conversation;
    if (snapshotConversation) setActiveConversationNodeId(snapshotConversation.node_id || null);
    const status = String(snapshotConversation?.status || "").toLowerCase();
    const snapshotWorking = snapshot.working === true
      || snapshotConversation?.working === true
      || status === "running";
    if (snapshotWorking) {
      setRunning(true);
      launchOptimisticRef.current = false;
    } else if (
      status === "completed" ||
      status === "incomplete" ||
      status === "failed" ||
      status === "paused" ||
      status === "blocked" ||
      status === "canceled" ||
      status === "cancelled"
    ) {
      setRunning(false);
      setInterrupting(false);
      launchOptimisticRef.current = false;
    } else if (!launchOptimisticRef.current) {
      // created / idle / unknown — only clear when we are not mid-launch.
      setRunning(false);
      setInterrupting(false);
    }
    // else: keep optimistic running=true so the Interrupt button stays stable.
  }, []);

  const isNearMessageBottom = useCallback(() => {
    const el = messageScrollerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 160;
  }, []);

  const markMessageAutoScroll = useCallback(() => {
    shouldStickToBottomRef.current = isNearMessageBottom();
  }, [isNearMessageBottom]);

  const scrollMessagesToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    window.requestAnimationFrame(() => {
      const el = messageScrollerRef.current;
      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior });
    });
  }, []);

  const refreshConversationState = useCallback(async (id: string | null) => {
    if (!id) return;
    const requestSeq = ++stateRefreshSeqRef.current;
    try {
      const state = await authFetch<ConversationSnapshot>(`/api/conversations/${id}/state`);
      if (requestSeq !== stateRefreshSeqRef.current) return;
      applyConversationState(state);
      setStateSnapshotLoaded(true);
      // Spec #278 D3: do NOT overwrite composer engagementTemplate from Case sticky /
      // heartbeat refresh — only work_mode_settled / user menu edits change it.
      // Spec #312: pack handoff / authorize is ChoiceCard in stream (no composer case banner).
    } catch {
      if (requestSeq !== stateRefreshSeqRef.current) return;
      // The live stream remains usable even if a snapshot refresh races startup.
    }
  }, [applyConversationState]);

  const setConversationMessageData = useCallback((conversationId: string | null, updater: (data: MessagesInfiniteData) => MessagesInfiniteData) => {
    if (!conversationId) return;
    queryClient.setQueryData<MessagesInfiniteData>(["conversation-messages", conversationId], current => updater(current || emptyMessagesData()));
  }, [queryClient]);

  const addMessageToConversation = useCallback((conversationId: string | null, message: Message) => {
    setConversationMessageData(conversationId, data => appendMessageRecord(data, messageRecordFromMessage(message)));
  }, [setConversationMessageData]);

  const clearPendingAgentMessage = useCallback((conversationId: string | null) => {
    setConversationMessageData(conversationId, data => removeMessageRecords(data, record => recordMessageType(record) === "agent_pending"));
  }, [setConversationMessageData]);

  const clearProgressiveStreamUi = useCallback(() => {
    setLiveStreams(clearLiveStreams());
    setPendingChrome((cur) => reducePendingChrome(cur, { type: "terminal" }));
  }, []);

  const applyConversationWorking = useCallback((msg: Record<string, unknown>) => {
    const convId = String(msg.conversation_id || "").trim();
    if (!convId) return;
    const working = msg.working === true || msg.busy === true;
    const interruptingFlag = msg.interrupting === true;
    const statusRaw = String(msg.status || "").trim().toLowerCase();
    const status = (statusRaw || undefined) as Conversation["status"] | undefined;
    patchConversation(convId, {
      ...(status ? { status } : {}),
      working,
    });
    if (convId !== activeId) return;
    setRunning(working);
    if (working) {
      launchOptimisticRef.current = false;
      setInterrupting(Boolean(interruptingFlag));
    } else {
      launchOptimisticRef.current = false;
      // Interrupt settle only (Spec #276) — not every idle blip (would wipe post-send chrome).
      if (interrupting || interruptingFlag) {
        clearProgressiveStreamUi();
        clearPendingAgentMessage(convId);
      }
      setInterrupting(false);
    }
    // Multi-role Case roster: light case_run patch; full snapshot only when multi-role.
    if (isRecord(msg.case_run)) {
      setCaseRun(msg.case_run as CaseRunSummary);
    }
    // Spec #325: work_burst is the sole C1/B1 clock source (not Status elapsed).
    if (isRecord(msg.work_burst)) {
      const wb = msg.work_burst as WorkBurstProjection;
      setWorkBurst(wb);
      const live = wb.live_work_seconds;
      if (wb.active_burst_id && live != null && wb.accruing !== false && !wb.authorize_paused) {
        composerTickAnchorRef.current = { seconds: Number(live) || 0, atMs: Date.now() };
      } else if (!wb.active_burst_id) {
        composerTickAnchorRef.current = null;
      } else {
        // Authorize pause: freeze tick at live value
        composerTickAnchorRef.current = live != null
          ? { seconds: Number(live) || 0, atMs: Date.now() }
          : composerTickAnchorRef.current;
      }
    } else if (!working) {
      setWorkBurst((prev) => (prev?.active_burst_id ? { ...prev, active_burst_id: null, accruing: false } : prev));
      composerTickAnchorRef.current = null;
    }
    const participants = Array.isArray(msg.participants) ? msg.participants : [];
    if (participants.length > 1 || (participants.length === 1 && !working)) {
      void refreshConversationState(convId);
    }
  }, [activeId, clearPendingAgentMessage, clearProgressiveStreamUi, interrupting, patchConversation, refreshConversationState]);

  const { send } = useWebSocket({
    conversation_working: (msg) => {
      applyConversationWorking(msg);
    },
    work_status: (msg) => {
      // Legacy/direct path if platform ever forwards raw work_status to the room.
      applyConversationWorking({
        ...msg,
        working: msg.working === true || msg.busy === true,
      });
    },
    traffic_exchange: (msg) => {
      // Spec #309: live upsert by exchange_id after platform persist (not chat SoT).
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      const id = String(m.exchange_id || "").trim();
      if (!id) return;
      setTrafficExchanges((prev) =>
        upsertTrafficExchange(prev, {
          ...(m as TrafficExchange),
          exchange_id: id,
        }),
      );
    },
    surface_upsert: (msg) => {
      // Spec #375: live merge by origin_key+path_key into Case surface_ledger.
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      const surfaces = Array.isArray(m.surfaces)
        ? (m.surfaces as SurfaceLedgerRow[])
        : m.surface && typeof m.surface === "object"
          ? [m.surface as SurfaceLedgerRow]
          : m.origin_key || m.location
            ? [m as SurfaceLedgerRow]
            : [];
      if (!surfaces.length) return;
      setSurfaceLedger((prev) =>
        upsertSurfaceLedger(prev, {
          surfaces,
          updated_at: m.updated_at != null ? String(m.updated_at) : null,
        }),
      );
    },
    vuln_found: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      // Spec #280: fail-closed rejects use vuln_found_error — never join Findings.
      if (String(m.type || "") === "vuln_found_error") return;
      const convId = messageConversationId(m, activeId);
      clearPendingAgentMessage(convId);
      markMessageAutoScroll();
      const ledgerId = m.vulnerability_id || m.id;
      setFindings(prev => upsertBy(prev, {
        ...m,
        id: ledgerId,
        vulnerability_id: m.vulnerability_id || m.id,
        location: m.location || m.url || m.affected_asset || "",
        description: m.description || m.impact,
        poc: m.poc || m.reproduction,
        affected_asset: m.affected_asset || m.url,
        // Live New badge: keep ledger create signal on panel rows without reload (#275).
        created: m.created,
        is_new: m.is_new !== undefined ? m.is_new : m.created,
      }, "id"));
      addMessageToConversation(convId, makeMessage(convId, "agent", "vuln_card", m));
      void refreshConversationState(convId);
    },
    tool_output: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      const convId = messageConversationId(msg, activeId);
      const workerScoped = isWorkerAuditScoped(m as { channel?: string; agent_id?: string; package_turn_id?: string; content?: Record<string, unknown> });
      // Spec #276: Main tools use tool_call cards only — never reseed pending chrome.
      // Spec #308: Worker tools also persist for dialog but must not drive Main chrome.
      if (!workerScoped) {
        setPendingChrome((cur) => reducePendingChrome(cur, { type: "tool_output" }));
        markMessageAutoScroll();
      }
      const workerStamp: Record<string, unknown> = {};
      const channel = String(m.channel || "").trim();
      const agentId = String(m.agent_id || "").trim();
      const packageTurnId = String(m.package_turn_id || "").trim();
      if (channel) workerStamp.channel = channel;
      if (agentId) workerStamp.agent_id = agentId;
      if (packageTurnId) workerStamp.package_turn_id = packageTurnId;
      // Spec #305 R2: preserve empty/missing status — do not invent "running".
      // MessageRenderer / mergeToolLifecycleStatus use result hints when empty.
      const toolStatus = String(m.status ?? "").trim();
      const incoming = makeMessage(convId, "agent", "tool_call", {
        ...agentAttribution(m),
        ...workerStamp,
        tool_name: String(m.tool_name || ""),
        tool_run_id: m.tool_run_id,
        command: String(m.command || ""),
        status: toolStatus,
        stdout: String(m.stdout || (m.line ? `${m.line}\n` : "") || ""),
        evidence_id: m.evidence_id,
        summary: String(m.summary || m.line || ""),
        display_title: m.display_title || "",
        category: m.category || "",
        target: m.target || "",
        args: m.args,
        result: m.result,
        result_text: m.result_text,
        tool_items: [{
          tool_name: String(m.tool_name || ""),
          tool_run_id: m.tool_run_id,
          status: toolStatus,
          stdout: String(m.stdout || m.line || ""),
          command: String(m.command || ""),
          evidence_id: m.evidence_id,
          summary: String(m.summary || m.line || ""),
          display_title: m.display_title || "",
          category: m.category || "",
          target: m.target || "",
          args: m.args,
          result: m.result,
          result_text: m.result_text,
        }],
        message_id: m.message_id,
      });
      addMessageToConversation(convId, incoming);
      if (!workerScoped) void refreshConversationState(convId);
    },
    worker_package_start: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      const convId = messageConversationId(msg, activeId);
      const handoff = m.handoff && typeof m.handoff === "object" ? m.handoff as Record<string, unknown> : {};
      addMessageToConversation(
        convId,
        makeMessage(convId, "agent", "worker_package_start", {
          channel: "worker_audit",
          agent_id: String(m.agent_id || "").trim(),
          package_turn_id: String(m.package_turn_id || "").trim(),
          handoff,
        }),
      );
    },
    worker_package_delivery: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      const convId = messageConversationId(msg, activeId);
      addMessageToConversation(
        convId,
        makeMessage(convId, "agent", "worker_package_delivery", {
          channel: "worker_audit",
          agent_id: String(m.agent_id || "").trim(),
          package_turn_id: String(m.package_turn_id || "").trim(),
          status: String(m.status || "").trim(),
          summary: String(m.summary || "").trim(),
          settlement: m.settlement,
        }),
      );
    },
    worker_display_name: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      if (m.worker_display_names && typeof m.worker_display_names === "object") {
        const next: Record<string, string> = {};
        for (const [k, v] of Object.entries(m.worker_display_names as Record<string, unknown>)) {
          const name = String(v || "").trim();
          if (k && name) next[k] = name;
        }
        setWorkerDisplayNames(next);
        return;
      }
      const aid = String(m.agent_id || "").trim();
      if (!aid) return;
      const name = m.display_name == null ? "" : String(m.display_name).trim();
      setWorkerDisplayNames((prev) => {
        const next = { ...prev };
        if (!name) delete next[aid];
        else next[aid] = name;
        return next;
      });
    },
    asset_discovered: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      const convId = messageConversationId(msg, activeId);
      clearPendingAgentMessage(convId);
      markMessageAutoScroll();
      setAssets(prev => upsertBy(prev, { ...m, id: m.id || m.asset_id }, "address"));
      addMessageToConversation(convId, makeMessage(convId, "agent", "asset_card", m));
      void refreshConversationState(convId);
    },
    evidence_created: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      const convId = messageConversationId(m, activeId);
      clearPendingAgentMessage(convId);
      setEvidence(prev => upsertBy(prev, m, "evidence_id"));
      void refreshConversationState(convId);
    },
    plan_tree_updated: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      const convId = messageConversationId(msg, activeId);
      const tree = Array.isArray(m.plan_tree) ? m.plan_tree as PlanNode[] : m.plan_node ? [m.plan_node as PlanNode] : [];
      if (tree.length) {
        const ownerId = readString(m.expert_id);
        const ownerName = readString(m.expert_name);
        const stamped = tree.map((node) => ({
          ...node,
          owner_expert_id: readString(node.owner_expert_id) || ownerId || undefined,
          owner_expert_name: readString(node.owner_expert_name) || ownerName || undefined,
        }));
        // Coalesce rapid plan broadcasts (tool start/end) into one UI update.
        // Multi-role: merge by owner so handoff does not wipe the other role's todos.
        if (planTreeDebounceRef.current) window.clearTimeout(planTreeDebounceRef.current);
        planTreeDebounceRef.current = window.setTimeout(() => {
          setPlanTree((prev) => mergePlanTreeByOwner(prev, stamped));
          planTreeDebounceRef.current = null;
        }, 250);
      }
      // Spec #321: update revision metadata; follow live after archive unless viewing history.
      const revs = normalizeTaskMapRevisions(m.task_map_revisions);
      const liveId = readString(m.live_revision_id) || null;
      if (revs.length) {
        setTaskMapRevisions(revs);
      }
      if (liveId) {
        const prevLive = liveRevisionIdRef.current;
        liveRevisionIdRef.current = liveId;
        setLiveRevisionId(liveId);
        setViewedRevisionId((prevView) =>
          nextViewedRevisionId({
            prevViewedId: prevView,
            prevLiveId: prevLive,
            nextLiveId: liveId,
            revisions: revs,
          }),
        );
      }
      if (isProgress(m.progress)) setProgress(m.progress);
      if (isKanbanSummary(m.kanban)) setKanban(m.kanban);
      // Do not append every plan tick to the chat stream — it floods and triggers re-renders.
      // Snapshot refresh is throttled; live tree comes from debounced setPlanTree above.
      const now = Date.now();
      if (now - planTreeRefreshThrottleRef.current > 4000) {
        planTreeRefreshThrottleRef.current = now;
        void refreshConversationState(convId);
      }
    },
    // Hard Graph Agent Graph packages — keep Status tree in sync while workers run.
    subagent_started: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      setRunning(true);
      if (Array.isArray(m.panel_agents) && m.panel_agents.length) {
        const next = m.panel_agents.filter(isStrixAgentStatus);
        setStrixAgents((prev) => mergeLivePanelAgents(prev, next, {
          expert_id: readString(m.expert_id),
          expert_name: readString(m.expert_name),
        }));
      } else {
        // Legacy path: panel_agents missing. Prefer Node panel payload when present.
        const subId = readString(m.subagent_id) || readString(m.id);
        if (!subId) return;
        const assignment = readString(m.assignment) || "";
        const purpose = scrubWorkerPurpose(assignment);
        setStrixAgents((prev) => {
          const existing = findAgentByIdExact(prev, subId);
          return upsertSubagentChild(prev, {
            id: subId,
            name: legacyWorkerDisplayName(prev, subId),
            status: "running",
            parent_id: null,
            task: purpose,
            skills: existing?.skills || [],
            pending_count: 0,
            role: "subagent",
            current_action: "running",
            current_detail: purpose.slice(0, 160) || "子任务执行中",
            expert_id: readString(m.expert_id),
          }, {
            expert_id: readString(m.expert_id),
            expert_name: readString(m.expert_name),
          });
        });
      }
    },
    subagent_finished: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      if (Array.isArray(m.panel_agents) && m.panel_agents.length) {
        const next = m.panel_agents.filter(isStrixAgentStatus);
        setStrixAgents((prev) => mergeLivePanelAgents(prev, next, {
          expert_id: readString(m.expert_id),
          expert_name: readString(m.expert_name),
        }));
        return;
      }
      const subId = readString(m.subagent_id) || readString(m.id);
      if (!subId) return;
      const ok = m.ok !== false && String(m.ok) !== "false";
      const summary = readString(m.summary);
      setStrixAgents((prev) => {
        const existing = findAgentByIdExact(prev, subId);
        const task = scrubWorkerPurpose(existing?.task || "") || scrubWorkerPurpose(summary);
        return upsertSubagentChild(prev, {
          id: subId,
          name: legacyWorkerDisplayName(prev, subId),
          status: ok ? "completed" : "failed",
          parent_id: null,
          task,
          skills: existing?.skills || [],
          pending_count: 0,
          role: "subagent",
          current_action: ok ? "completed" : "failed",
          current_detail: ok
            ? (task ? `已完成：${task}`.slice(0, 160) : "子任务已完成")
            : (summary.slice(0, 160) || "子任务失败"),
          expert_id: readString(m.expert_id),
        }, {
          expert_id: readString(m.expert_id),
          expert_name: readString(m.expert_name),
        });
      });
    },
    completion_blocked: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      const convId = messageConversationId(msg, activeId);
      clearPendingAgentMessage(convId);
      markMessageAutoScroll();
      addMessageToConversation(convId, makeMessage(convId, "system", "status", {
        text: String(m.message || "Runtime completion gate found unresolved runtime safety checks."),
        status: "blocked",
        audit: m.audit,
        round: m.round,
        message_id: m.message_id,
      }));
      void refreshConversationState(convId);
    },
    // Legacy alias only: older nodes may still emit task_incomplete.
    // New Node2 incomplete path uses task_complete(status=incomplete) exclusively.
    task_incomplete: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      const convId = messageConversationId(msg, activeId);
      clearPendingAgentMessage(convId);
      markMessageAutoScroll();
      launchOptimisticRef.current = false;
      setRunning(false);
      setInterrupting(false);
      clearProgressiveStreamUi();
      const status = String(m.status || "incomplete").toLowerCase();
      addMessageToConversation(convId, makeMessage(convId, "system", "status", {
        text: (status === "blocked" ? "Task blocked - " : "Task incomplete - ") + String(m.summary || ""),
        status: status === "blocked" ? "blocked" : "incomplete",
        audit: m.audit,
        summary: m.summary,
        message_id: m.message_id,
      }));
      void fetchAll();
      void refreshConversationState(convId);
    },
    request_decision: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      const convId = messageConversationId(msg, activeId);
      clearPendingAgentMessage(convId);
      markMessageAutoScroll();
      const requestId = String(m.request_id || "");
      setPendingApprovals(prev => upsertBy(prev, m, "request_id"));
      addMessageToConversation(convId, makeMessage(convId, "agent", "confirm_card", m));
      window.dispatchEvent(new CustomEvent("sonner:notify", { detail: { id: `approval-${requestId || crypto.randomUUID()}`, requestId, conversationId: convId || "", message: "Approval required", description: String(m.question || m.proposed_action || "") } }));
      void refreshConversationState(convId);
    },
    checkpoint_update: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      const convId = messageConversationId(msg, activeId);
      const checkpoint = m.checkpoint && typeof m.checkpoint === "object" && !Array.isArray(m.checkpoint) ? m.checkpoint as Record<string, unknown> : {};
      const node3Strix = checkpoint.node3_strix && typeof checkpoint.node3_strix === "object" && !Array.isArray(checkpoint.node3_strix) ? checkpoint.node3_strix as Record<string, unknown> : {};
      // pi-agent-core Agent.sessionId (Node) — collab copy chrome only.
      const agentSessionId = readString(checkpoint.agent_session_id);
      const stampPiSessionId = (list: StrixAgentStatus[]): StrixAgentStatus[] => {
        if (!agentSessionId || agentSessionId.startsWith("expert:") || agentSessionId.startsWith("pack:")) {
          return list;
        }
        const eid = readString(m.expert_id) || readString(checkpoint.expert_id);
        return list.map((a) => {
          if (a.parent_id) return a;
          if (eid && String(a.expert_id || "").trim() && String(a.expert_id || "").trim() !== eid) {
            return a;
          }
          return { ...a, session_id: agentSessionId };
        });
      };
      // Multi-role: merge live panel into existing roster; never wipe other Case participants.
      if (Array.isArray(node3Strix.agents) && node3Strix.agents.length) {
        const next = node3Strix.agents.filter(isStrixAgentStatus);
        setStrixAgents((prev) => stampPiSessionId(mergeLivePanelAgents(prev, next, {
          expert_id: readString(m.expert_id) || readString(checkpoint.expert_id),
          expert_name: readString(m.expert_name) || readString(checkpoint.expert_name),
        })));
      } else if (Array.isArray(checkpoint.panel_agents) && checkpoint.panel_agents.length) {
        const next = checkpoint.panel_agents.filter(isStrixAgentStatus);
        setStrixAgents((prev) => stampPiSessionId(mergeLivePanelAgents(prev, next, {
          expert_id: readString(m.expert_id) || readString(checkpoint.expert_id),
          expert_name: readString(m.expert_name) || readString(checkpoint.expert_name),
        })));
      } else if (agentSessionId) {
        // Checkpoint without panel_agents still updates pi Session id on current Main.
        setStrixAgents((prev) => stampPiSessionId(prev));
      }
      if (Array.isArray(node3Strix.todos)) {
        const todoPlan = strixTodosToPlanTree(node3Strix.todos);
        if (todoPlan.length) setPlanTree(todoPlan);
      }
      if (Array.isArray(node3Strix.notes)) {
        setStrixNotes(node3Strix.notes.filter(isStrixNote));
      }
      if (isStrixRun(node3Strix.run)) {
        setStrixRun((prev) => mergeStrixRun(prev, node3Strix.run as StrixRun));
      } else if (
        checkpoint.llm_usage
        || checkpoint.started_at
        || checkpoint.scan_mode
        || checkpoint.targets_info
        || checkpoint.task_target
        || checkpoint.runtime
      ) {
        // Node2/Node4 synthesize run-like fields on the checkpoint root (not only under node3_strix).
        // Merge with previous so a sparse checkpoint cannot flash-wipe tokens/targets.
        const taskTarget = isRecord(checkpoint.task_target) ? checkpoint.task_target : null;
        const targetValue = taskTarget
          ? readString(taskTarget.value) || readString(taskTarget.url)
          : "";
        const targetsFromTask = targetValue
          ? [{ type: "url", target: targetValue, original: targetValue }]
          : undefined;
        const runLike: StrixRun = {
          run_id: readString(checkpoint.run_id) || readString(checkpoint.task_id),
          status: readString(checkpoint.status),
          start_time: readString(checkpoint.started_at) || readString(checkpoint.start_time),
          end_time: readString(checkpoint.end_time),
          scan_mode: readString(checkpoint.scan_mode) || readString(checkpoint.engagement),
          targets_info: Array.isArray(checkpoint.targets_info)
            ? (checkpoint.targets_info as StrixRun["targets_info"])
            : targetsFromTask,
          llm_usage: isRecord(checkpoint.llm_usage) ? (checkpoint.llm_usage as StrixRun["llm_usage"]) : undefined,
        };
        if (runLike.llm_usage || runLike.start_time || runLike.targets_info || runLike.scan_mode) {
          setStrixRun((prev) => mergeStrixRun(prev, runLike));
        }
      }
      // Spec #280 Wave1: do not merge Strix/checkpoint shadow vulnerabilities into Case Findings.
      // Ledger + vuln_found (post-persist) remain the only panel sources; chat cards still render.
      clearPendingAgentMessage(convId);
      void refreshConversationState(convId);
    },
    // Live Node2 worker lifecycle — do not wait for the next throttled checkpoint.
    worker_started: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      const workerId = readString(m.worker_id) || readString(m.id);
      if (!workerId) return;
      const role = readString(m.role) || "worker";
      setRunning(true);
      setStrixAgents((prev) => upsertWorkerAgent(prev, {
        id: workerId,
        name: `Worker ${role}`,
        status: "running",
        parent_id: "node2-main",
        task: readString(m.task) || "",
        skills: [],
        pending_count: 0,
        role,
        current_tool: "",
        current_action: "running",
      }));
    },
    worker_finished: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      const workerId = readString(m.worker_id) || readString(m.id);
      if (!workerId) return;
      const role = readString(m.role) || "worker";
      const outcome = readString(m.outcome) || (m.ok === false ? "failed" : "completed");
      const status =
        outcome === "timeout" || outcome === "timed_out"
          ? "timed_out"
          : outcome === "completed" || m.ok === true
            ? "completed"
            : outcome === "aborted"
              ? "stopped"
              : "failed";
      setStrixAgents((prev) => upsertWorkerAgent(prev, {
        id: workerId,
        name: `Worker ${role}`,
        status,
        parent_id: "node2-main",
        task: readString(m.task) || "",
        skills: [],
        pending_count: 0,
        role,
        current_tool: "",
        current_action: outcome,
      }));
    },
    intake_update: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      const phase = typeof m.phase === "string" ? m.phase : "intake";
      const convId = messageConversationId(msg, activeId);
      clearPendingAgentMessage(convId);
      markMessageAutoScroll();
      setAgentState({ phase, activeTool: m.active_tool, intakeResult: m.intake_result, intakeStatus: m.status });
      setProgress(progressForPhase(phase, "running"));
      if (isKanbanSummary(m.kanban)) setKanban(m.kanban);
      setRunning(true);
      if (shouldRenderPhaseStatus(m, activeWorkflowKind)) {
        addMessageToConversation(convId, makeMessage(convId, "system", "status", { text: phaseLabel(phase), phase, active_tool: m.active_tool, status: m.status, intake_result: m.intake_result, message_id: m.message_id }));
      }
    },
    // thinking / reasoning / agent_thinking: streamed via upsertStreamedAgentText (handlers below).
    status_update: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      const convId = messageConversationId(msg, activeId);
      // Prefer agent_phase from Node4; legacy used phase.
      const phase = typeof m.agent_phase === "string"
        ? m.agent_phase
        : typeof m.phase === "string"
          ? m.phase
          : undefined;
      const activeTool = m.active_tool != null ? String(m.active_tool) : undefined;
      const currentDetail = typeof m.current_detail === "string" ? m.current_detail : undefined;
      setAgentState({ phase, activeTool: m.active_tool, intakeResult: m.intake_result, intakeStatus: m.status });
      setProgress(isProgress(m.progress) ? m.progress : progressForPhase(phase, "running"));
      if (isKanbanSummary(m.kanban)) setKanban(m.kanban);
      setRunning(true);
      // Live-patch active role activity without wiping other Case participants.
      if (Array.isArray(m.panel_agents) && m.panel_agents.length) {
        const next = m.panel_agents.filter(isStrixAgentStatus);
        setStrixAgents((prev) => mergeLivePanelAgents(prev, next, {
          expert_id: readString(m.expert_id),
          expert_name: readString(m.expert_name),
        }));
      } else if (phase || activeTool || currentDetail) {
        setStrixAgents((prev) =>
          patchMainAgentActivity(prev, {
            phase,
            activeTool: activeTool || "",
            currentDetail,
            running: true,
            expert_id: readString(m.expert_id),
            expert_name: readString(m.expert_name),
          }),
        );
      }
      // Spec #278: hard_graph work_mode on status can stamp Graph badge when panel lags.
      const wm = String(m.work_mode || "").trim();
      if (wm === "free" || wm === "graph" || wm.startsWith("hard_graph")) {
        const gid =
          readString(m.graph_id) ||
          (wm.startsWith("hard_graph:") ? wm.split(":")[1] || "" : "");
        setStrixAgents((prev) =>
          prev.map((a) => {
            if (a.parent_id) return a;
            return {
              ...a,
              work_mode: wm === "free" ? "free" : "graph",
              graph_id: wm === "free" ? undefined : gid || a.graph_id,
              graph_label:
                wm === "free"
                  ? undefined
                  : readString(m.graph_label) || a.graph_label,
            };
          }),
        );
      }
      // Internal harness ticks (model turn / tool running) update right-panel state only —
      // never inject as agent chat bubbles (that was showing "model turn" under 测试节点).
      const statusMessage = readString(m.message);
      if (statusMessage && isUserVisibleStatusMessage(statusMessage)) {
        addMessageToConversation(
          convId,
          makeMessage(convId, "system", "status", {
            ...agentAttribution(m),
            text: statusMessage,
            phase,
            active_tool: m.active_tool,
            status: m.status,
            message_id: m.message_id,
          }),
        );
      } else if (shouldRenderPhaseStatus(m, activeWorkflowKind)) {
        addMessageToConversation(convId, makeMessage(convId, "system", "status", {
          text: phaseLabel(phase),
          phase,
          iteration: m.iteration,
          active_tool: m.active_tool,
          status: m.status,
          intake_result: m.intake_result,
          message_id: m.message_id,
        }));
      }
    },
    engagement_closeout: (msg) => {
      // Same msg_type as platform persist path (engagement_closeout) — not a live-only status disguise.
      // Gist text prefers Node/platform message; do not re-build residual strings here (M2).
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      const convId = messageConversationId(msg, activeId);
      const closeout =
        m.engagement_closeout && typeof m.engagement_closeout === "object" && !Array.isArray(m.engagement_closeout)
          ? (m.engagement_closeout as Record<string, unknown>)
          : null;
      if (closeout && Object.keys(closeout).length) {
        setEngagementCloseout(closeout);
      }
      markMessageAutoScroll();
      const terminal = String(closeout?.terminal || m.status || "unknown");
      const processComplete = closeout?.process_complete;
      const nodeText = String(m.message || "").trim();
      const text =
        nodeText ||
        `Engagement close-out · terminal=${terminal}` +
          (processComplete === false ? " · process incomplete" : "");
      addMessageToConversation(
        convId,
        makeMessage(convId, "system", "engagement_closeout", {
          text,
          status: terminal,
          terminal,
          type: "engagement_closeout",
          engagement_closeout: closeout || undefined,
          process_complete: processComplete,
          residual_risk: closeout?.residual_risk,
          message_id: m.message_id,
        }),
      );
    },
    task_complete: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      const convId = messageConversationId(msg, activeId);
      clearPendingAgentMessage(convId);
      markMessageAutoScroll();
      launchOptimisticRef.current = false;
      setRunning(false);
      setInterrupting(false);
      // Live streams are already mirrored into the message cache; drop overlay + chrome.
      clearProgressiveStreamUi();
      const terminal = String(m.status || "completed").toLowerCase();
      const nextStatus = (
        terminal === "incomplete" || terminal === "blocked"
          ? "incomplete"
          : terminal === "failed"
            ? "failed"
            : "completed"
      ) as Conversation["status"];
      if (convId) patchConversation(convId, { status: nextStatus, working: false });
      // Single terminal channel: completed | incomplete | blocked (no separate task_incomplete).
      const status = String(m.status || "completed").toLowerCase();
      const incomplete = status === "incomplete" || status === "blocked";
      addMessageToConversation(convId, makeMessage(convId, "system", "status", {
        text: incomplete
          ? (status === "blocked" ? "Task blocked - " : "Task incomplete - ") + String(m.summary || "")
          : "Task complete - " + JSON.stringify(m.summary || {}),
        status: incomplete ? status : "completed",
        summary: m.summary || {},
        audit: m.audit,
        message_id: m.message_id,
      }));
      void fetchAll();
      void refreshConversationState(convId);
    },
    task_error: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const convId = messageConversationId(msg, activeId);
      clearPendingAgentMessage(convId);
      markMessageAutoScroll();
      launchOptimisticRef.current = false;
      setRunning(false);
      setInterrupting(false);
      clearProgressiveStreamUi();
      if (convId) patchConversation(convId, { status: "failed", working: false });
      addMessageToConversation(convId, makeMessage(convId, "system", "status", { text: "Task failed: " + ((msg as Record<string, unknown>).message || ""), message_id: (msg as Record<string, unknown>).message_id }));
      void fetchAll();
      void refreshConversationState(convId);
    },
    partner_switch: (msg) => {
      // Platform applied an authorized handoff — align the partner chip with sticky expert.
      const m = msg as Record<string, unknown>;
      const expertId = String(m.expert_id || "").trim();
      const expertName = String(m.expert_name || "").trim();
      const packId = String(m.pack_id || m.engagement || "").trim();
      const match = mentionTargets.find(
        (t) =>
          t.kind === "expert" &&
          ((expertId && t.expertId === expertId) ||
            (expertName && t.name === expertName) ||
            (packId && t.packId === packId)),
      );
      if (match) {
        selectedMentionRef.current = match;
        setSelectedMention(match);
      }
    },
    // Spec #278 D3: sync composer Workflow control only after mode settlement (once).
    work_mode_settled: (msg) => {
      const m = msg as Record<string, unknown>;
      const mode = String(m.work_mode || "").trim().toLowerCase();
      const gid = String(m.graph_id || m.engagement_template || "").trim().toLowerCase();
      if (mode === "graph") {
        if (gid === "redteam_deep") setEngagementTemplate("redteam_deep");
        else if (gid === "app_assessment") setEngagementTemplate("app_assessment");
        else if (gid === "hypothesis_cycle") setEngagementTemplate("hypothesis_cycle");
        else if (gid === "redteam" || gid === "deep") setEngagementTemplate("redteam_deep");
        else if (gid === "assess" || gid === "assessment") setEngagementTemplate("app_assessment");
      } else if (mode === "free") {
        setEngagementTemplate(null);
      }
      // Patch highlighted main AgentRow badge from Session actual mode.
      setStrixAgents((prev) =>
        prev.map((a) => {
          if (a.parent_id) return a;
          if (m.expert_id && a.expert_id && String(a.expert_id) !== String(m.expert_id)) {
            return a;
          }
          return {
            ...a,
            work_mode: mode === "graph" ? "graph" : "free",
            graph_id: mode === "graph" ? gid || undefined : undefined,
            graph_label:
              mode === "graph"
                ? String(m.graph_label || "").trim() || undefined
                : undefined,
          };
        }),
      );
    },
    // next_scope_suggested: no composer banner — OOS hosts land in Case Workset → chat-end choice chips.
    workset_updated: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      if (m.workset && typeof m.workset === "object" && !Array.isArray(m.workset)) {
        setWorkset(m.workset as Record<string, unknown>);
      }
    },
    text: (msg) => {
      upsertStreamedAgentText(msg, "text");
      // Chat-only platform/expert replies must never leave the session stuck in working.
      const content = (msg.content && typeof msg.content === "object" && !Array.isArray(msg.content)
        ? msg.content as Record<string, unknown>
        : {}) as Record<string, unknown>;
      const mode = String(content.agent_mode || msg.agent_mode || "").toLowerCase();
      if (
        mode === "expert_preamble"
        || mode === "expert_room_chat"
        || mode === "clarification"
        || mode === "platform_chat"
        || mode === "missing_target"
        || mode === "no_online_executor"
      ) {
        const convId = messageConversationId(msg, activeId);
        launchOptimisticRef.current = false;
        setRunning(false);
        setInterrupting(false);
        if (convId) {
          // Keep idle room status — do not promote to running/failed from chat.
          const cur = String(activeConversation?.status || "").toLowerCase();
          if (!cur || cur === "created" || cur === "running") {
            patchConversation(convId, { working: false, ...(cur === "running" ? { status: "created" } : {}) });
          } else {
            patchConversation(convId, { working: false });
          }
        }
      }
    },
    thinking: (msg) => {
      upsertStreamedAgentText(msg, "thinking");
    },
    agent_thinking: (msg) => {
      upsertStreamedAgentText(msg, "thinking");
    },
    reasoning: (msg) => {
      upsertStreamedAgentText(msg, "thinking");
    },
  });

  function upsertStreamedAgentText(msg: Record<string, unknown>, msgType: "text" | "thinking") {
    if (!isActiveMessage(msg, activeId)) return;
    const raw = msg;
    const c = (raw.content && typeof raw.content === "object" && !Array.isArray(raw.content)
      ? { ...(raw.content as Record<string, unknown>) }
      : {}) as Record<string, unknown>;
    // Spec #308: stamp Worker scope from top-level wire onto content for channel filter.
    const channel = readString(raw.channel) || readString(c.channel);
    const agentId = readString(raw.agent_id) || readString(c.agent_id);
    const packageTurnId = readString(raw.package_turn_id) || readString(c.package_turn_id);
    if (channel) c.channel = channel;
    if (agentId) c.agent_id = agentId;
    if (packageTurnId) c.package_turn_id = packageTurnId;
    const streamId = readString(c.stream_id) || readString(raw.stream_id);
    // Fail-closed: progressive live list requires stream_id (Spec #276).
    if (!streamId) return;
    const messageId = readString(c.message_id) || readString(raw.message_id);
    c.stream_id = streamId;
    if (messageId) c.message_id = messageId;
    const body = readString(c.text) || readString(c.reasoning) || readString(raw.text);
    const status = readString(c.status) || readString(raw.status);
    if (msgType === "thinking" && status) c.status = status;
    // Spec #305: empty running/done thinking is progressive activity (Issue 1 / 4).
    if (!isProgressiveActivityFrame({ streamId, msgType, text: body, status: c.status || status })) {
      return;
    }
    c.text = body;
    if (msgType === "thinking") c.reasoning = body;
    const convId = messageConversationId(raw, activeId);
    const workerScoped = isWorkerAuditScoped({ msg_type: msgType, content: c, channel, agent_id: agentId, package_turn_id: packageTurnId });
    if (!workerScoped) markMessageAutoScroll();
    const attribution = agentAttribution(raw);
    const content = { ...attribution, ...c };
    const message = makeMessage(convId, "agent", msgType, content);
    // Working hides on first progressive thinking/text (tool_output also clears).
    // Spec #308: Worker process is dialog-only — do not drive Main chrome.
    if (!workerScoped) {
      setPendingChrome((cur) => reducePendingChrome(cur, { type: "stream_started" }));
    }
    setLiveStreams((prev) =>
      upsertLiveByStreamId(prev, {
        streamId,
        msgType,
        text: body,
        messageId: messageId || message.id || undefined,
        conversationId: convId || undefined,
        content,
      }),
    );
    // Scrub any historical agent_pending rows; do not write new ones.
    if (convId && !workerScoped) clearPendingAgentMessage(convId);
    // Mirror progressive frames into durable message cache (RQ SOT) — Worker too for Case replay.
    addMessageToConversation(convId, message);
  }
  const locateApproval = useCallback((requestId: string) => {
    if (!requestId) return;
    setHighlightedApprovalId(requestId);
    window.setTimeout(() => {
      const target = Array.from(document.querySelectorAll<HTMLElement>("[data-approval-request-id]")).find((element) => element.dataset.approvalRequestId === requestId);
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 0);
    window.setTimeout(() => setHighlightedApprovalId(current => current === requestId ? null : current), 2400);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ requestId?: string; conversationId?: string }>).detail || {};
      if (detail.conversationId && activeId && detail.conversationId !== activeId) return;
      if (detail.requestId) locateApproval(detail.requestId);
    };
    window.addEventListener("approval:locate", handler as EventListener);
    return () => window.removeEventListener("approval:locate", handler as EventListener);
  }, [activeId, locateApproval]);

  const resetConversationState = useCallback(() => {
    setAgentState({});
    setActiveConversationNodeId(null);
    setProgress(undefined);
    setKanban(undefined);
    setPendingWorkflowKind("");
    setPlanTree([]);
    setTaskMapRevisions([]);
    liveRevisionIdRef.current = null;
    setLiveRevisionId(null);
    setViewedRevisionId(null);
    setStrixAgents([]);
    setStrixNotes([]);
    setStrixRun(undefined);
    setCaseRun(undefined);
    setFindings([]);
    setAssets([]);
    setPendingApprovals([]);
    setEvidence([]);
    setTrafficExchanges([]);
    setSurfaceLedger(emptySurfaceLedger());
    setTaskContext(undefined);
    setEngagementCloseout(undefined);
    setWorkerDisplayNames({});
    setWorkerAuditTarget(null);
    // Spec #311: clear Case Workset on conversation switch / blank chat (no bleed).
    setWorkset(undefined);
    launchOptimisticRef.current = false;
    setRunning(false);
    setInterrupting(false);
  }, []);

  const loadConversation = useCallback(async (id: string | null) => {
    stateRefreshSeqRef.current += 1;
    setLiveStreams(clearLiveStreams());
    setPendingChrome((cur) => reducePendingChrome(cur, { type: "clear" }));
    if (!id) {
      caseRouteLoadedRef.current = null;
      localStorage.removeItem(ACTIVE_CONVERSATION_KEY);
      void queryClient.removeQueries({ queryKey: ["conversation-messages"] });
      setActiveId(null);
      resetConversationState();
      return;
    }
    // Selecting a real session cancels any pending blank-chat intent.
    try {
      sessionStorage.removeItem(PREFER_BLANK_CHAT_KEY);
    } catch {
      /* ignore */
    }

    // Mark before fetch so same-route effect re-runs (e.g. conversations list
    // refresh) do not re-enter load and wipe live/optimistic state.
    caseRouteLoadedRef.current = id;
    setStateSnapshotLoaded(false);
    pendingScrollToBottomRef.current = true;
    shouldStickToBottomRef.current = true;
    void queryClient.removeQueries({ queryKey: ["conversation-messages"] });
    // Clear previous Case surface first so Status auto-expand does not use stale task data.
    resetConversationState();
    setActiveId(id);
    setActiveConversationNodeId(conversations.find(c => c.id === id)?.node_id || null);
    localStorage.setItem(ACTIVE_CONVERSATION_KEY, id);
    send({ type: "subscribe", conversation_id: id });

    const conversationStatus = conversations.find(c => c.id === id)?.status || "created";
    const fallbackState = snapshotFromMessages([], conversationStatus);

    try {
      const state = await authFetch<ConversationSnapshot>(`/api/conversations/${id}/state`);
      applyConversationState(state);
      setStateSnapshotLoaded(true);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        caseRouteLoadedRef.current = null;
        localStorage.removeItem(ACTIVE_CONVERSATION_KEY);
        void queryClient.removeQueries({ queryKey: ["conversation-messages", id] });
        setActiveId(null);
        resetConversationState();
        void fetchAll();
        // Drop dead Case URL so operator lands on blank home, not a stuck `/:missing`.
        navigate(HOME_CHAT_PATH, { replace: true, state: { preferBlankChat: true } });
        try {
          sessionStorage.setItem(PREFER_BLANK_CHAT_KEY, "1");
        } catch {
          /* ignore */
        }
        return;
      }
      applyConversationState(fallbackState);
      setStateSnapshotLoaded(false);
    }
  }, [applyConversationState, conversations, fetchAll, navigate, queryClient, resetConversationState, send]);
  loadConversationRef.current = loadConversation;

  useEffect(() => {
    if (!activeId || stateSnapshotLoaded || messageQuery.isLoading || messages.length === 0) return;
    const conversationStatus = conversations.find(c => c.id === activeId)?.status || "created";
    applyConversationState(snapshotFromMessages(messages, conversationStatus));
  }, [activeId, conversations, messages, messageQuery.isLoading, stateSnapshotLoaded, applyConversationState]);

  // Spec #276: catch-up prune — drop live keys when RQ already has same stream_id with text ≥ live.
  useEffect(() => {
    setLiveStreams((prev) => {
      if (!Object.keys(prev).length) return prev;
      return pruneLiveCatchUp(prev, durableStreamSnapshots(messages));
    });
  }, [messages]);

  useEffect(() => { void fetchAll(); }, [fetchAll]);

  const loadAgentNodes = useCallback(async () => {
    try {
      setAgentNodes(await authFetch<AgentNode[]>("/api/nodes"));
    } catch {
      setAgentNodes([]);
    }
  }, []);

  const loadProductExperts = useCallback(async () => {
    try {
      const rows = await authFetch<ProductExpert[]>("/api/experts");
      setProductExperts(Array.isArray(rows) ? rows.filter((e) => e.enabled !== false) : []);
    } catch {
      setProductExperts([]);
    }
  }, []);

  useEffect(() => {
    void loadAgentNodes();
    void loadProductExperts();
  }, [loadAgentNodes, loadProductExperts]);

  useEffect(() => {
    const reload = () => {
      void loadAgentNodes();
      void loadProductExperts();
    };
    window.addEventListener("focus", reload);
    window.addEventListener("nodes:changed", reload);
    window.addEventListener("experts:changed", reload);
    return () => {
      window.removeEventListener("focus", reload);
      window.removeEventListener("nodes:changed", reload);
      window.removeEventListener("experts:changed", reload);
    };
  }, [loadAgentNodes, loadProductExperts]);

  /**
   * Partner options = 专家管理列表 only (no synthetic 工作台助手).
   * Create assistants/experts under 专家管理; pack_id=default uses Node built-in seat.
   */
  const mentionTargets = useMemo(() => {
    const out: MentionTarget[] = [];
    for (const e of productExperts) {
      if (e.enabled === false) continue;
      const selectable = isExpertSchedulable(e.node_status);
      out.push({
        kind: "expert" as const,
        key: `expert:${e.id}`,
        name: e.name,
        label: e.name,
        subtitle: `${expertLabel(e.pack_id)} → ${e.node_name || e.node_id.slice(0, 8)}${
          e.node_status ? ` (${e.node_status})` : ""
        }${selectable ? "" : " · 不可调度"}`,
        nodeId: e.node_id,
        packId: e.pack_id,
        expertId: e.id,
        color: resolveExpertColor(e.color, e.id),
        status: e.node_status || undefined,
        selectable,
      });
    }
    return out;
  }, [productExperts]);

  // Default partner: online is_default → online pack=default → first online (Spec #299).
  // Re-pick when current Expert goes offline or is removed.
  useEffect(() => {
    if (selectedMention) {
      const current = mentionTargets.find((t) => t.key === selectedMention.key);
      // Drop if deleted or bound node went offline (not selectable).
      if (!current || current.selectable === false) {
        const fallback = pickDefaultMentionTarget(mentionTargets, productExperts);
        selectedMentionRef.current = fallback;
        setSelectedMention(fallback);
      }
      return;
    }
    if (!mentionTargets.length) return;
    const pick = pickDefaultMentionTarget(mentionTargets, productExperts);
    if (!pick) return;
    selectedMentionRef.current = pick;
    setSelectedMention(pick);
  }, [mentionTargets, selectedMention, productExperts]);

  const mentionState = useMemo(() => getMentionState(input), [input]);
  const mentionOptions = useMemo(
    () => filterMentionTargets(mentionTargets, mentionState?.query || ""),
    [mentionTargets, mentionState],
  );

  // Case URL is the only SoT for the open session. localStorage is last-active
  // cache (redirect `/` → `/:id`). preferBlank forces blank home without redirect.
  useEffect(() => {
    // Non-UUID segment under conversation shell → bounce home.
    if (routeCaseIdInvalid) {
      navigate(HOME_CHAT_PATH, { replace: true, state: { preferBlankChat: true } });
      try {
        sessionStorage.setItem(PREFER_BLANK_CHAT_KEY, "1");
      } catch {
        /* ignore */
      }
      return;
    }

    // Explicit `/:caseId` always wins (history click, deep link, refresh, pin after create).
    if (routeCaseId) {
      try {
        sessionStorage.removeItem(PREFER_BLANK_CHAT_KEY);
      } catch {
        /* ignore */
      }
      setHomeRestoreDone(false);
      // Already loaded / intentionally opened this Case (incl. first-send URL pin).
      if (caseRouteLoadedRef.current === routeCaseId) {
        if (activeId !== routeCaseId) setActiveId(routeCaseId);
        return;
      }
      void loadConversation(routeCaseId);
      return;
    }

    // Home `/` only below this point.
    if (location.pathname !== "/" && location.pathname !== "") return;

    // Asset-page launch may still land on `/` with a pending draft (legacy).
    if (sessionStorage.getItem(PENDING_ASSET_TASK_KEY)) return;

    const locState = (location.state || null) as ConversationLocationState | null;
    const preferBlank =
      locState?.preferBlankChat === true ||
      (() => {
        try {
          return sessionStorage.getItem(PREFER_BLANK_CHAT_KEY) === "1";
        } catch {
          return false;
        }
      })();

    // Sidebar「新建会话」 / deleted active Case: stay on blank composer.
    if (preferBlank) {
      // undefined = never settled; string id = open Case; null = already blank.
      const needsBlankLoad =
        activeId != null || caseRouteLoadedRef.current !== null;
      if (needsBlankLoad) {
        void loadConversation(null);
      } else {
        caseRouteLoadedRef.current = null;
      }
      setHomeRestoreDone(true);
      try {
        sessionStorage.removeItem(PREFER_BLANK_CHAT_KEY);
      } catch {
        /* ignore */
      }
      // Drop one-shot location state so refresh keeps normal restore behavior.
      if (locState?.preferBlankChat) {
        navigate(".", { replace: true, state: {} });
      }
      return;
    }

    if (homeRestoreDone) return;

    const storedId = localStorage.getItem(ACTIVE_CONVERSATION_KEY);
    // Honor last-active cache by canonicalizing to `/:id`.
    if (storedId && isCaseId(storedId)) {
      setHomeRestoreDone(true);
      navigate(casePath(storedId), { replace: true });
      return;
    }

    // No stored id → blank composer. Do not auto-pick conversations[0] / running.
    caseRouteLoadedRef.current = null;
    setHomeRestoreDone(true);
  }, [
    activeId,
    homeRestoreDone,
    loadConversation,
    location.pathname,
    location.state,
    navigate,
    routeCaseId,
    routeCaseIdInvalid,
  ]);

  useEffect(() => {
    if (activeId) send({ type: "subscribe", conversation_id: activeId });
  }, [activeId, send]);

  useEffect(() => {
    if (!activeId || !isActiveConversationRunning) return;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await refreshConversationState(activeId);
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => { void refresh(); }, 2000);
    return () => window.clearInterval(timer);
  }, [activeId, isActiveConversationRunning, refreshConversationState]);

  const handleDecision = useCallback((requestId: string, decision: "authorize" | "cancel") => {
    if (!activeId || !requestId) return;
    setPendingApprovals(prev => prev.filter(item => item.request_id !== requestId));
    addMessageToConversation(activeId, makeMessage(activeId, "user", "decision", { request_id: requestId, decision }));
    send({ type: "user_decision", conversation_id: activeId, request_id: requestId, decision });
  }, [activeId, addMessageToConversation, send]);

  /** Spec #313: next_steps confirm → selected ids + full text (title/body + optional supplement). */
  const handleConfirmOptions = useCallback(
    (
      requestId: string,
      selectedOptionIds: string[],
      cardContent: Record<string, unknown>,
      supplement?: string,
    ) => {
      if (!activeId || !requestId || !selectedOptionIds.length) return;
      const expanded = expandSelectedOptions(cardContent, selectedOptionIds);
      const text = buildConfirmOptionsText(cardContent, selectedOptionIds, supplement);
      setPendingApprovals((prev) => prev.filter((item) => item.request_id !== requestId));
      addMessageToConversation(
        activeId,
        makeMessage(activeId, "user", "decision", {
          request_id: requestId,
          decision: "confirm_options",
          selected_option_ids: selectedOptionIds,
          workset_item_ids: expanded.workset_item_ids,
          text,
          supplement: String(supplement || "").trim() || undefined,
        }),
      );
      send({
        type: "user_decision",
        conversation_id: activeId,
        request_id: requestId,
        decision: "confirm_options",
        selected_option_ids: selectedOptionIds,
        workset_item_ids: expanded.workset_item_ids,
        text,
        supplement: String(supplement || "").trim() || undefined,
      });
    },
    [activeId, addMessageToConversation, send],
  );

  const chooseMention = useCallback((target: MentionTarget) => {
    // Spec #299: offline-bound Expert is not a conversation partner.
    if (target.selectable === false) return;
    // Select partner only — do not inject "@name" into the composer text.
    const state = getMentionState(input);
    if (state) {
      setInput((current) => {
        const before = current.slice(0, state.start).replace(/\s+$/, "");
        const after = current.slice(state.start + state.query.length + 1).replace(/^\s+/, "");
        return [before, after].filter(Boolean).join(" ");
      });
    }
    selectedMentionRef.current = target;
    setSelectedMention(target);
    if (!isPentestMentionTarget(target)) {
      setGoalModeEnabled(false);
    }
  }, [input]);

  const handleImportReport = useCallback(async (file: File | null) => {
    if (!file) return;
    setImportingReport(true);
    setImportStatus({ level: "info", text: "Importing conversation..." });
    const form = new FormData();
    form.append("file", file);
    try {
      const result = await authFetch<ImportReportResult>("/api/sync/import", { method: "POST", body: form });
      const summary = `Import complete: messages ${result.messages_imported || 0}, assets ${result.assets_imported || 0}, vulnerabilities ${result.vulns_imported || 0}, evidence ${result.evidence_imported || 0}`;
      setImportStatus({ level: "success", text: summary });
      await fetchAll();
      // Mark loaded after loadConversation; pin URL without remount (layout shell).
      await loadConversation(result.conversation_id);
      navigate(casePath(result.conversation_id), { replace: true });
    } catch (error) {
      const message = error instanceof ApiError ? String(error.message) : "Import failed. Please confirm this is a pentest-node report.tar.gz export.";
      setImportStatus({ level: "error", text: message });
    } finally {
      setImportingReport(false);
      if (importFileInputRef.current) importFileInputRef.current.value = "";
    }
  }, [fetchAll, loadConversation, navigate]);

  const launchTaskMessage = useCallback(async (opts: {
    displayText: string;
    text: string;
    target?: { type: string; value: string } | null;
    scope?: { allow: string[]; deny: string[] } | null;
    forceNewConversation?: boolean;
    conversationId?: string | null;
    /** Explicit Goal mode for this assign (UI switch). */
    goalMode?: boolean;
    goalObjective?: string;
    /** Explicit engagement from @expert pack (structured; not NLP). */
    engagement?: string;
    /** Product Expert Graph template (app_assessment | redteam_deep). */
    engagementTemplate?: string;
    allowPostex?: boolean;
    expertId?: string;
  }) => {
    const displayText = opts.displayText.trim();
    const text = opts.text.trim() || displayText;
    if (!displayText) return;
    const goalObjectiveText = String(opts.goalObjective || "").trim();
    // Explicit goal_mode true|false so platform sticky task can clear Goal-off
    // (Grok: only explicit off stops Goal outer — not Esc/interrupt).
    // When off, stamp user_stopped so Case Workset can terminal goal_stopped on assign/settle.
    const goalPayload: Record<string, unknown> =
      opts.goalMode === true
        ? {
            goal_mode: true,
            ...(goalObjectiveText ? { goal_objective: goalObjectiveText } : {}),
          }
        : opts.goalMode === false
          ? { goal_mode: false, user_stopped: true }
          : {};

    // Expert from toolbar picker (no @ required) or inline @mention token.
    const selectedCandidate = selectedMentionRef.current || selectedMention;
    const resolvedMention =
      selectedCandidate
        || resolveMentionedTarget(displayText, mentionTargets);

    // Structured engagement from expert binding (or explicit opts).
    const eng =
      String(opts.engagement || "").trim() ||
      (resolvedMention?.kind === "expert" ? String(resolvedMention.packId || "").trim() : "");
    // Spec #284 G6: product Graph on wire only for pentest seat (pack), never template-as-pack.
    const launchIsPentest =
      isPentestMentionTarget(resolvedMention) || eng.toLowerCase() === "pentest";
    const engTemplateWire = composerEngagementWireFields(opts.engagementTemplate, {
      isPentest: launchIsPentest,
      allowPostex: typeof opts.allowPostex === "boolean" ? opts.allowPostex : undefined,
    });
    const engagementPayload: Record<string, unknown> = {
      ...(eng ? { engagement: eng, role: eng } : {}),
      ...engTemplateWire,
    };
    const expertId =
      String(opts.expertId || "").trim() ||
      (resolvedMention?.kind === "expert" ? String(resolvedMention.expertId || "").trim() : "");
    const expertPayload = expertId ? { expert_id: expertId } : {};

    const targetValue = opts.target?.value || extractTarget(text);
    const restartRequested = isRestartRequest(text);
    const completedConversation = isConversationComplete(activeId, conversations, planTree);
    const explicitConv = Boolean(opts.conversationId);
    const startFresh = Boolean(
      opts.forceNewConversation || (!explicitConv && activeId && restartRequested),
    );

    let convId = opts.conversationId || (startFresh ? null : activeId);
    if (!convId) {
      try {
        const data = await authFetch<Conversation>("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        convId = data.id;
        // Pin as already-open so route effect does not re-load and wipe optimistic rows.
        caseRouteLoadedRef.current = convId;
        setActiveId(convId);
        localStorage.setItem(ACTIVE_CONVERSATION_KEY, convId);
        send({ type: "subscribe", conversation_id: convId });
        if (startFresh) resetConversationState();
        if (location.pathname !== casePath(convId)) {
          navigate(casePath(convId), { replace: true });
        }
        void fetchAll();
      } catch {
        return;
      }
    } else if (explicitConv) {
      caseRouteLoadedRef.current = convId;
      setActiveId(convId);
      localStorage.setItem(ACTIVE_CONVERSATION_KEY, convId);
      send({ type: "subscribe", conversation_id: convId });
      if (location.pathname !== casePath(convId)) {
        navigate(casePath(convId), { replace: true });
      }
      void fetchAll();
    }

    const clientMessageId = crypto.randomUUID();
    const userContent: Record<string, unknown> = { text: displayText, client_message_id: clientMessageId };

    // Route: only 专家管理 experts. Pack id on expert → Node seat (default built-in or extension).
    const packId = String(
      eng || resolvedMention?.packId || (resolvedMention as { packId?: string } | null)?.packId || "",
    ).trim().toLowerCase();
    const isBuiltinAssistant = packId === "default" || packId === "consult" || packId === "workspace" || !packId;
    let routeNodeId: string | null = resolvedMention?.nodeId || null;
    if (!routeNodeId) {
      const sticky = agentNodeById(
        agentNodes,
        activeConversationNodeId || activeConversation?.node_id || null,
      );
      const workers = agentNodes.filter((n) => n.type !== "platform");
      const pick =
        sticky && sticky.type !== "platform"
          ? sticky
          : workers.find((n) => n.status === "online") || workers[0] || null;
      if (pick) routeNodeId = pick.id;
    }
    const routeExpertId =
      resolvedMention?.kind === "expert"
        ? String(resolvedMention.expertId || opts.expertId || "").trim()
        : String(opts.expertId || "").trim();
    const routeExpertName =
      resolvedMention?.kind === "expert"
        ? String(resolvedMention.name || resolvedMention.label || "").trim()
        : "";
    // Issue 9: display name from chip/label (prefer label when present).
    const routeExpertDisplay =
      resolvedMention?.kind === "expert"
        ? String(resolvedMention.label || resolvedMention.name || "").trim()
        : "";
    const engagement = isBuiltinAssistant ? "default" : (eng || packId || "pentest");

    if (routeNodeId) {
      userContent.agent_node_id = routeNodeId;
      userContent.agent_target = isBuiltinAssistant ? "platform" : "pentest";
    }
    userContent.engagement = engagement;
    userContent.role = engagement;
    if (routeExpertId) userContent.expert_id = routeExpertId;
    if (routeExpertName) userContent.expert_name = routeExpertName;
    if (routeExpertDisplay) userContent.expert_display_name = routeExpertDisplay;

    pendingScrollToBottomRef.current = true;
    shouldStickToBottomRef.current = true;
    const agentPayload: Record<string, unknown> = {
      ...(routeNodeId
        ? {
            agent_node_id: routeNodeId,
            agent_target: isBuiltinAssistant ? "platform" : "pentest",
          }
        : {}),
      engagement,
      role: engagement,
      ...(routeExpertId ? { expert_id: routeExpertId } : {}),
      ...(routeExpertName ? { expert_name: routeExpertName } : {}),
      ...(routeExpertDisplay ? { expert_display_name: routeExpertDisplay } : {}),
    };

    const shouldContinueExisting = Boolean(
      !explicitConv &&
        !startFresh &&
        activeId &&
        !restartRequested &&
        !completedConversation &&
        !opts.forceNewConversation,
    );
    const willSteerDirectly = Boolean(
      shouldContinueExisting && activeConversation?.status === "running",
    );
    // Optimistic user row only — do not write agent_pending into RQ (Spec #276).
    // Working is list-tail chrome until first agent output (or terminal); not a Message.
    setConversationMessageData(convId, (data) => {
      const withoutPending = removeMessageRecords(
        data,
        (record) => recordMessageType(record) === "agent_pending",
      );
      return appendMessageRecord(
        withoutPending,
        messageRecordFromMessage(makeMessage(convId!, "user", "text", userContent)),
      );
    });
    setPendingChrome(
      reducePendingChrome(
        null,
        buildPendingSendSuccessEvent({
          conversationId: convId!,
          // Spec #305: reuse agent speaker attribution for list-tail pending chrome.
          ...(routeExpertId ? { expert_id: routeExpertId } : {}),
          ...(routeExpertName ? { expert_name: routeExpertName } : {}),
          ...(routeExpertDisplay ? { expert_display_name: routeExpertDisplay } : {}),
          agent_source: isBuiltinAssistant ? "default" : "pentest",
        }),
      ),
    );

    // Spec #311 US3: when a Workset item already holds the baton (Goal/system),
    // pass workset_item_id so task_assign refreshes expert(+Graph) annotation.
    const nextWorksetId = currentInProgressWorksetItemId(workset);
    const worksetPayload = nextWorksetId ? { workset_item_id: nextWorksetId } : {};

    const commonPayload = {
      ...agentPayload,
      ...goalPayload,
      ...engagementPayload,
      ...expertPayload,
      ...worksetPayload,
    };

    if (shouldContinueExisting && activeConversation?.status === "running") {
      send({
        type: "user_steer",
        conversation_id: convId,
        text,
        display_text: displayText,
        client_message_id: clientMessageId,
        ...commonPayload,
      });
      return;
    }

    // No authorized target yet (e.g. "你好"): room chat only — still show Working/pending
    // until Node settles. Do not open recon work-surface (no target).
    if (!targetValue) {
      launchOptimisticRef.current = true;
      setRunning(true);
      setInterrupting(false);
      if (convId) patchConversation(convId, { working: true });
      send({
        type: "user_message",
        conversation_id: convId,
        text,
        display_text: displayText,
        client_message_id: clientMessageId,
        ...commonPayload,
      });
      return;
    }

    launchOptimisticRef.current = true;
    setRunning(true);
    setInterrupting(false);
    if (convId) patchConversation(convId, { working: true, status: "running" });
    setPendingWorkflowKind("pentest");
    setAgentState({});
    setProgress(undefined);
    setKanban(undefined);
    const target =
      opts.target ||
      ({ type: targetValue.startsWith("http") ? "url" : "host", value: targetValue } as const);
    const scope = opts.scope || { allow: [target.value], deny: [] };
    send({
      type: "user_message",
      conversation_id: convId,
      text,
      target,
      scope,
      display_text: displayText,
      client_message_id: clientMessageId,
      ...commonPayload,
    });
  }, [
    selectedMention,
    mentionTargets,
    agentNodes,
    productExperts,
    activeId,
    activeConversation,
    conversations,
    planTree,
    resetConversationState,
    send,
    setConversationMessageData,
    activeConversationNodeId,
    fetchAll,
    location.pathname,
    navigate,
    patchConversation,
    workset,
  ]);
  launchTaskMessageRef.current = launchTaskMessage;

  // Handoff from Asset management: open the new Case + prefill draft (no auto-send).
  // User chooses @专家 then clicks 发送 — structured target/scope applied on first send.
  useEffect(() => {
    if (pendingAssetLaunchDoneRef.current) return;
    const raw = sessionStorage.getItem(PENDING_ASSET_TASK_KEY);
    if (!raw) return;

    let draft: {
      text?: string;
      target?: { type: string; value: string };
      scope?: { allow: string[]; deny: string[] };
      conversationId?: string;
      autoSend?: boolean;
    };
    try {
      draft = JSON.parse(raw);
    } catch {
      sessionStorage.removeItem(PENDING_ASSET_TASK_KEY);
      return;
    }

    const text = String(draft.text || "").trim();
    const convId = String(draft.conversationId || localStorage.getItem(ACTIVE_CONVERSATION_KEY) || "").trim();
    if (!text || !convId) {
      sessionStorage.removeItem(PENDING_ASSET_TASK_KEY);
      return;
    }

    // Consume session flag once. URL (`/:id` from AssetPage) is SoT for load;
    // this effect only prefill draft + optional legacy autoSend after load.
    pendingAssetLaunchDoneRef.current = true;
    sessionStorage.removeItem(PENDING_ASSET_TASK_KEY);
    localStorage.setItem(ACTIVE_CONVERSATION_KEY, convId);

    const target = draft.target || null;
    const scope = draft.scope || null;
    const autoSend = draft.autoSend === true;

    pendingAssetTaskRef.current = {
      conversationId: convId,
      text,
      target,
      scope,
    };
    // Prefill composer + optimistic task envelope for Status/Surface seed.
    setInput(text);
    if (target || scope) {
      setTaskContext({
        ...(target ? { target } : {}),
        ...(scope ? { scope } : {}),
      });
    }

    if (location.pathname !== casePath(convId)) {
      navigate(casePath(convId), { replace: true });
    }

    // Legacy path only if autoSend explicitly requested (Asset v2 uses autoSend: false).
    if (autoSend) {
      void (async () => {
        try {
          // Wait until route effect has loaded this Case (or load now if already on URL).
          if (caseRouteLoadedRef.current !== convId) {
            await loadConversationRef.current(convId);
          }
          pendingAssetTaskRef.current = null;
          await launchTaskMessageRef.current({
            displayText: text,
            text,
            target,
            scope,
            forceNewConversation: false,
            conversationId: convId,
          });
        } catch {
          // loadConversation / launch already surface errors; keep composer usable.
        }
      })();
    }
  }, [location.pathname, navigate]);

  const handleSend = useCallback(async (overrideText?: string) => {
    const displayText = (typeof overrideText === "string" ? overrideText : input).trim();
    if (!displayText) return;
    const selectedCandidate = selectedMentionRef.current || selectedMention;
    // Prefer explicit toolbar partner; else parse @token from the message body.
    const resolved = selectedCandidate || resolveMentionedTarget(displayText, mentionTargets);
    const text = stripMentionToken(displayText, resolved?.name || null);
    // Keep selected partner after send so multi-turn stays with the same persona.
    setInput("");
    // Spec #277 §3.3 14a / #312 L9: free-text freezes open cards via user_message only.
    // Platform `_forward_pending_approval_text` consumes all pending approvals, persists
    // decision rows, and unblocks Session — do NOT pre-send user_decision=answered here
    // (that drained pending and let user_message become a parallel task/steer path).
    // Optimistic chrome only: grey cards until platform decision broadcasts arrive.
    if (activeId) {
      const openIds = new Set<string>();
      for (const item of pendingApprovals) {
        const requestId = String(item.request_id || "").trim();
        if (requestId) openIds.add(requestId);
      }
      for (const message of messages) {
        if (message.msg_type !== "confirm_card" && message.msg_type !== "choice_card") continue;
        const requestId = readString(message.content.request_id);
        if (!requestId || approvalDecisionByRequestId[requestId]) continue;
        openIds.add(requestId);
      }
      for (const requestId of openIds) {
        addMessageToConversation(
          activeId,
          makeMessage(activeId, "user", "decision", {
            request_id: requestId,
            decision: "answered",
            text: displayText,
          }),
        );
      }
      if (openIds.size) setPendingApprovals([]);
    }
    const isPentest = isPentestMentionTarget(resolved);
    // Spec #277 / #284 G6: wire once here — launch reuses same template + allowPostex (no double-derive).
    // 不指定 / null → omit; product Graph + pentest seat → engagement_template on user_message.
    const wireTmpl = composerEngagementWireFields(engagementTemplate, { isPentest });
    const tmpl: EngagementTemplateId | "" =
      (wireTmpl.engagement_template as EngagementTemplateId | undefined) || "";
    const tmplAllowPostex =
      typeof wireTmpl.allow_postex === "boolean" ? wireTmpl.allow_postex : undefined;
    // Pentest seat always wires explicit goal_mode true|false (not omit) so sticky
    // Goal-on clears when the UI toggle is off (Grok Goal-off path).
    const enableGoal = isPentest ? goalModeEnabled : undefined;
    // Asset「创建任务」draft: attach structured target/scope on first send after expert pick.
    const pendingAsset = pendingAssetTaskRef.current;
    const usePendingAsset =
      pendingAsset
      && (!activeId || pendingAsset.conversationId === activeId || pendingAsset.conversationId === localStorage.getItem(ACTIVE_CONVERSATION_KEY));
    if (usePendingAsset) {
      pendingAssetTaskRef.current = null;
    }
    await launchTaskMessage({
      displayText,
      text,
      goalMode: enableGoal,
      engagement: resolved?.kind === "expert" ? resolved.packId : undefined,
      ...(usePendingAsset
        ? {
            target: pendingAsset!.target,
            scope: pendingAsset!.scope,
            conversationId: pendingAsset!.conversationId,
          }
        : {}),
      // Pass already-resolved template; launchIsPentest gates allowlist again (seat axis only).
      engagementTemplate: tmpl || undefined,
      allowPostex: tmplAllowPostex,
      expertId: resolved?.kind === "expert" ? resolved.expertId : undefined,
    });
    // Persist Case RoE only when user explicitly selected a Graph Workflow (Spec #277:
    // Free/不指定 mode lives on Participant Session, not by writing Case sticky "free").
    // Same postex boolean as wire (catalog default when omitted).
    if (activeId && isPentest && tmpl) {
      void authFetch(`/api/conversations/${activeId}/case`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          engagement_template: tmpl,
          allow_postex: tmplAllowPostex === true,
        }),
      }).catch(() => {});
    }
  }, [
    input,
    selectedMention,
    mentionTargets,
    launchTaskMessage,
    goalModeEnabled,
    engagementTemplate,
    activeId,
    pendingApprovals,
    messages,
    approvalDecisionByRequestId,
    addMessageToConversation,
  ]);

  const selectExpertFromToolbar = useCallback((key: string) => {
    const selectable = mentionTargets.filter((t) => t.selectable !== false);
    const fallback = selectable[0] || null;
    const found = key ? mentionTargets.find((t) => t.key === key) : null;
    // Spec #299: refuse offline-bound Expert as conversation partner.
    const target = found && found.selectable !== false ? found : fallback;
    selectedMentionRef.current = target;
    setSelectedMention(target);
    // Mode + Goal only apply to pentest experts; reset when leaving that pack.
    if (!isPentestMentionTarget(target)) {
      setGoalModeEnabled(false);
      setModeMenuOpen(false);
      setEngagementTemplate(null);
    }
    // Spec #277: stay on 不指定 (Free) when entering pentest — do not silent-set app_assessment.
  }, [mentionTargets]);

  const activePartner =
    (selectedMention && selectedMention.selectable !== false ? selectedMention : null)
    || mentionTargets.find((t) => t.selectable !== false)
    || null;
  const showPentestControls = isPentestMentionTarget(activePartner);
  // Spec #278: null = 不指定 (user intent rail); actual Session mode is AgentRow badge.
  const activeModeLabel =
    ENGAGEMENT_TEMPLATES.find((t) => t.id === engagementTemplate)?.label
    || ENGAGEMENT_UNSPECIFIED_LABEL;

  // Close partner / mode menus on outside click or Escape.
  useEffect(() => {
    if (!partnerMenuOpen && !modeMenuOpen) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (partnerMenuOpen && partnerMenuRef.current && !partnerMenuRef.current.contains(target)) {
        setPartnerMenuOpen(false);
      }
      if (modeMenuOpen && modeMenuRef.current && !modeMenuRef.current.contains(target)) {
        setModeMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPartnerMenuOpen(false);
        setModeMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [partnerMenuOpen, modeMenuOpen]);


function renderMentionText(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /(@[^\s@]+)/g;
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) parts.push(text.slice(lastIndex, index));
    parts.push(<span key={`${index}-${match[0]}`} className="font-semibold text-status-running">{match[0]}</span>);
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length ? parts : [text];
}
function getMentionState(value: string): MentionState {
  const match = value.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match || match.index === undefined) return null;
  const atOffset = value.slice(match.index).indexOf("@");
  return { start: match.index + atOffset, query: match[1] || "" };
}

function filterMentionTargets(targets: MentionTarget[], query: string): MentionTarget[] {
  const normalized = query.trim().toLowerCase();
  const ordered = [...targets].sort((a, b) => a.name.localeCompare(b.name));
  if (!normalized) return ordered.slice(0, 8);
  return ordered
    .filter(
      (t) =>
        t.name.toLowerCase().includes(normalized) ||
        t.label.toLowerCase().includes(normalized) ||
        (t.packId || "").toLowerCase().includes(normalized) ||
        t.subtitle.toLowerCase().includes(normalized),
    )
    .slice(0, 8);
}

function resolveMentionedTarget(value: string, targets: MentionTarget[]): MentionTarget | null {
  return targets.find((t) => value.includes(`@${t.name}`)) || null;
}

/** Pentest pack experts get mode template + Goal switch; platform / other packs do not. */
/**
 * New-chat partner priority (Spec #299: only online / schedulable seats):
 * 1) expert.is_default from 专家管理 (if online)
 * 2) pack_id === default (通用助理, if online)
 * 3) first online target
 * Never default to an offline-bound Expert.
 */
function pickDefaultMentionTarget(
  targets: MentionTarget[],
  experts: ProductExpert[],
): MentionTarget | null {
  const selectable = targets.filter((t) => t.selectable !== false);
  if (!selectable.length) return null;
  const byId = new Map(experts.map((e) => [e.id, e]));
  const flagged = selectable.find((t) => {
    if (!t.expertId) return false;
    const e = byId.get(t.expertId);
    return Boolean(e?.is_default && e.enabled !== false);
  });
  if (flagged) return flagged;
  const builtin = selectable.find((t) => String(t.packId || "").toLowerCase() === "default");
  if (builtin) return builtin;
  return selectable.find((t) => t.status === "online") || selectable[0] || null;
}

function isPentestMentionTarget(target: MentionTarget | null | undefined): boolean {
  if (!target || target.kind !== "expert") return false;
  const pack = String(target.packId || "").trim().toLowerCase();
  return pack === "pentest" || pack.startsWith("pentest");
}

function stripMentionToken(value: string, name: string | null): string {
  if (!name) return value;
  return value.replace(`@${name}`, "").replace(/\s+/g, " ").trim();
}
function isRestartRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  const englishRestart = /\b(restart|start over|rerun|new task)\b/i.test(normalized);
  const chineseRestartTerms = [
    "\u91cd\u65b0\u5f00\u59cb",
    "\u91cd\u5934\u5f00\u59cb",
    "\u91cd\u65b0\u6d4b\u8bd5",
    "\u91cd\u8dd1",
    "\u65b0\u4efb\u52a1",
    "\u6362\u76ee\u6807",
  ];
  return englishRestart || chineseRestartTerms.some(term => normalized.includes(term));
}

function isConversationComplete(activeId: string | null, conversations: Conversation[], planTree: PlanNode[]): boolean {
  const conversation = conversations.find(c => c.id === activeId);
  if (conversation?.status === "completed") return true;
  const phaseNodes = planTree.filter(node => node.level === "phase" || node.kind === "phase");
  return phaseNodes.length > 0 && phaseNodes.every(node => node.status === "done");
}

function agentNodeById(nodes: AgentNode[], nodeId: string | null): AgentNode | null {
  if (!nodeId) return null;
  return nodes.find(node => node.id === nodeId) || null;
}

function agentTargetForNode(node: AgentNode): AgentIdentity | undefined {
  if (node.type === "platform") return "platform";
  if (node.type === "pentest") return "pentest";
  return undefined;
}
  function extractTarget(t: string): string | null {
    const url = t.match(/https?:\/\/\S+/);
    if (url) return url[0];
    const ip = t.match(/\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/);
    return ip ? ip[0] : null;
  }

  const fetchOlderMessages = useCallback(() => {
    const el = messageScrollerRef.current;
    if (!el || !messageQuery.hasNextPage || messageQuery.isFetchingNextPage) return;
    pendingScrollRestoreRef.current = { top: el.scrollTop, height: el.scrollHeight };
    void messageQuery.fetchNextPage();
  }, [messageQuery]);

  const handleMessageScroll = useCallback(() => {
    const el = messageScrollerRef.current;
    if (!el) return;
    shouldStickToBottomRef.current = isNearMessageBottom();
    if (el.scrollTop > 96) return;
    fetchOlderMessages();
  }, [fetchOlderMessages, isNearMessageBottom]);

  useEffect(() => {
    const pending = pendingScrollRestoreRef.current;
    const el = messageScrollerRef.current;
    if (!pending || !el || messageQuery.isFetchingNextPage) return;
    el.scrollTop = el.scrollHeight - pending.height + pending.top;
    pendingScrollRestoreRef.current = null;
  }, [messages.length, messageQuery.isFetchingNextPage]);

  useEffect(() => {
    if (!activeId || messageQuery.isFetchingNextPage || pendingScrollRestoreRef.current) return;
    if (pendingScrollToBottomRef.current) {
      pendingScrollToBottomRef.current = false;
      shouldStickToBottomRef.current = true;
      scrollMessagesToBottom("auto");
      return;
    }
    if (shouldStickToBottomRef.current) scrollMessagesToBottom("auto");
  }, [activeId, messages, messageQuery.isFetchingNextPage, scrollMessagesToBottom]);

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <Sidebar activeId={activeId} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          title={activeId ? conversations?.find(c => c.id === activeId)?.title : undefined}
          conversationId={activeId}
          actions={
            rightPanelAvailable ? (
              <button
                type="button"
                data-testid="right-panel-toggle"
                onClick={toggleRightPanel}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-canvas-inset hover:text-ink"
                title={rightPanelOpen ? "折叠状态面板" : "展开状态面板"}
                aria-label={rightPanelOpen ? "折叠状态面板" : "展开状态面板"}
                aria-pressed={rightPanelOpen}
              >
                {rightPanelOpen ? (
                  <PanelRightClose size={16} strokeWidth={1.75} />
                ) : (
                  <PanelRight size={16} strokeWidth={1.75} />
                )}
              </button>
            ) : null
          }
        />
        <div className="flex min-w-0 flex-1 overflow-hidden">
          <main data-testid="conversation-main" data-active-conversation-id={activeId || ""} className={`flex min-w-0 flex-1 flex-col ${rightPanelOpen ? "border-r border-hairline-soft" : ""}`}>
            <div ref={messageScrollerRef} onScroll={handleMessageScroll} className="min-w-0 flex-1 overflow-y-auto px-9 py-4 space-y-4">
              {messages.length === 0 && !activeId && (
                <div className="flex h-full items-center justify-center">
                  <div className="max-w-md text-center">
                    <h2 className="text-xl font-semibold">Start a new pentest</h2>
                    <p className="mt-2 text-sm text-ink-secondary">Enter a target below and the Agent will start working.</p>
                    <div className="mt-5 flex items-center justify-center gap-3">
                      <input
                        ref={importFileInputRef}
                        type="file"
                        accept=".tar.gz,.tgz,application/gzip,application/x-gzip"
                        className="hidden"
                        onChange={(event) => { void handleImportReport(event.target.files?.[0] || null); }}
                      />
                      <button
                        type="button"
                        disabled={importingReport}
                        onClick={() => importFileInputRef.current?.click()}
                        className="inline-flex items-center gap-2 rounded-pill border border-hairline px-4 py-2 text-sm font-medium text-ink-secondary transition-colors hover:bg-surface-default hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <Upload className="h-4 w-4" />
                        {importingReport ? "Importing..." : "Import conversation"}
                      </button>
                    </div>
                    {importStatus && (
                      <p className={`mt-3 text-xs ${importStatus.level === "error" ? "text-severity-critical" : importStatus.level === "success" ? "text-severity-low" : "text-ink-muted"}`}>
                        {importStatus.text}
                      </p>
                    )}
                  </div>
                </div>
              )}
              {messages.length === 0 && activeId && (
                <div className="flex h-full items-center justify-center">
                  <div className="text-center">
                    <h2 className="text-xl font-semibold">No messages yet</h2>
                    <p className="mt-2 text-sm text-ink-secondary">This conversation is selected, but no history is available yet.</p>
                  </div>
                </div>
              )}
              {messageQuery.isFetchingNextPage && <div className="py-2 text-center text-xs text-ink-muted">Loading older messages...</div>}
              {messageQuery.hasNextPage && !messageQuery.isFetchingNextPage && <button type="button" onClick={fetchOlderMessages} className="mx-auto block rounded-pill border border-hairline px-3 py-1.5 text-xs text-ink-secondary">Load older messages</button>}
              {streamChromeItems.map((item, index) => {
                if (item.kind === "time_separator" || item.kind === "day_separator") {
                  const stampKey =
                    item.kind === "time_separator" ? item.stampKey : item.dayKey;
                  return (
                    <div
                      key={`time-${stampKey}-${index}`}
                      role="separator"
                      data-chat-message-time={item.label}
                      data-chat-day-separator={stampKey}
                      className="my-3 flex items-center justify-center"
                    >
                      <span className="rounded-full bg-surface-default px-3 py-0.5 font-mono text-[11px] tabular-nums text-ink-muted">
                        {item.label}
                      </span>
                    </div>
                  );
                }
                const msg = item.message;
                const prevMsg = (() => {
                  for (let i = index - 1; i >= 0; i--) {
                    const prev = streamChromeItems[i];
                    if (prev.kind === "message") return prev.message;
                  }
                  return undefined;
                })();
                return (
                  <div key={messageListKey(msg)} data-message-created-at={msg.created_at}>
                    <MessageRenderer
                      message={msg}
                      previousMessage={prevMsg}
                      agentNameById={agentNameById}
                      fallbackPentestNodeId={fallbackPentestNodeId}
                      platformAgentNodeId={platformAgentNodeId}
                      onDecision={handleDecision}
                      onConfirmOptions={handleConfirmOptions}
                      onOpenVulnerability={setSelectedVulnerability}
                      onOpenAsset={setSelectedAsset}
                      onOpenEvidence={setSelectedEvidence}
                      highlightedApprovalId={highlightedApprovalId}
                      approvalDecisionByRequestId={approvalDecisionByRequestId}
                      choiceSelectedByRequestId={choiceSelectedByRequestId}
                      sessionActive={isActiveConversationRunning}
                      choiceDisabled={
                        interrupting || ((running || Boolean(activeConversation?.working)) && !hasOpenInteractiveChoice)
                      }
                      resultAnchorWorkSeconds={resultAnchorSecondsByMessageId[msg.id]}
                    />
                  </div>
                );
              })}
              {/* Spec #276: pending is chrome only — not a Message / live-slot row.
                  Spec #305: same speaker row rules as MessageRenderer (first / expert switch only). */}
              {showPendingChrome && pendingChrome && (() => {
                const pendingContent = pendingChromeSpeakerContent(pendingChrome);
                const lastAgent = [...displayMessages].reverse().find((m) => m.role === "agent");
                const showSpeaker = shouldShowAgentSpeakerLabel(
                  pendingContent,
                  lastAgent?.content,
                  agentNameById,
                  fallbackPentestNodeId,
                  platformAgentNodeId,
                );
                const speakerLabel = agentDisplayName(
                  pendingContent,
                  agentNameById,
                  fallbackPentestNodeId,
                  platformAgentNodeId,
                );
                return (
                  <div key="pending-chrome" data-testid="pending-chrome">
                    {showSpeaker && (
                      <div
                        className="mb-1 flex items-center gap-2 text-xs text-ink-muted"
                        data-testid="pending-chrome-speaker"
                      >
                        <span className="font-medium text-ink-secondary">{speakerLabel}</span>
                      </div>
                    )}
                    <AgentPendingCard content={{ text: pendingChrome.label }} />
                  </div>
                );
              })()}
              {/* Spec #312 L10: mechanical WorksetChoiceBar retired — next_steps ChoiceCard in stream. */}
            </div>
            <div className="px-6 pt-4 pb-4">
              {/* Agent-style composer: partner chip → (pentest: mode + Goal) → send */}
              <div className="relative rounded-2xl border border-hairline bg-canvas shadow-[0_1px_2px_rgba(0,0,0,0.04)] focus-within:border-ink/40 focus-within:shadow-[0_2px_8px_rgba(0,0,0,0.06)]">
                {mentionState && mentionOptions.length > 0 && (
                  <div className="absolute bottom-full left-0 z-20 mb-2 w-80 overflow-hidden rounded-xl border border-hairline bg-canvas shadow-lg">
                    {mentionOptions.map((target) => {
                      const accent = target.color || resolveExpertColor(null, target.expertId || target.key);
                      const disabled = target.selectable === false;
                      return (
                      <button
                        key={target.key}
                        type="button"
                        disabled={disabled}
                        title={disabled ? "绑定节点离线，不可调度" : undefined}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          if (disabled) return;
                          chooseMention(target);
                        }}
                        className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors ${
                          disabled
                            ? "cursor-not-allowed opacity-45"
                            : "hover:bg-surface-default"
                        }`}
                      >
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: accent }}
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-ink">
                            {target.label || target.name}
                          </span>
                          <span className="block truncate text-[11px] text-ink-muted">
                            {target.subtitle || target.label}
                          </span>
                        </span>
                        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-ink-muted">
                          {disabled
                            ? "不可调度"
                            : target.status === "online"
                              ? "Online"
                              : target.status === "offline"
                                ? "Offline"
                                : expertLabel(target.packId)}
                        </span>
                      </button>
                      );
                    })}
                  </div>
                )}
                <div className="relative min-w-0">
                  {input && (
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-4 py-3.5 text-sm leading-5 text-ink"
                    >
                      {renderMentionText(input)}
                    </div>
                  )}
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void handleSend();
                      }
                    }}
                    rows={3}
                    placeholder={
                      activePartner
                        ? `向 ${activePartner.label || activePartner.name} 描述任务…（Shift+Enter 换行）`
                        : "请先在专家管理创建专家，或从下方选择对话对象…"
                    }
                    className="relative z-10 min-h-[4.75rem] w-full resize-none bg-transparent px-4 py-3.5 text-sm leading-5 text-transparent caret-ink placeholder:text-ink-muted focus:outline-none"
                  />
                </div>
                <div className="flex min-w-0 items-center justify-between gap-2 px-2.5 py-2">
                  {/* Shared chip height: h-8 (32px) for partner / mode / Goal / send */}
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                    {/* Partner chip + custom menu */}
                    <div ref={partnerMenuRef} className="relative">
                      <button
                        type="button"
                        aria-haspopup="listbox"
                        aria-expanded={partnerMenuOpen}
                        title="选择对话对象"
                        onClick={() => {
                          setPartnerMenuOpen((open) => !open);
                          setModeMenuOpen(false);
                        }}
                        className={`inline-flex h-8 max-w-[13rem] items-center gap-1.5 rounded-full pl-2 pr-2 text-xs leading-none text-ink transition-colors ${
                          partnerMenuOpen ? "bg-surface-elevated ring-1 ring-hairline" : "bg-canvas-inset hover:bg-surface-elevated"
                        }`}
                      >
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{
                            backgroundColor:
                              activePartner?.color ||
                              resolveExpertColor(null, activePartner?.expertId || activePartner?.key || "none"),
                          }}
                          aria-hidden
                        />
                        <span className="min-w-0 truncate font-medium leading-none">
                          {activePartner?.label || activePartner?.name || "选择专家"}
                        </span>
                        <ChevronDown
                          size={12}
                          className={`shrink-0 text-ink-muted transition-transform ${partnerMenuOpen ? "rotate-180" : ""}`}
                        />
                      </button>
                      {partnerMenuOpen && (
                        <div
                          role="listbox"
                          aria-label="对话对象"
                          className="absolute bottom-full left-0 z-30 mb-2 w-72 overflow-hidden rounded-xl border border-hairline bg-canvas py-1 shadow-[0_8px_30px_rgba(0,0,0,0.08)]"
                        >
                          <p className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-ink-muted">
                            对话对象
                          </p>
                          {mentionTargets.map((t) => {
                            const selected = t.key === activePartner?.key;
                            const disabled = t.selectable === false;
                            const statusLabel = disabled
                              ? "不可调度"
                              : t.status === "online"
                                ? "在线"
                                : t.status === "offline"
                                  ? "离线"
                                  : expertLabel(t.packId);
                            const accent = t.color || resolveExpertColor(null, t.expertId || t.key);
                            return (
                              <button
                                key={t.key}
                                type="button"
                                role="option"
                                aria-selected={selected}
                                aria-disabled={disabled}
                                disabled={disabled}
                                title={disabled ? "绑定节点离线，不可调度" : undefined}
                                onClick={() => {
                                  if (disabled) return;
                                  selectExpertFromToolbar(t.key);
                                  setPartnerMenuOpen(false);
                                }}
                                className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors ${
                                  disabled
                                    ? "cursor-not-allowed opacity-45"
                                    : selected
                                      ? "bg-surface-elevated"
                                      : "hover:bg-surface-default"
                                }`}
                              >
                                <span
                                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                                  style={{ backgroundColor: accent }}
                                  aria-hidden
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="flex items-center gap-1.5">
                                    <span className="truncate text-sm font-medium text-ink">
                                      {t.label || t.name}
                                    </span>
                                    {t.status === "online" && !disabled && (
                                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-success" />
                                    )}
                                  </span>
                                  <span className="mt-0.5 block truncate text-[11px] text-ink-muted">
                                    {t.subtitle || statusLabel}
                                  </span>
                                </span>
                                {selected && !disabled ? (
                                  <Check size={14} className="shrink-0 text-ink" strokeWidth={2.25} />
                                ) : (
                                  <span className="shrink-0 text-[10px] font-medium text-ink-muted">
                                    {statusLabel}
                                  </span>
                                )}
                              </button>
                            );
                          })}
                          {mentionTargets.length === 0 && (
                            <p className="px-3 py-3 text-xs text-ink-muted">暂无可用对象</p>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Mode chip — pentest only */}
                    {showPentestControls && (
                      <div ref={modeMenuRef} className="relative">
                        <button
                          type="button"
                          aria-haspopup="listbox"
                          aria-expanded={modeMenuOpen}
                          title="工作流偏好（用户意图；AgentRow 显示 Session 实际模式）"
                          onClick={() => {
                            setModeMenuOpen((open) => !open);
                            setPartnerMenuOpen(false);
                          }}
                          className={`inline-flex h-8 max-w-[11rem] items-center gap-1.5 rounded-full pl-2.5 pr-2 text-xs leading-none text-ink transition-colors ${
                            modeMenuOpen ? "bg-surface-elevated ring-1 ring-hairline" : "bg-canvas-inset hover:bg-surface-elevated"
                          }`}
                        >
                          <Target size={12} className="shrink-0 text-ink-muted" />
                          <span className="min-w-0 truncate font-medium leading-none">{activeModeLabel}</span>
                          <ChevronDown
                            size={12}
                            className={`shrink-0 text-ink-muted transition-transform ${modeMenuOpen ? "rotate-180" : ""}`}
                          />
                        </button>
                        {modeMenuOpen && (
                          <div
                            role="listbox"
                            aria-label="工作流偏好"
                            className="absolute bottom-full left-0 z-30 mb-2 w-64 overflow-hidden rounded-xl border border-hairline bg-canvas py-1 shadow-[0_8px_30px_rgba(0,0,0,0.08)]"
                          >
                            <p className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-ink-muted">
                              工作流偏好
                            </p>
                            {/* Spec #278 A1: 不指定 = no force mode change (omit field on send). */}
                            <button
                              type="button"
                              role="option"
                              aria-selected={engagementTemplate == null}
                              onClick={() => {
                                setEngagementTemplate(null);
                                setModeMenuOpen(false);
                              }}
                              className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors ${
                                engagementTemplate == null ? "bg-surface-elevated" : "hover:bg-surface-default"
                              }`}
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block text-sm font-medium text-ink">
                                  {ENGAGEMENT_UNSPECIFIED_LABEL}
                                </span>
                                <span className="mt-0.5 block text-[11px] leading-snug text-ink-muted">
                                  不强制改模式：已在 Graph 则保持；否则 Free
                                </span>
                              </span>
                              {engagementTemplate == null && (
                                <Check size={14} className="mt-0.5 shrink-0 text-ink" strokeWidth={2.25} />
                              )}
                            </button>
                            {ENGAGEMENT_TEMPLATES.map((t) => {
                              const selected = t.id === engagementTemplate;
                              return (
                                <button
                                  key={t.id}
                                  type="button"
                                  role="option"
                                  aria-selected={selected}
                                  onClick={() => {
                                    setEngagementTemplate(t.id);
                                    setModeMenuOpen(false);
                                  }}
                                  className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors ${
                                    selected ? "bg-surface-elevated" : "hover:bg-surface-default"
                                  }`}
                                >
                                  <span className="min-w-0 flex-1">
                                    <span className="block text-sm font-medium text-ink">{t.label}</span>
                                    <span className="mt-0.5 block text-[11px] leading-snug text-ink-muted">
                                      {t.description}
                                    </span>
                                  </span>
                                  {selected && (
                                    <Check size={14} className="mt-0.5 shrink-0 text-ink" strokeWidth={2.25} />
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Goal toggle chip — pentest only; selected = ink fill */}
                    {showPentestControls && (
                      <button
                        type="button"
                        aria-pressed={goalModeEnabled}
                        aria-label="Goal mode"
                        title={goalModeEnabled ? "Goal 已开启" : "开启 Goal 模式"}
                        onClick={() => setGoalModeEnabled((v) => !v)}
                        className={`inline-flex h-8 items-center rounded-full px-3 text-xs font-medium leading-none transition-colors ${
                          goalModeEnabled
                            ? "bg-ink text-on-ink"
                            : "bg-canvas-inset text-ink-secondary hover:bg-surface-elevated"
                        }`}
                      >
                        Goal
                      </button>
                    )}
                  </div>
                  <div className="flex h-8 shrink-0 items-center gap-2">
                    {/* Spec #325 C1: live work-burst timer near Send; hide on settle. */}
                    {composerTimerText != null && (
                      <span
                        data-testid="composer-work-timer"
                        className="font-mono text-xs tabular-nums text-ink-muted"
                        title={workBurst?.authorize_paused ? "等待授权（不计工作时间）" : "本轮工作时长"}
                      >
                        {composerTimerText}
                      </span>
                    )}
                    {isActiveConversationRunning ? (
                      <button
                        type="button"
                        disabled={interrupting}
                        onClick={() => {
                          if (!activeId || interrupting) return;
                          // Do not clear running optimistically — wait for conversation_working
                          // after all session workers report idle (or platform settles).
                          setInterrupting(true);
                          patchConversation(activeId, { working: true, status: "running" });
                          send({ type: "user_interrupt", conversation_id: activeId, action: "cancel" });
                        }}
                        className="inline-flex h-8 items-center rounded-pill bg-severity-critical px-4 text-xs font-medium leading-none text-white transition-opacity hover:opacity-90 disabled:opacity-70"
                      >
                        {interrupting ? "中断中…" : "中断"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { void handleSend(); }}
                        disabled={!input.trim()}
                        className="inline-flex h-8 items-center rounded-pill bg-ink px-4 text-xs font-medium leading-none text-on-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35"
                      >
                        发送
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </main>
          {rightPanelOpen && (
            <RightPanel
              phase={agentState.phase as string}
              activeTool={agentState.activeTool as string}
              intakeResult={agentState.intakeResult as Record<string, unknown> | undefined}
              intakeStatus={agentState.intakeStatus as string | undefined}
              progress={progress}
              kanban={kanban}
              workflowKind={activeWorkflowKind}
              running={isActiveConversationRunning}
              planTree={planTree}
              taskMapRevisions={taskMapRevisions}
              liveRevisionId={liveRevisionId}
              viewedRevisionId={viewedRevisionId}
              onSelectTaskMapRevision={(id) => setViewedRevisionId(id)}
              onReturnToLiveTaskMap={() => setViewedRevisionId(liveRevisionId)}
              strixAgents={applyDisplayNameOverrides(strixAgents, workerDisplayNames)}
              strixNotes={strixNotes}
              strixRun={strixRun}
              caseRun={caseRun}
              trafficExchanges={trafficExchanges}
              surfaceLedger={surfaceLedger}
              findings={findings}
              assets={assets}
              taskContext={taskContext}
              engagementCloseout={engagementCloseout}
              conversationId={activeId}
              packageStatus={
                conversations.find((c) => c.id === activeId)?.status ||
                (isActiveConversationRunning ? "running" : null)
              }
              packageWorking={
                Boolean(conversations.find((c) => c.id === activeId)?.working) ||
                isActiveConversationRunning
              }
              packageExpertId={
                String(
                  (taskContext as { expert_id?: string } | undefined)?.expert_id ||
                    selectedMention?.expertId ||
                    "",
                ).trim() || null
              }
              pendingHandoffExpertIds={pendingHandoffExpertIds}
              onSessionLifecycleDone={() => {
                // Spec #354: Session Delete mid-run must flip Navbar light + interrupt → send.
                if (!activeId) return;
                setRunning(false);
                setInterrupting(false);
                launchOptimisticRef.current = false;
                patchConversation(activeId, { working: false, status: "incomplete" });
                clearProgressiveStreamUi();
                void refreshConversationState(activeId);
              }}
              onOpenVulnerability={setSelectedVulnerability}
              onOpenAsset={setSelectedAsset}
              onWorkerClick={(agent, workerOrdinal) => {
                // Prefer bare sub_* id for Case frames (panel may use root-prefixed ids).
                const rawId = String(agent.id || "").trim();
                const bare = rawId.includes("-") ? rawId.split("-").slice(-1)[0] : rawId;
                setWorkerAuditTarget({
                  agentId: bare || rawId,
                  panelName: agent.name,
                  workerOrdinal,
                });
              }}
            />
          )}
        </div>
      </div>
      <WorkerAuditDialog
        open={Boolean(workerAuditTarget)}
        agentId={workerAuditTarget?.agentId || ""}
        panelName={workerAuditTarget?.panelName}
        workerOrdinal={workerAuditTarget?.workerOrdinal}
        overrides={workerDisplayNames}
        messages={messages}
        onClose={() => setWorkerAuditTarget(null)}
        onRename={async (agentId, displayName) => {
          if (!activeId) return;
          const res = await authFetch<{
            ok?: boolean;
            display_name?: string | null;
            worker_display_names?: Record<string, string>;
          }>(`/api/conversations/${activeId}/workers/${encodeURIComponent(agentId)}/display-name`, {
            method: "PUT",
            body: JSON.stringify({ display_name: displayName }),
          });
          if (res.worker_display_names && typeof res.worker_display_names === "object") {
            const next: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.worker_display_names)) {
              const name = String(v || "").trim();
              if (k && name) next[k] = name;
            }
            setWorkerDisplayNames(next);
          } else {
            setWorkerDisplayNames((prev) => {
              const next = { ...prev };
              if (!displayName) delete next[agentId];
              else next[agentId] = displayName;
              return next;
            });
          }
        }}
      />
      <VulnDetailDialog
        open={Boolean(selectedVulnerability)}
        vulnerabilityId={selectedVulnerability?.vulnerability_id as string | undefined}
        initial={selectedVulnerability}
        sessionName={activeId ? conversations?.find((c) => c.id === activeId)?.title : undefined}
        onClose={() => setSelectedVulnerability(null)}
        onUpdated={(updated) => setFindings(prev => upsertBy(prev, updated as unknown as Record<string, unknown>, "id"))}
        onRetestCreated={(conversationId) => { void fetchAll(); void loadConversation(conversationId); }}
        onOpenEvidence={setSelectedEvidence}
      />
      <EvidenceDetailDialog
        open={Boolean(selectedEvidence)}
        evidenceId={(selectedEvidence?.evidence_id || selectedEvidence?.id) as string | undefined}
        initial={selectedEvidence}
        onClose={() => setSelectedEvidence(null)}
      />
      <AssetDetailDialog
        open={Boolean(selectedAsset)}
        assetId={(selectedAsset?.id || selectedAsset?.asset_id) as string | undefined}
        initial={selectedAsset as Parameters<typeof AssetDetailDialog>[0]["initial"]}
        onClose={() => setSelectedAsset(null)}
      />
    </div>
  );
}

async function fetchConversationMessagesPage(conversationId: string, offset: number): Promise<Array<Record<string, unknown>>> {
  return authFetch<Array<Record<string, unknown>>>(`/api/conversations/${conversationId}/messages?limit=${MESSAGE_PAGE_SIZE}&offset=${offset}&order=desc`);
}

function messagesFromQueryData(conversationId: string | null, data: MessagesInfiniteData | undefined): Message[] {
  if (!conversationId || !data?.pages) return [];
  return [...data.pages].reverse().flat().map(normalizeMessage(conversationId));
}

function normalizeMessage(conversationId: string) {
  return (m: MessageRecord): Message => {
    const msgType = String(m.msg_type || "text");
    const content = { ...((m.content || {}) as Record<string, unknown>) };
    content.message_id = String(m.id || content.message_id || "");
    // Spec #305 R2: do not force tool_call missing status → "running" here.
    // MessageRenderer uses raw status + result hints for 执行中 / success family.
    if (msgType === "tool_call" && content.status != null && content.status !== "") {
      // Keep explicit protocol values as stored (running|done|fail synonyms raw).
      content.status = String(content.status).trim();
    }
    return {
      id: String(m.id || content.message_id || crypto.randomUUID()),
      conversation_id: String(m.conversation_id || conversationId),
      role: m.role as Message["role"],
      msg_type: msgType,
      content,
      parent_msg_id: null,
      created_at: String(m.created_at || new Date().toISOString()),
    };
  };
}

function emptyMessagesData(): MessagesInfiniteData {
  return { pages: [[]], pageParams: [0] };
}

function appendMessageRecord(data: MessagesInfiniteData, record: MessageRecord): MessagesInfiniteData {
  const current = data.pages.length ? data : emptyMessagesData();
  let updatedExisting = false;
  const pages = current.pages.map(page => page.map(existing => {
    if (!shouldUpdateMessageRecord(existing, record)) return existing;
    updatedExisting = true;
    return mergeMessageRecords(existing, record);
  }));

  if (updatedExisting) return { ...current, pages };
  const [firstPage = [], ...restPages] = pages;
  return { ...current, pages: [[...firstPage, record], ...restPages] };
}

function removeMessageRecords(data: MessagesInfiniteData, predicate: (record: MessageRecord) => boolean): MessagesInfiniteData {
  return { ...data, pages: data.pages.map(page => page.filter(record => !predicate(record))) };
}

function shouldUpdateMessageRecord(existing: MessageRecord, incoming: MessageRecord): boolean {
  const existingId = recordMessageId(existing);
  const incomingId = recordMessageId(incoming);
  if (existingId && incomingId && existingId === incomingId) return true;
  // Progressive assistant text/thinking: same stream_id updates one bubble.
  const existingType = recordMessageType(existing);
  const incomingType = recordMessageType(incoming);
  if (
    (existingType === "text" || existingType === "thinking")
    && existingType === incomingType
  ) {
    const existingStream = recordStreamId(existing);
    const incomingStream = recordStreamId(incoming);
    if (existingStream && incomingStream && existingStream === incomingStream) return true;
  }
  return recordMessageType(existing) === "tool_call" && recordMessageType(incoming) === "tool_call" && Boolean(recordToolRunKey(existing)) && recordToolRunKey(existing) === recordToolRunKey(incoming);
}

function mergeMessageRecords(existing: MessageRecord, incoming: MessageRecord): MessageRecord {
  const existingType = recordMessageType(existing);
  const incomingType = recordMessageType(incoming);
  if (
    (existingType === "text" || existingType === "thinking")
    && existingType === incomingType
  ) {
    const existingContent = recordContent(existing);
    const incomingContent = recordContent(incoming);
    const prevText = readString(existingContent.text) || readString(existingContent.reasoning);
    const nextText = readString(incomingContent.text) || readString(incomingContent.reasoning);
    // Stream frames carry cumulative full text. Prefer monotonic growth / prefix
    // relationship — never concatenate (that caused "好的好的" style doubles).
    let text = nextText;
    if (!nextText) text = prevText;
    else if (!prevText) text = nextText;
    else if (nextText.startsWith(prevText) || prevText.startsWith(nextText)) {
      text = nextText.length >= prevText.length ? nextText : prevText;
    } else if (nextText.length >= prevText.length) {
      text = nextText;
    } else {
      text = prevText;
    }
    const mergedStatus =
      existingType === "thinking"
        ? mergeThinkingStatus(existingContent.status, incomingContent.status)
        : incomingContent.status ?? existingContent.status;
    return {
      ...existing,
      ...incoming,
      id: recordMessageId(existing) || recordMessageId(incoming),
      content: {
        ...existingContent,
        ...incomingContent,
        text,
        ...(existingType === "thinking" ? { reasoning: text } : {}),
        ...(mergedStatus !== undefined ? { status: mergedStatus } : {}),
        stream_id: incomingContent.stream_id || existingContent.stream_id,
        message_id: existingContent.message_id || incomingContent.message_id,
      },
      created_at: existing.created_at || incoming.created_at,
    };
  }
  if (existingType !== "tool_call" || incomingType !== "tool_call") return incoming;
  const existingContent = recordContent(existing);
  const incomingContent = recordContent(incoming);
  const mergedStatus = mergeToolLifecycleStatus(existingContent.status, incomingContent.status);
  return {
    ...existing,
    ...incoming,
    content: {
      ...existingContent,
      ...incomingContent,
      command: incomingContent.command || existingContent.command || "",
      stdout: appendStdout(readString(existingContent.stdout), readString(incomingContent.stdout)),
      // Prefer done over running; keep empty when both missing (result-hint path).
      ...(mergedStatus ? { status: mergedStatus } : { status: "" }),
    },
    created_at: incoming.created_at || existing.created_at,
  };
}

function messageRecordFromMessage(message: Message): MessageRecord {
  const content = { ...message.content };
  if (!content.message_id) content.message_id = message.id;
  return {
    id: message.id,
    conversation_id: message.conversation_id,
    role: message.role,
    msg_type: message.msg_type,
    content,
    created_at: message.created_at,
  };
}

function recordContent(record: MessageRecord): Record<string, unknown> {
  return ((record.content || {}) as Record<string, unknown>);
}

function recordMessageType(record: MessageRecord): string {
  return String(record.msg_type || "text");
}

function recordMessageId(record: MessageRecord): string {
  return readString(record.id) || readString(recordContent(record).message_id);
}

function recordToolRunKey(record: MessageRecord): string {
  return readString(recordContent(record).tool_run_id);
}

function recordStreamId(record: MessageRecord): string {
  return readString(recordContent(record).stream_id);
}

function appendStdout(current: string, incoming: string): string {
  if (!incoming) return current;
  if (!current) return incoming;
  if (current.endsWith(incoming)) return current;
  return `${current}${current.endsWith("\n") ? "" : "\n"}${incoming}`;
}

function isRenderableMessage(message: Message): boolean {
  // Spec #312: only structured confirm_options decisions are visible bubbles.
  if (message.role === "user" && message.msg_type === "decision") {
    return readString(message.content.decision) === "confirm_options";
  }
  if (message.msg_type === "tool_call") return true;
  // Spec #326 L9: drop infra status (tooling_health-class) from the stream list entirely.
  if (
    message.role === "system" ||
    message.msg_type === "status" ||
    message.msg_type === "engagement_closeout"
  ) {
    return shouldRenderStatusNotice(message);
  }
  if (["text", "confirm_card", "choice_card", "vuln_card", "vuln_found", "asset_card", "asset_discovered", "agent_pending", "thinking", "reasoning", "agent_thinking"].includes(message.msg_type)) return true;
  return false;
}
function groupConsecutiveToolMessages(messages: Message[]): Message[] {
  const grouped: Message[] = [];
  for (const message of messages) {
    const previous = last(grouped);
    if (!previous || !canGroupToolMessages(previous, message)) {
      grouped.push(message);
      continue;
    }
    grouped[grouped.length - 1] = mergeConsecutiveToolMessage(previous, message);
  }
  return grouped;
}

function canGroupToolMessages(previous: Message, incoming: Message): boolean {
  if (previous.role !== "agent" || incoming.role !== "agent") return false;
  if (previous.msg_type !== "tool_call" || incoming.msg_type !== "tool_call") return false;
  const previousTool = readString(previous.content.latest_tool_name) || readString(previous.content.tool_name);
  const incomingTool = readString(incoming.content.tool_name);
  if (!previousTool || previousTool !== incomingTool) return false;
  return readString(previous.content.agent_source) === readString(incoming.content.agent_source)
    && readString(previous.content.agent_node_id) === readString(incoming.content.agent_node_id);
}

function mergeConsecutiveToolMessage(previous: Message, incoming: Message): Message {
  const previousRunIds = toolRunIds(previous);
  const incomingRunId = readString(incoming.content.tool_run_id) || incoming.id;
  const tool_run_ids = previousRunIds.includes(incomingRunId) ? previousRunIds : [...previousRunIds, incomingRunId];
  const tool_names = uniqueMessageStrings([...toolNames(previous), readString(incoming.content.tool_name)]);
  const tool_items = [...toolItems(previous), toolItemForMessage(incoming)];
  return {
    ...previous,
    content: {
      ...previous.content,
      ...incoming.content,
      tool_name: tool_names[0] || previous.content.tool_name || incoming.content.tool_name,
      latest_tool_name: incoming.content.tool_name || previous.content.latest_tool_name || previous.content.tool_name,
      tool_names,
      tool_items,
      tool_run_id: previous.content.tool_run_id || incoming.content.tool_run_id,
      tool_run_ids,
      run_count: tool_run_ids.length,
      command: mergeGroupedCommands(readString(previous.content.command), readString(incoming.content.command)),
      stdout: appendGroupedStdout(readString(previous.content.stdout), readString(incoming.content.stdout)),
      status: mergeGroupedToolStatus(readString(previous.content.status), readString(incoming.content.status)),
    },
    created_at: incoming.created_at || previous.created_at,
  };
}

function toolItems(message: Message): Array<Record<string, unknown>> {
  const existing = message.content.tool_items;
  if (Array.isArray(existing)) return existing.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  return [toolItemForMessage(message)];
}

function toolItemForMessage(message: Message): Record<string, unknown> {
  return {
    tool_name: message.content.tool_name,
    tool_run_id: message.content.tool_run_id,
    status: message.content.status,
    stdout: message.content.stdout,
    command: message.content.command,
    evidence_id: message.content.evidence_id,
    summary: message.content.summary,
    display_title: message.content.display_title,
    category: message.content.category,
    target: message.content.target,
    args: message.content.args,
    result: message.content.result,
    result_text: message.content.result_text,
  };
}
function toolNames(message: Message): string[] {
  const existing = message.content.tool_names;
  if (Array.isArray(existing)) return existing.map(item => String(item)).filter(Boolean);
  return [readString(message.content.tool_name)].filter(Boolean);
}

function uniqueMessageStrings(values: string[]): string[] {
  return Array.from(new Set(values.map(value => String(value || "").trim()).filter(Boolean)));
}
function toolRunIds(message: Message): string[] {
  const existing = message.content.tool_run_ids;
  if (Array.isArray(existing)) return existing.map(item => String(item)).filter(Boolean);
  return [readString(message.content.tool_run_id) || message.id].filter(Boolean);
}

function mergeGroupedCommands(previous: string, incoming: string): string {
  if (!incoming || previous === incoming) return previous;
  if (!previous) return incoming;
  return `${previous}\n${incoming}`;
}

function appendGroupedStdout(current: string, incoming: string): string {
  if (!incoming) return current;
  if (!current) return incoming;
  if (current.includes(incoming)) return current;
  return `${current}${current.endsWith("\n") ? "\n" : "\n\n"}${incoming}`;
}

function mergeGroupedToolStatus(previous: string, incoming: string): string {
  // Spec #305 R2: prefer fail/done over running; do not invent done/running from empty.
  return mergeToolLifecycleStatus(previous, incoming);
}
function snapshotFromMessages(messages: Message[], status: Conversation["status"] | "running" | string): ConversationSnapshot {
  const normalizedStatus = String(status || "created") as Conversation["status"];
  const statusMessages = messages.filter(m => m.msg_type === "status" && typeof m.content === "object");
  const lastStatus = last(statusMessages)?.content || {};
  const phase = readString(lastStatus.phase) || parsePhase(readString(lastStatus.text)) || (normalizedStatus === "completed" ? "complete" : normalizedStatus === "running" ? "intake" : undefined);
  const lastTool = last(messages.filter(m => m.msg_type === "tool_call" && readString(m.content.tool_name)));
  const activeTool = readString(lastStatus.active_tool) || readString(lastTool?.content.tool_name);
  const decisions = new Set(messages.filter(m => m.msg_type === "decision").map(m => readString(m.content.request_id)).filter(Boolean));
  const pending = messages
    .filter(
      (m) =>
        (m.msg_type === "confirm_card" || m.msg_type === "choice_card") &&
        readString(m.content.request_id) &&
        !decisions.has(readString(m.content.request_id)),
    )
    .map((m) => ({ ...m.content, message_id: m.id }));
  // Spec #280 Wave1: chat archaeology must not feed Case Findings / Evidence.
  // Snapshot API + post-persist WS remain SoT; empty is correct when nothing booked.
  const assets = messages
    .filter(m => m.msg_type === "asset_card" || m.msg_type === "asset_discovered")
    .map(m => ({ ...m.content, id: readString(m.content.id) || readString(m.content.asset_id) || m.id, address: m.content.address || m.content.name || "" }));

  return {
    conversation: { id: messages[0]?.conversation_id || "", title: "", node_id: null, status: normalizedStatus, created_at: "", last_active_at: "" },
    agent_state: {
      phase,
      iteration: lastStatus.iteration,
      activeTool,
      intakeResult: lastStatus.intake_result,
      intakeStatus: lastStatus.status,
    },
    progress: progressForPhase(phase, normalizedStatus),
    // Tasks SoT = plan_tree_updated / Graph plan / checkpoint todos — never invent
    // pentest phase shells from status.phase (painted Default assistant chat as Graph).
    plan_tree: [],
    findings: [],
    assets,
    pending_approvals: pending,
    evidence: [],
  };
}

function last<T>(items: T[]): T | undefined {
  return items.length ? items[items.length - 1] : undefined;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isProgress(value: unknown): value is Progress {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.current === "number" && typeof item.total === "number" && typeof item.percent === "number";
}

function isKanbanSummary(value: unknown): value is KanbanSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.totals === "object" || Array.isArray(item.buckets);
}

function isStrixNote(value: unknown): value is StrixNote {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && readString((value as Record<string, unknown>).id));
}

function isStrixRun(value: unknown): value is StrixRun {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** True when a run payload has something the right panel can actually display. */
function hasStrixRunSummary(run: StrixRun | undefined | null): boolean {
  if (!run || typeof run !== "object") return false;
  const usage = run.llm_usage || {};
  const targets = Array.isArray(run.targets_info) ? run.targets_info : [];
  return Boolean(
    run.start_time
    || run.end_time
    || run.scan_mode
    || run.run_id
    || Number(usage.total_tokens || usage.requests || 0) > 0
    || targets.some((t) => Boolean(t?.target || t?.original)),
  );
}

/**
 * Merge run summaries so a sparse later checkpoint/state cannot wipe tokens/targets
 * that a fuller live update already painted (the flash-then-empty right-panel bug).
 */
function mergeStrixRun(prev: StrixRun | undefined, next: StrixRun | undefined): StrixRun | undefined {
  if (!next && !prev) return undefined;
  if (!next) return prev;
  if (!prev) return next;
  const prevUsage = prev.llm_usage || {};
  const nextUsage = next.llm_usage || {};
  const prevTokens = Number(prevUsage.total_tokens || 0);
  const nextTokens = Number(nextUsage.total_tokens || 0);
  const prevRequests = Number(prevUsage.requests || 0);
  const nextRequests = Number(nextUsage.requests || 0);
  const preferNextUsage = nextTokens > prevTokens || nextRequests > prevRequests
    || (nextTokens === prevTokens && nextRequests === prevRequests && Object.keys(nextUsage).length > 0);
  const prevTargets = Array.isArray(prev.targets_info) ? prev.targets_info : [];
  const nextTargets = Array.isArray(next.targets_info) ? next.targets_info : [];
  const mergedTargets = nextTargets.length > 0 ? nextTargets : prevTargets;
  return {
    run_id: next.run_id || prev.run_id,
    run_name: next.run_name || prev.run_name,
    status: next.status || prev.status,
    start_time: next.start_time || prev.start_time,
    end_time: next.end_time || prev.end_time,
    scan_mode: next.scan_mode || prev.scan_mode,
    targets_info: mergedTargets.length ? mergedTargets : undefined,
    llm_usage: preferNextUsage && Object.keys(nextUsage).length
      ? nextUsage
      : (Object.keys(prevUsage).length ? prevUsage : nextUsage),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function strixTodosToPlanTree(items: unknown[]): PlanNode[] {
  return items.filter(isRecord).map((item, index) => ({
    node_id: `strix-todo-${readString(item.id) || index}`,
    id: readString(item.id) || `todo-${index}`,
    title: readString(item.title) || "Untitled task",
    status: readString(item.status) || "pending",
    kind: "task",
    level: "work_item",
    notes: readString(item.description),
    priority: strixTodoPriority(item.priority, index),
    source: "strix_todo",
    agent_id: readString(item.agent_id),
    linked_agent_id: readString(item.linked_agent_id),
  }));
}

function strixTodoPriority(value: unknown, index: number): number {
  const base: Record<string, number> = { critical: 0, high: 10, medium: 20, normal: 30, low: 40 };
  return (base[String(value || "").toLowerCase()] ?? 30) + index;
}

function shouldRenderPhaseStatus(message: Record<string, unknown>, workflowKind: string): boolean {
  if (workflowKind === "pentest") return false;
  const kanban = message.kanban;
  if (isKanbanSummary(kanban) && kanban.workflow_kind === "pentest") return false;
  return true;
}

function hasValues(value: Record<string, unknown> | undefined): boolean {
  return Boolean(value && Object.values(value).some(v => v !== undefined && v !== null && v !== ""));
}

function parsePhase(text: string): string | undefined {
  const match = text.match(/Phase:\s*([^\s(]+)/);
  return match?.[1];
}

function progressForPhase(phase: string | undefined, status: Conversation["status"] | "running"): Progress {
  const total = PHASES.length;
  let current = 0;
  if (status === "completed") current = total;
  else if (phase && PHASES.includes(phase as typeof PHASES[number])) current = PHASES.indexOf(phase as typeof PHASES[number]) + 1;
  else if (status === "running") current = 1;
  return { current, total, percent: total ? Math.round((current / total) * 100) : 0 };
}

function isActiveMessage(msg: Record<string, unknown>, activeId: string | null): boolean {
  const convId = msg.conversation_id;
  return !activeId || !convId || String(convId) === activeId;
}

function agentAttribution(msg: Record<string, unknown>, fallbackSource: AgentIdentity = "pentest"): Record<string, unknown> {
  const content = msg.content && typeof msg.content === "object" && !Array.isArray(msg.content) ? msg.content as Record<string, unknown> : {};
  const source = readString(msg.agent_source) || readString(content.agent_source) || fallbackSource;
  const nodeId = readString(msg.agent_node_id) || readString(content.agent_node_id);
  const expertId = readString(msg.expert_id) || readString(content.expert_id);
  const expertName = readString(msg.expert_name) || readString(content.expert_name);
  const expertDisplay = readString(msg.expert_display_name) || readString(content.expert_display_name);
  const out: Record<string, unknown> = { agent_source: source };
  if (nodeId) out.agent_node_id = nodeId;
  if (expertId) out.expert_id = expertId;
  if (expertName) out.expert_name = expertName;
  if (expertDisplay) out.expert_display_name = expertDisplay;
  return out;
}

/** Harness-only status lines that must not appear as chat from the expert. */
function isUserVisibleStatusMessage(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (t === "model turn" || t === "llm_waiting" || t === "llm_stalled" || t === "tool_running") return false;
  if (/^[\w.-]+\s+running$/i.test(t)) return false; // "todo running", "shell running"
  if (t.startsWith("phase:") && t.includes("(iter")) return false;
  if (t.startsWith("node4 starting") || t.includes(" starting pack=")) return false;
  // Keep interrupt / error / handoff style notes.
  return true;
}
function messageConversationId(msg: Record<string, unknown>, fallback: string | null): string | null {
  return msg.conversation_id ? String(msg.conversation_id) : fallback;
}

function upsertBy(items: Array<Record<string, unknown>>, item: Record<string, unknown>, key: string) {
  const value = item[key];
  if (!value) return [...items, item];
  return [...items.filter(existing => existing[key] !== value), item];
}

function makeMessage(conversationId: string | null, role: Message["role"], msg_type: string, content: Record<string, unknown>): Message {
  const messageId = readString(content.message_id);
  return { id: messageId || crypto.randomUUID(), conversation_id: conversationId || "", role, msg_type, content, parent_msg_id: null, created_at: new Date().toISOString() };
}
