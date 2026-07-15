import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";
import RightPanel from "../components/RightPanel";
import MessageRenderer from "../components/MessageRenderer";
import VulnDetailDialog from "../components/VulnDetailDialog";
import AssetDetailDialog from "../components/AssetDetailDialog";
import EvidenceDetailDialog from "../components/EvidenceDetailDialog";
import { useConversationStore } from "../stores/conversationStore";
import { useWebSocket } from "../hooks/useWebSocket";
import { ApiError, authFetch } from "../lib/api";
import { normalizeExecutionStatus } from "../lib/status";
import { PHASES, PHASE_LABELS, phaseLabel } from "../lib/phase";
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import type { AgentIdentity, Conversation, Message } from "../lib/types";
import type { SecurityAsset, SecurityEvidence, SecurityVulnerability } from "../lib/securityTypes";
import { ENGAGEMENT_TEMPLATES, expertLabel, type ExpertId } from "../lib/experts";

const ACTIVE_CONVERSATION_KEY = "active_conversation_id";
/** Set by AssetPage when launching a task from selected hosts/ports. */
const PENDING_ASSET_TASK_KEY = "pending_asset_task";
const MESSAGE_PAGE_SIZE = 200;

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
  description?: string | null;
};

/** @mention picker entry: expert persona or platform agent. */
type MentionTarget = {
  kind: "expert" | "platform";
  /** Stable key for React list. */
  key: string;
  /** Token after @ */
  name: string;
  label: string;
  subtitle: string;
  nodeId: string;
  packId?: string;
  expertId?: string;
  status?: string;
};

type Progress = { current: number; total: number; percent: number };
type PlanNode = { node_id?: string; id?: string; title?: string; status?: string; parent_id?: string | null; kind?: string; level?: string; method?: string | null; endpoint?: string | null; parameter?: string | null; parameters?: string[]; vuln_type?: string | null; result?: string | null; notes?: string | null; evidence_ids?: string[]; priority?: number; source?: string; agent_id?: string; linked_agent_id?: string; };
type KanbanBucket = { id: string; title: string; done: number; total: number; status: string };
type KanbanSummary = {
  workflow_kind?: string;
  elapsed_seconds?: number;
  current_stage?: string;
  totals?: Record<string, number>;
  buckets?: KanbanBucket[];
};
type TimelineEvent = {
  id: string;
  at?: string;
  category: string;
  title: string;
  detail?: string;
  status?: string;
};
type StrixAgentStatus = {
  id: string;
  name: string;
  status: string;
  parent_id?: string | null;
  task?: string;
  skills?: string[];
  pending_count?: number;
  role?: string;
  current_tool?: string;
  current_action?: string;
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
};

export default function ConversationPage() {
  const { conversations, fetchAll } = useConversationStore();
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [restoreAttempted, setRestoreAttempted] = useState(false);
  const [stateSnapshotLoaded, setStateSnapshotLoaded] = useState(false);
  const messageScrollerRef = useRef<HTMLDivElement | null>(null);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const stateRefreshSeqRef = useRef(0);
  const pendingScrollRestoreRef = useRef<{ top: number; height: number } | null>(null);
  const pendingScrollToBottomRef = useRef(false);
  const shouldStickToBottomRef = useRef(true);
  const [input, setInput] = useState("");
  /** Explicit long-task Goal mode (structured field → Node4 goalObjective; not NLP). */
  const [goalModeEnabled, setGoalModeEnabled] = useState(false);
  const [goalObjective, setGoalObjective] = useState("");
  /** Structured engagement template (RoE depth) — not NLP. */
  const [engagementTemplate, setEngagementTemplate] = useState<"app_assessment" | "redteam_deep">("app_assessment");
  const [caseHandoff, setCaseHandoff] = useState<{
    suggest_pack_id?: string;
    reason?: string;
    expert_id?: string;
    expert_name?: string;
    status?: string;
  } | null>(null);
  const [importingReport, setImportingReport] = useState(false);
  const [importStatus, setImportStatus] = useState<ImportStatus>(null);
  /** Selected @mention target (expert or platform). */
  const [selectedMention, setSelectedMention] = useState<MentionTarget | null>(null);
  const selectedMentionRef = useRef<MentionTarget | null>(null);
  const [agentNodes, setAgentNodes] = useState<AgentNode[]>([]);
  const [productExperts, setProductExperts] = useState<ProductExpert[]>([]);
  const [activeConversationNodeId, setActiveConversationNodeId] = useState<string | null>(null);
  const [agentState, setAgentState] = useState<Record<string, unknown>>({});
  const [progress, setProgress] = useState<Progress | undefined>();
  const [kanban, setKanban] = useState<KanbanSummary | undefined>();
  const [pendingWorkflowKind, setPendingWorkflowKind] = useState<string>("");
  const [planTree, setPlanTree] = useState<PlanNode[]>([]);
  const [strixAgents, setStrixAgents] = useState<StrixAgentStatus[]>([]);
  const [strixNotes, setStrixNotes] = useState<StrixNote[]>([]);
  const [strixRun, setStrixRun] = useState<StrixRun | undefined>();
  const [findings, setFindings] = useState<Array<Record<string, unknown>>>([]);
  const [assets, setAssets] = useState<Array<Record<string, unknown>>>([]);
  const [pendingApprovals, setPendingApprovals] = useState<Array<Record<string, unknown>>>([]);
  const [evidence, setEvidence] = useState<Array<Record<string, unknown>>>([]);
  const [taskContext, setTaskContext] = useState<Record<string, unknown> | undefined>();
  const [running, setRunning] = useState(false);
  const [timelineCursorAt, setTimelineCursorAt] = useState<string | undefined>();
  const [selectedVulnerability, setSelectedVulnerability] = useState<Partial<SecurityVulnerability> | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<Partial<SecurityAsset> | null>(null);
  const [selectedEvidence, setSelectedEvidence] = useState<Partial<SecurityEvidence> | null>(null);
  const [highlightedApprovalId, setHighlightedApprovalId] = useState<string | null>(null);
  /** Debounce high-frequency plan_tree_updated so Status/Tasks does not flicker. */
  const planTreeDebounceRef = useRef<number | null>(null);
  const planTreeRefreshThrottleRef = useRef<number>(0);

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
  const displayMessages = useMemo(() => groupConsecutiveToolMessages(messages.filter(isRenderableMessage)), [messages]);
  const timelineEvents = useMemo(() => timelineFromMessages(messages), [messages]);
  const activeConversation = useMemo(() => conversations.find(c => c.id === activeId), [activeId, conversations]);
  const isActiveConversationRunning = running || activeConversation?.status === "running";
  const activeWorkflowKind = useMemo(() => {
    if (kanban?.workflow_kind) return kanban.workflow_kind;
    const nodeId = activeConversation?.node_id || activeConversationNodeId || "";
    return String(agentNodes.find(node => node.id === nodeId)?.type || pendingWorkflowKind || "");
  }, [activeConversation?.node_id, activeConversationNodeId, agentNodes, kanban?.workflow_kind, pendingWorkflowKind]);
  const shouldShowRightPanel = useMemo(() => {
    if (!activeId) return false;

    // Work artifacts from a worker node — always show (including history reopen).
    if (strixAgents.length || strixNotes.length || findings.length || assets.length) return true;
    if (planTree.some((node) => ["strix_todo", "agent", "coverage", "auditor", "worker", "pi_tool", "pi_workflow"].includes(String(node.source || "")))) {
      return true;
    }
    if (strixRun && (strixRun.start_time || strixRun.scan_mode || (strixRun.targets_info || []).length > 0)) return true;

    const assignedNodeId = activeConversation?.node_id || activeConversationNodeId || "";
    if (!assignedNodeId) return false;

    // Bound node is working or has already produced a runtime kanban surface.
    const stage = String(kanban?.current_stage || "").toLowerCase();
    if (kanban && stage && stage !== "idle" && stage !== "confirming") return true;
    if (["pentest", "strix"].includes(String(kanban?.workflow_kind || "")) && stage) return true;
    if (isActiveConversationRunning && (Boolean(agentState.phase) || Boolean(agentState.activeTool) || planTree.length > 0 || Boolean(kanban))) {
      return true;
    }
    // Terminal session that was bound to a node but artifacts not yet hydrated — show if status proves work ran.
    const status = String(activeConversation?.status || "").toLowerCase();
    if (["completed", "incomplete", "failed", "paused"].includes(status) && (Boolean(kanban) || planTree.length > 0 || Boolean(agentState.phase))) {
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
    strixAgents.length,
    strixNotes.length,
    strixRun,
  ]);
  const platformAgentNodeId = useMemo(() => agentNodes.find(node => node.type === "platform")?.id || null, [agentNodes]);
  const fallbackPentestNodeId = useMemo(() => {
    const pentestNodeIds = agentNodes.filter(node => node.type === "pentest").map(node => node.id);
    return activeConversation?.node_id || activeConversationNodeId || (pentestNodeIds.length === 1 ? pentestNodeIds[0] : null);
  }, [activeConversation?.node_id, activeConversationNodeId, agentNodes]);
  /** Display labels: expert id → @name (preferred), node id → physical name (fallback). */
  const agentNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const node of agentNodes) {
      map[node.id] = node.name;
    }
    for (const e of productExperts) {
      map[e.id] = e.display_name && e.display_name !== e.name ? e.display_name : e.name;
    }
    return map;
  }, [agentNodes, productExperts]);
  const approvalDecisionByRequestId = useMemo(() => {
    const decisions: Record<string, "authorize" | "cancel"> = {};
    for (const message of messages) {
      if (message.msg_type !== "decision") continue;
      const requestId = readString(message.content.request_id);
      const decision = readString(message.content.decision);
      if (requestId && (decision === "authorize" || decision === "cancel")) decisions[requestId] = decision;
    }
    return decisions;
  }, [messages]);

  const applyConversationState = useCallback((snapshot: ConversationSnapshot, fallback?: ConversationSnapshot) => {
    setAgentState(hasValues(snapshot.agent_state) ? snapshot.agent_state! : fallback?.agent_state || {});
    setProgress(snapshot.progress || fallback?.progress);
    setKanban(snapshot.kanban || fallback?.kanban);
    setPlanTree(snapshot.plan_tree?.length ? snapshot.plan_tree : fallback?.plan_tree || []);
    setStrixAgents(snapshot.strix_agents?.length ? snapshot.strix_agents : fallback?.strix_agents || []);
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
    setFindings(snapshot.findings?.length ? snapshot.findings : fallback?.findings || []);
    setAssets(snapshot.assets?.length ? snapshot.assets : fallback?.assets || []);
    setPendingApprovals(snapshot.pending_approvals?.length ? snapshot.pending_approvals : fallback?.pending_approvals || []);
    setEvidence(snapshot.evidence?.length ? snapshot.evidence : fallback?.evidence || []);
    setTaskContext(
      snapshot.task_context && Object.keys(snapshot.task_context).length
        ? snapshot.task_context
        : fallback?.task_context,
    );
    const snapshotConversation = snapshot.conversation || fallback?.conversation;
    if (snapshotConversation) setActiveConversationNodeId(snapshotConversation.node_id || null);
    setRunning(snapshotConversation?.status === "running");
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

  const updateTimelineCursorFromScroll = useCallback(() => {
    const el = messageScrollerRef.current;
    if (!el) return;
    const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-message-created-at]"));
    if (!rows.length) {
      setTimelineCursorAt(undefined);
      return;
    }
    const containerRect = el.getBoundingClientRect();
    const markerY = containerRect.top + el.clientHeight * 0.72;
    let current = rows[0].dataset.messageCreatedAt || undefined;
    for (const row of rows) {
      const rowTop = row.getBoundingClientRect().top;
      if (rowTop <= markerY) current = row.dataset.messageCreatedAt || current;
      else break;
    }
    setTimelineCursorAt((previous) => previous === current ? previous : current);
  }, []);

  const refreshConversationState = useCallback(async (id: string | null) => {
    if (!id) return;
    const requestSeq = ++stateRefreshSeqRef.current;
    try {
      const state = await authFetch<ConversationSnapshot>(`/api/conversations/${id}/state`);
      if (requestSeq !== stateRefreshSeqRef.current) return;
      applyConversationState(state);
      setStateSnapshotLoaded(true);
      // Case fields (1 session = 1 case): engagement template + handoff banner
      try {
        const caseData = await authFetch<{
          engagement_template?: string;
          allow_postex?: boolean;
          handoff?: {
            suggest_pack_id?: string;
            reason?: string;
            expert_id?: string;
            expert_name?: string;
            status?: string;
          } | null;
        }>(`/api/conversations/${id}/case`);
        if (requestSeq !== stateRefreshSeqRef.current) return;
        const tmpl = String(caseData.engagement_template || "").trim();
        if (tmpl === "redteam_deep" || tmpl === "app_assessment") {
          setEngagementTemplate(tmpl);
        } else if (caseData.allow_postex === true) {
          setEngagementTemplate("redteam_deep");
        }
        if (caseData.handoff && caseData.handoff.status === "suggested") {
          setCaseHandoff(caseData.handoff);
        } else {
          setCaseHandoff(null);
        }
      } catch {
        /* case endpoint optional if older backend */
      }
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

  const { send } = useWebSocket({
    vuln_found: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      const convId = messageConversationId(m, activeId);
      clearPendingAgentMessage(convId);
      markMessageAutoScroll();
      setFindings(prev => upsertBy(prev, {
        ...m,
        id: m.vulnerability_id || m.id,
        location: m.location || m.url || m.affected_asset || "",
        description: m.description || m.impact,
        poc: m.poc || m.reproduction,
        affected_asset: m.affected_asset || m.url,
      }, "title"));
      addMessageToConversation(convId, makeMessage(convId, "agent", "vuln_card", m));
      void refreshConversationState(convId);
    },
    tool_output: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, string>;
      const convId = messageConversationId(msg, activeId);
      clearPendingAgentMessage(convId);
      markMessageAutoScroll();
      const incoming = makeMessage(convId, "agent", "tool_call", {
        ...agentAttribution(m),
        tool_name: m.tool_name || "",
        tool_run_id: m.tool_run_id,
        command: m.command || "",
        status: normalizeExecutionStatus(m.status),
        stdout: m.stdout || (m.line ? `${m.line}\n` : ""),
        evidence_id: m.evidence_id,
        summary: m.summary || m.line || "",
        display_title: m.display_title || "",
        category: m.category || "",
        target: m.target || "",
        args: m.args,
        result: m.result,
        result_text: m.result_text,
        tool_items: [{
          tool_name: m.tool_name || "",
          tool_run_id: m.tool_run_id,
          status: normalizeExecutionStatus(m.status),
          stdout: m.stdout || m.line || "",
          command: m.command || "",
          evidence_id: m.evidence_id,
          summary: m.summary || m.line || "",
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
      void refreshConversationState(convId);
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
        // Coalesce rapid plan broadcasts (tool start/end) into one UI update.
        if (planTreeDebounceRef.current) window.clearTimeout(planTreeDebounceRef.current);
        planTreeDebounceRef.current = window.setTimeout(() => {
          setPlanTree(tree);
          planTreeDebounceRef.current = null;
        }, 250);
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
      setRunning(false);
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
      // Node3 agents, or Node2 panel_agents (worker tree), or diagnostics fallback from snapshot path.
      if (Array.isArray(node3Strix.agents) && node3Strix.agents.length) {
        setStrixAgents(node3Strix.agents.filter(isStrixAgentStatus));
      } else if (Array.isArray(checkpoint.panel_agents) && checkpoint.panel_agents.length) {
        setStrixAgents(checkpoint.panel_agents.filter(isStrixAgentStatus));
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
      if (Array.isArray(node3Strix.vulnerabilities)) {
        const vulnerabilities = node3Strix.vulnerabilities;
        setFindings(prev => mergeByTitle(prev, vulnerabilities.filter(isRecord).map(strixVulnerabilityToFinding)));
      }
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
    thinking: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const convId = messageConversationId(msg, activeId);
      clearPendingAgentMessage(convId);
      markMessageAutoScroll();
      addMessageToConversation(convId, makeMessage(convId, "agent", "thinking", msg as Record<string, unknown>));
    },
    reasoning: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const convId = messageConversationId(msg, activeId);
      clearPendingAgentMessage(convId);
      markMessageAutoScroll();
      addMessageToConversation(convId, makeMessage(convId, "agent", "reasoning", msg as Record<string, unknown>));
    },
    agent_thinking: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const convId = messageConversationId(msg, activeId);
      clearPendingAgentMessage(convId);
      markMessageAutoScroll();
      addMessageToConversation(convId, makeMessage(convId, "agent", "agent_thinking", msg as Record<string, unknown>));
    },
    status_update: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      const convId = messageConversationId(msg, activeId);
      clearPendingAgentMessage(convId);
      markMessageAutoScroll();
      // Prefer agent_phase from Node4; legacy used phase.
      const phase = typeof m.agent_phase === "string"
        ? m.agent_phase
        : typeof m.phase === "string"
          ? m.phase
          : undefined;
      setAgentState({ phase, activeTool: m.active_tool, intakeResult: m.intake_result, intakeStatus: m.status });
      setProgress(isProgress(m.progress) ? m.progress : progressForPhase(phase, "running"));
      if (isKanbanSummary(m.kanban)) setKanban(m.kanban);
      setRunning(true);
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
    task_complete: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      const convId = messageConversationId(msg, activeId);
      clearPendingAgentMessage(convId);
      markMessageAutoScroll();
      setRunning(false);
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
      setRunning(false);
      addMessageToConversation(convId, makeMessage(convId, "system", "status", { text: "Task failed: " + ((msg as Record<string, unknown>).message || ""), message_id: (msg as Record<string, unknown>).message_id }));
      void fetchAll();
      void refreshConversationState(convId);
    },
    text: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const c = (msg as Record<string, unknown>).content || msg;
      const convId = messageConversationId(msg, activeId);
      clearPendingAgentMessage(convId);
      markMessageAutoScroll();
      addMessageToConversation(convId, makeMessage(convId, "agent", "text", { ...agentAttribution(msg as Record<string, unknown>), ...(c as Record<string, unknown>) }));
    },
  });
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
    setStrixAgents([]);
    setStrixNotes([]);
    setStrixRun(undefined);
    setFindings([]);
    setAssets([]);
    setPendingApprovals([]);
    setEvidence([]);
    setTaskContext(undefined);
    setRunning(false);
  }, []);

  const loadConversation = useCallback(async (id: string | null) => {
    stateRefreshSeqRef.current += 1;
    if (!id) {
      localStorage.removeItem(ACTIVE_CONVERSATION_KEY);
      void queryClient.removeQueries({ queryKey: ["conversation-messages"] });
      setActiveId(null);
      resetConversationState();
      return;
    }

    setStateSnapshotLoaded(false);
    pendingScrollToBottomRef.current = true;
    shouldStickToBottomRef.current = true;
    void queryClient.removeQueries({ queryKey: ["conversation-messages"] });
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
        localStorage.removeItem(ACTIVE_CONVERSATION_KEY);
        void queryClient.removeQueries({ queryKey: ["conversation-messages", id] });
        setActiveId(null);
        resetConversationState();
        void fetchAll();
        return;
      }
      applyConversationState(fallbackState);
      setStateSnapshotLoaded(false);
    }
  }, [applyConversationState, conversations, fetchAll, queryClient, resetConversationState, send]);

  useEffect(() => {
    if (!activeId || stateSnapshotLoaded || messageQuery.isLoading || messages.length === 0) return;
    const conversationStatus = conversations.find(c => c.id === activeId)?.status || "created";
    applyConversationState(snapshotFromMessages(messages, conversationStatus));
  }, [activeId, conversations, messages, messageQuery.isLoading, stateSnapshotLoaded, applyConversationState]);

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

  /** @mention options: product experts first, then platform agent. */
  const mentionTargets = useMemo(() => {
    const out: MentionTarget[] = productExperts.map((e) => ({
      kind: "expert" as const,
      key: `expert:${e.id}`,
      name: e.name,
      label: e.display_name && e.display_name !== e.name ? e.display_name : e.name,
      subtitle: `${expertLabel(e.pack_id)} → ${e.node_name || e.node_id.slice(0, 8)}${
        e.node_status ? ` (${e.node_status})` : ""
      }`,
      nodeId: e.node_id,
      packId: e.pack_id,
      expertId: e.id,
      status: e.node_status || undefined,
    }));
    const platform = agentNodes.find((n) => n.type === "platform");
    if (platform) {
      out.push({
        kind: "platform",
        key: `platform:${platform.id}`,
        name: platform.name,
        label: platform.name,
        subtitle: "Platform",
        nodeId: platform.id,
        status: platform.status,
      });
    }
    return out;
  }, [productExperts, agentNodes]);

  const mentionState = useMemo(() => getMentionState(input), [input]);
  const mentionOptions = useMemo(
    () => filterMentionTargets(mentionTargets, mentionState?.query || ""),
    [mentionTargets, mentionState],
  );

  useEffect(() => {
    if (restoreAttempted || conversations.length === 0) return;
    const storedId = localStorage.getItem(ACTIVE_CONVERSATION_KEY);
    const stored = storedId ? conversations.find(c => c.id === storedId) : null;
    const runningConversation = conversations.find(c => c.status === "running");
    const fallback = stored || runningConversation || conversations[0];
    setRestoreAttempted(true);
    if (fallback) void loadConversation(fallback.id);
  }, [conversations, loadConversation, restoreAttempted]);

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

  const chooseMention = useCallback((target: MentionTarget) => {
    const state = getMentionState(input);
    const mention = `@${target.name} `;
    if (!state) {
      setInput((current) => `${current}${current.endsWith(" ") || !current ? "" : " "}${mention}`);
    } else {
      setInput(
        (current) =>
          `${current.slice(0, state.start)}${mention}${current.slice(state.start + state.query.length + 1)}`,
      );
    }
    selectedMentionRef.current = target;
    setSelectedMention(target);
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
      await loadConversation(result.conversation_id);
    } catch (error) {
      const message = error instanceof ApiError ? String(error.message) : "Import failed. Please confirm this is a pentest-node report.tar.gz export.";
      setImportStatus({ level: "error", text: message });
    } finally {
      setImportingReport(false);
      if (importFileInputRef.current) importFileInputRef.current.value = "";
    }
  }, [fetchAll, loadConversation]);

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
    /** Product RoE template (app_assessment | redteam_deep). */
    engagementTemplate?: string;
    allowPostex?: boolean;
    expertId?: string;
  }) => {
    const displayText = opts.displayText.trim();
    const text = opts.text.trim() || displayText;
    if (!displayText) return;
    const enableGoal = Boolean(opts.goalMode);
    const goalObjectiveText = String(opts.goalObjective || "").trim();
    const goalPayload: Record<string, unknown> = enableGoal
      ? {
          goal_mode: true,
          ...(goalObjectiveText ? { goal_objective: goalObjectiveText } : {}),
        }
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
    const engTemplate = String(opts.engagementTemplate || "").trim();
    const engagementPayload: Record<string, unknown> = {
      ...(eng ? { engagement: eng, role: eng } : {}),
      ...(engTemplate
        ? {
            engagement_template: engTemplate,
            allow_postex:
              typeof opts.allowPostex === "boolean"
                ? opts.allowPostex
                : engTemplate === "redteam_deep",
          }
        : {}),
    };
    const expertId =
      String(opts.expertId || "").trim() ||
      (resolvedMention?.kind === "expert" ? String(resolvedMention.expertId || "").trim() : "");
    const expertPayload = expertId ? { expert_id: expertId } : {};

    const platformMention = resolvedMention?.kind === "platform";
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
        setActiveId(convId);
        localStorage.setItem(ACTIVE_CONVERSATION_KEY, convId);
        send({ type: "subscribe", conversation_id: convId });
        if (startFresh) resetConversationState();
        void fetchAll();
      } catch {
        return;
      }
    } else if (explicitConv) {
      setActiveId(convId);
      localStorage.setItem(ACTIVE_CONVERSATION_KEY, convId);
      send({ type: "subscribe", conversation_id: convId });
      void fetchAll();
    }

    const clientMessageId = crypto.randomUUID();
    const userContent: Record<string, unknown> = { text: displayText, client_message_id: clientMessageId };

    // Route: explicit @expert/platform → node; else sticky conversation node.
    let routeNodeId: string | null = resolvedMention?.nodeId || null;
    let routeAgentTarget: AgentIdentity | undefined = resolvedMention
      ? resolvedMention.kind === "platform"
        ? "platform"
        : "pentest"
      : undefined;
    if (!routeNodeId) {
      const sticky = agentNodeById(
        agentNodes,
        activeConversationNodeId || activeConversation?.node_id || null,
      );
      if (sticky) {
        routeNodeId = sticky.id;
        routeAgentTarget = agentTargetForNode(sticky);
      }
    }
    const routeExpertId =
      resolvedMention?.kind === "expert"
        ? String(resolvedMention.expertId || opts.expertId || "").trim()
        : String(opts.expertId || "").trim();
    const routeExpertName =
      resolvedMention?.kind === "expert"
        ? String(resolvedMention.name || "").trim()
        : "";

    if (routeNodeId && routeAgentTarget) {
      userContent.agent_target = routeAgentTarget;
      userContent.agent_node_id = routeNodeId;
    }
    if (routeExpertId) userContent.expert_id = routeExpertId;
    if (routeExpertName) userContent.expert_name = routeExpertName;

    pendingScrollToBottomRef.current = true;
    shouldStickToBottomRef.current = true;
    const agentPayload: Record<string, unknown> =
      routeNodeId && routeAgentTarget
        ? { agent_target: routeAgentTarget, agent_node_id: routeNodeId }
        : {};
    if (routeExpertId) agentPayload.expert_id = routeExpertId;
    if (routeExpertName) agentPayload.expert_name = routeExpertName;

    const shouldContinueExisting = Boolean(
      !explicitConv &&
        !startFresh &&
        activeId &&
        !restartRequested &&
        !completedConversation &&
        !opts.forceNewConversation,
    );
    const willSteerDirectly = Boolean(
      !platformMention && shouldContinueExisting && activeConversation?.status === "running",
    );
    const pendingAgentSource: AgentIdentity =
      platformMention || routeAgentTarget === "platform"
        ? "platform"
        : routeAgentTarget === "pentest" || willSteerDirectly || Boolean(routeExpertId)
          ? "pentest"
          : "platform";
    const pendingAgentNodeId =
      routeNodeId ||
      (pendingAgentSource === "pentest"
        ? activeConversationNodeId || activeConversation?.node_id || undefined
        : undefined);
    // Prefer expert persona for Working... label — never fall back to bare node name when we know the expert.
    let pendingExpertId = routeExpertId;
    let pendingExpertName = routeExpertName;
    if (!pendingExpertId && pendingAgentSource === "pentest" && productExperts.length) {
      const packHint = eng || "pentest";
      const match =
        productExperts.find((e) => e.pack_id === packHint && e.node_id === pendingAgentNodeId)
        || productExperts.find((e) => e.pack_id === packHint)
        || productExperts[0];
      if (match) {
        pendingExpertId = match.id;
        pendingExpertName = match.display_name || match.name;
      }
    }
    const pendingContent: Record<string, unknown> = {
      text: "Working...",
      agent_source: pendingAgentSource,
    };
    if (pendingAgentNodeId) pendingContent.agent_node_id = pendingAgentNodeId;
    if (pendingExpertId) pendingContent.expert_id = pendingExpertId;
    if (pendingExpertName) pendingContent.expert_name = pendingExpertName;
    setConversationMessageData(convId, (data) => {
      const withoutPending = removeMessageRecords(
        data,
        (record) => recordMessageType(record) === "agent_pending",
      );
      const withUser = appendMessageRecord(
        withoutPending,
        messageRecordFromMessage(makeMessage(convId!, "user", "text", userContent)),
      );
      return appendMessageRecord(
        withUser,
        messageRecordFromMessage(makeMessage(convId!, "agent", "agent_pending", pendingContent)),
      );
    });

    const commonPayload = {
      ...agentPayload,
      ...goalPayload,
      ...engagementPayload,
      ...expertPayload,
    };

    if (!platformMention && shouldContinueExisting && activeConversation?.status === "running") {
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

    if (shouldContinueExisting && !targetValue) {
      setRunning(true);
      send({
        type: "user_message",
        conversation_id: convId,
        text,
        display_text: displayText,
        resume: true,
        client_message_id: clientMessageId,
        ...commonPayload,
      });
      return;
    }

    if (!targetValue) {
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

    setRunning(true);
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
  ]);

  // Auto-start task launched from Asset management (host/port multi-select).
  useEffect(() => {
    const raw = sessionStorage.getItem(PENDING_ASSET_TASK_KEY);
    if (!raw) return;
    let draft: {
      text?: string;
      target?: { type: string; value: string };
      scope?: { allow: string[]; deny: string[] };
    };
    try {
      draft = JSON.parse(raw);
    } catch {
      sessionStorage.removeItem(PENDING_ASSET_TASK_KEY);
      return;
    }
    sessionStorage.removeItem(PENDING_ASSET_TASK_KEY);
    const text = String(draft.text || "").trim();
    if (!text) return;
    const convId = localStorage.getItem(ACTIVE_CONVERSATION_KEY);
    void launchTaskMessage({
      displayText: text,
      text,
      target: draft.target || null,
      scope: draft.scope || null,
      forceNewConversation: false,
      conversationId: convId,
    });
  }, [launchTaskMessage]);

  const handleSend = useCallback(async () => {
    if (!input.trim()) return;
    const displayText = input.trim();
    const selectedCandidate = selectedMentionRef.current || selectedMention;
    // Prefer explicit toolbar expert; else parse @token from the message body.
    const resolved = selectedCandidate || resolveMentionedTarget(displayText, mentionTargets);
    const text = stripMentionToken(displayText, resolved?.name || null);
    // Keep selected expert after send so multi-turn stays with the same persona.
    // (Clear only when user picks "Platform" or another expert.)
    setInput("");
    const tmpl = engagementTemplate;
    await launchTaskMessage({
      displayText:
        resolved?.kind === "expert" && !displayText.includes(`@${resolved.name}`)
          ? `@${resolved.name} ${displayText}`
          : displayText,
      text,
      goalMode: goalModeEnabled,
      goalObjective: goalObjective.trim() || undefined,
      engagement: resolved?.kind === "expert" ? resolved.packId : tmpl || undefined,
      engagementTemplate: tmpl,
      allowPostex: tmpl === "redteam_deep",
      expertId: resolved?.kind === "expert" ? resolved.expertId : undefined,
    });
    // Persist case RoE on conversation (1 session = 1 case)
    if (activeId) {
      void authFetch(`/api/conversations/${activeId}/case`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          engagement_template: tmpl,
          allow_postex: tmpl === "redteam_deep",
        }),
      }).catch(() => {});
    }
  }, [input, selectedMention, mentionTargets, launchTaskMessage, goalModeEnabled, goalObjective, engagementTemplate, activeId]);

  const selectExpertFromToolbar = useCallback((key: string) => {
    if (!key) {
      selectedMentionRef.current = null;
      setSelectedMention(null);
      return;
    }
    const target = mentionTargets.find((t) => t.key === key) || null;
    selectedMentionRef.current = target;
    setSelectedMention(target);
  }, [mentionTargets]);


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
  const ordered = [...targets].sort((a, b) => {
    if (a.kind === "expert" && b.kind !== "expert") return -1;
    if (b.kind === "expert" && a.kind !== "expert") return 1;
    return a.name.localeCompare(b.name);
  });
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
    updateTimelineCursorFromScroll();
    if (el.scrollTop > 96) return;
    fetchOlderMessages();
  }, [fetchOlderMessages, isNearMessageBottom, updateTimelineCursorFromScroll]);

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
      window.requestAnimationFrame(() => window.requestAnimationFrame(updateTimelineCursorFromScroll));
      return;
    }
    if (shouldStickToBottomRef.current) scrollMessagesToBottom("auto");
    window.requestAnimationFrame(updateTimelineCursorFromScroll);
  }, [activeId, messages, messageQuery.isFetchingNextPage, scrollMessagesToBottom, updateTimelineCursorFromScroll]);

  useEffect(() => {
    window.requestAnimationFrame(updateTimelineCursorFromScroll);
  }, [displayMessages.length, updateTimelineCursorFromScroll]);

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <Sidebar activeId={activeId} onSelect={(id) => { void loadConversation(id || null); }} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar title={activeId ? conversations?.find(c => c.id === activeId)?.title : undefined} conversationId={activeId} />
        <div className="flex min-w-0 flex-1 overflow-hidden">
          <main data-testid="conversation-main" data-active-conversation-id={activeId || ""} className={`flex min-w-0 flex-1 flex-col ${shouldShowRightPanel ? "border-r border-hairline-soft" : ""}`}>
            <div ref={messageScrollerRef} onScroll={handleMessageScroll} className="min-w-0 flex-1 overflow-y-auto px-6 py-4 space-y-4">
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
              {displayMessages.map((msg, index) => (
                <div key={msg.id} data-message-created-at={msg.created_at}>
                  <MessageRenderer message={msg} previousMessage={displayMessages[index - 1]} agentNameById={agentNameById} fallbackPentestNodeId={fallbackPentestNodeId} platformAgentNodeId={platformAgentNodeId} onDecision={handleDecision} onOpenVulnerability={setSelectedVulnerability} onOpenAsset={setSelectedAsset} onOpenEvidence={setSelectedEvidence} highlightedApprovalId={highlightedApprovalId} approvalDecisionByRequestId={approvalDecisionByRequestId} />
                </div>
              ))}
            </div>
            <div className="border-t border-hairline-soft p-4">
              {/* Unified composer: multi-line input + toolbar (goal / expert / send) */}
              <div className="relative rounded-lg border border-hairline bg-canvas focus-within:border-ink">
                {mentionState && mentionOptions.length > 0 && (
                  <div className="absolute bottom-full left-0 z-20 mb-2 w-80 overflow-hidden rounded-md border border-hairline bg-canvas shadow-lg">
                    {mentionOptions.map((target) => (
                      <button
                        key={target.key}
                        type="button"
                        onMouseDown={(event) => {
                          event.preventDefault();
                          chooseMention(target);
                        }}
                        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-surface-default"
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium">@{target.name}</span>
                          <span className="block truncate text-[11px] text-ink-muted">{target.subtitle || target.label}</span>
                        </span>
                        <span className="ml-2 shrink-0 text-xs text-ink-muted">
                          {target.kind === "platform"
                            ? "Platform"
                            : target.status === "online"
                              ? "Online"
                              : target.status === "offline"
                                ? "Offline"
                                : expertLabel(target.packId)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="relative min-w-0">
                  {input && (
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-3.5 py-3 text-sm leading-5 text-ink"
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
                    placeholder="Describe the request… (Shift+Enter for new line, @ for expert)"
                    className="relative z-10 min-h-[4.5rem] w-full resize-none bg-transparent px-3.5 py-3 text-sm leading-5 text-transparent caret-ink placeholder:text-ink-muted focus:outline-none"
                  />
                </div>
                {goalModeEnabled && (
                  <div className="px-3 pb-1">
                    <input
                      value={goalObjective}
                      onChange={(e) => setGoalObjective(e.target.value)}
                      placeholder="Goal objective (optional — default: maximize verified findings in scope)"
                      className="w-full rounded-md border border-hairline bg-canvas-inset px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-muted focus:border-ink focus:outline-none"
                    />
                  </div>
                )}
                {caseHandoff?.suggest_pack_id && caseHandoff.status === "suggested" && (
                  <div className="mx-3 mb-2 flex flex-wrap items-center gap-2 rounded-md border border-status-running/30 bg-status-running/10 px-3 py-2 text-xs text-ink">
                    <span className="min-w-0 flex-1">
                      建议切换专家包 <strong>{caseHandoff.suggest_pack_id}</strong>
                      {caseHandoff.reason ? ` — ${caseHandoff.reason}` : ""}
                    </span>
                    <button
                      type="button"
                      className="rounded-md bg-ink px-2.5 py-1 text-[11px] font-medium text-white"
                      onClick={() => {
                        const pack = caseHandoff.suggest_pack_id;
                        const match = mentionTargets.find(
                          (t) => t.kind === "expert" && (t.packId === pack || t.expertId === caseHandoff.expert_id),
                        );
                        if (match) selectExpertFromToolbar(match.key);
                        setCaseHandoff((h) => (h ? { ...h, status: "accepted" } : null));
                      }}
                    >
                      一键选用
                    </button>
                    <button
                      type="button"
                      className="rounded-md border border-hairline px-2 py-1 text-[11px] text-ink-secondary"
                      onClick={() => setCaseHandoff(null)}
                    >
                      忽略
                    </button>
                  </div>
                )}
                <div className="flex min-w-0 items-center justify-between gap-3 px-3 pb-2.5 pt-0.5">
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
                    <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-ink-secondary">
                      <input
                        type="checkbox"
                        checked={goalModeEnabled}
                        onChange={(e) => setGoalModeEnabled(e.target.checked)}
                        className="rounded border-hairline"
                      />
                      <span className="font-medium text-ink">Goal</span>
                    </label>
                    <label className="inline-flex min-w-0 items-center gap-1.5 text-xs text-ink-secondary">
                      <span className="shrink-0 text-ink-muted">模式</span>
                      <select
                        value={engagementTemplate}
                        onChange={(e) =>
                          setEngagementTemplate(e.target.value as "app_assessment" | "redteam_deep")
                        }
                        title="结构化 engagement 模板（非 NLP）"
                        className="max-w-[10rem] truncate rounded-md border border-hairline bg-canvas px-2 py-1 text-xs text-ink focus:border-ink focus:outline-none"
                      >
                        {ENGAGEMENT_TEMPLATES.map((t) => (
                          <option key={t.id} value={t.id} title={t.description}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="inline-flex min-w-0 items-center gap-1.5 text-xs text-ink-secondary">
                      <span className="shrink-0 text-ink-muted">Expert</span>
                      <select
                        value={selectedMention?.key || ""}
                        onChange={(e) => selectExpertFromToolbar(e.target.value)}
                        className="max-w-[12rem] truncate rounded-md border border-hairline bg-canvas px-2 py-1 text-xs text-ink focus:border-ink focus:outline-none"
                      >
                        <option value="">Auto / none</option>
                        {mentionTargets.map((t) => (
                          <option key={t.key} value={t.key}>
                            {t.kind === "platform"
                              ? `${t.label} (platform)`
                              : `@${t.name}${t.status === "online" ? "" : t.status === "offline" ? " · offline" : ""}`}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="shrink-0">
                    {running ? (
                      <button
                        type="button"
                        onClick={() => {
                          send({ type: "user_interrupt", conversation_id: activeId, action: "cancel" });
                          setRunning(false);
                          void refreshConversationState(activeId);
                        }}
                        className="rounded-pill bg-severity-critical px-5 py-2 text-sm font-medium text-white"
                      >
                        Interrupt
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { void handleSend(); }}
                        disabled={!input.trim()}
                        className="rounded-pill bg-ink px-5 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Send
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </main>
          {shouldShowRightPanel && (
            <RightPanel
              phase={agentState.phase as string}
              activeTool={agentState.activeTool as string}
              intakeResult={agentState.intakeResult as Record<string, unknown> | undefined}
              intakeStatus={agentState.intakeStatus as string | undefined}
              progress={progress}
              kanban={kanban}
              workflowKind={activeWorkflowKind}
              running={isActiveConversationRunning}
              conversationStatus={activeConversation?.status}
              planTree={planTree}
              strixAgents={strixAgents}
              strixNotes={strixNotes}
              strixRun={strixRun}
              timeline={timelineEvents}
              timelineCursorAt={timelineCursorAt}
              findings={findings}
              assets={assets}
              taskContext={taskContext}
              onOpenVulnerability={setSelectedVulnerability}
              onOpenAsset={setSelectedAsset}
            />
          )}
        </div>
      </div>
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
        initial={selectedAsset}
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
    if (msgType === "tool_call") content.status = normalizeExecutionStatus(content.status);
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
  return recordMessageType(existing) === "tool_call" && recordMessageType(incoming) === "tool_call" && Boolean(recordToolRunKey(existing)) && recordToolRunKey(existing) === recordToolRunKey(incoming);
}

function mergeMessageRecords(existing: MessageRecord, incoming: MessageRecord): MessageRecord {
  if (recordMessageType(existing) !== "tool_call" || recordMessageType(incoming) !== "tool_call") return incoming;
  const existingContent = recordContent(existing);
  const incomingContent = recordContent(incoming);
  return {
    ...existing,
    ...incoming,
    content: {
      ...existingContent,
      ...incomingContent,
      command: incomingContent.command || existingContent.command || "",
      stdout: appendStdout(readString(existingContent.stdout), readString(incomingContent.stdout)),
      status: normalizeExecutionStatus(incomingContent.status || existingContent.status),
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

function appendStdout(current: string, incoming: string): string {
  if (!incoming) return current;
  if (!current) return incoming;
  if (current.endsWith(incoming)) return current;
  return `${current}${current.endsWith("\n") ? "" : "\n"}${incoming}`;
}

function timelineFromMessages(messages: Message[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const seen = new Set<string>();
  const taskStatus = new Map<string, string>();
  const workflowStatus = new Map<string, string>();
  for (const message of messages) {
    if (message.msg_type === "plan_tree_updated") {
      const content = message.content || {};
      for (const event of workflowEventsForMessage(message, workflowStatus)) {
        addTimelineEvent(events, seen, event);
      }
      const tree = Array.isArray(content.plan_tree) ? content.plan_tree : [];
      for (const item of tree) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const node = item as PlanNode;
        if (!isTimelineTaskNode(node)) continue;
        const nodeId = String(node.node_id || node.id || node.title || "");
        if (!nodeId) continue;
        const status = String(node.status || "pending");
        const previous = taskStatus.get(nodeId);
        if (previous === status) continue;
        taskStatus.set(nodeId, status);
        addTimelineEvent(events, seen, {
          id: `${message.id}:${nodeId}:${status}`,
          at: message.created_at,
          category: "Task",
          title: `${taskStatusVerb(status)}：${String(node.title || "未命名任务")}`,
          detail: taskDetail(node),
          status,
        });
      }
      continue;
    }

    const event = resultTimelineEventForMessage(message);
    if (event) addTimelineEvent(events, seen, event);
  }
  return events.slice(-120);
}

function addTimelineEvent(events: TimelineEvent[], seen: Set<string>, event: TimelineEvent): void {
  const key = `${event.category}:${event.title}:${event.detail || ""}:${event.status || ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  events.push(event);
}

function workflowEventsForMessage(message: Message, workflowStatus: Map<string, string>): TimelineEvent[] {
  const content = message.content || {};
  const kanban = content.kanban as Record<string, unknown> | undefined;
  const buckets = kanban?.buckets;
  if (!Array.isArray(buckets)) return [];
  const events: TimelineEvent[] = [];
  for (const bucket of buckets) {
    if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) continue;
    const item = bucket as Record<string, unknown>;
    const id = readString(item.id) || readString(item.title);
    if (!id) continue;
    const status = readString(item.status) || "pending";
    const previous = workflowStatus.get(id);
    if (previous === status) continue;
    workflowStatus.set(id, status);
    if (status === "pending" && previous) continue;
    events.push({
      id: `${message.id}:workflow:${id}:${status}`,
      at: message.created_at,
      category: "Workflow",
      title: `${readString(item.title) || id}：${statusText(status)}`,
      detail: bucketProgress(item),
      status,
    });
  }
  return events;
}

function resultTimelineEventForMessage(message: Message): TimelineEvent | null {
  const content = message.content || {};
  const at = message.created_at;
  const id = message.id;
  switch (message.msg_type) {
    case "status": {
      const text = readString(content.text);
      const status = readString(content.status);
      if (!text && !status) return null;
      if (!["blocked", "incomplete", "failed"].includes(status)) return null;
      return {
        id,
        at,
        category: status === "blocked" || status === "incomplete" ? "Gate" : "Status",
        title: text || status,
        detail: status && text !== status ? status : undefined,
        status,
      };
    }
    case "vuln_card":
    case "vuln_found": {
      const title = readString(content.title) || "Untitled vulnerability";
      const severity = readString(content.severity);
      const location = readString(content.location) || readString(content.url) || readString(content.affected_asset);
      return {
        id,
        at,
        category: "Finding",
        title: `漏洞：${title}`,
        detail: [severity, location].filter(Boolean).join(" · "),
        status: readString(content.status) || severity,
      };
    }
    case "asset_card":
    case "asset_discovered": {
      const address = readString(content.address) || readString(content.name) || "Unknown asset";
      return {
        id,
        at,
        category: "Asset",
        title: `资产：${address}`,
        detail: readString(content.asset_type) || readString(content.type),
      };
    }
    case "confirm_card": {
      return {
        id,
        at,
        category: "Approval",
        title: "请求用户确认",
        detail: clipTimeline(readString(content.question) || readString(content.proposed_action), 180),
        status: readString(content.risk_level),
      };
    }
    case "decision": {
      return {
        id,
        at,
        category: "Approval",
        title: `用户确认：${readString(content.decision) || "decision"}`,
        detail: readString(content.request_id),
        status: readString(content.decision),
      };
    }
    case "task_complete": {
      const status = readString(content.status) || "completed";
      const title =
        status === "incomplete" || status === "blocked"
          ? status === "blocked"
            ? "任务阻塞"
            : "任务未完成"
          : "任务完成";
      return {
        id,
        at,
        category: "Task",
        title,
        detail: clipTimeline(readString(content.summary), 180),
        status,
      };
    }
    case "task_incomplete":
      // Legacy msg_type from older nodes; same terminal meaning as task_complete incomplete.
      return {
        id,
        at,
        category: "Task",
        title: "任务未完成",
        detail: clipTimeline(readString(content.summary), 180),
        status: "incomplete",
      };
    default:
      return null;
  }
}

function isTimelineTaskNode(node: PlanNode): boolean {
  if ((node.level || "work_item") !== "work_item") return false;
  if (String(node.source || "") !== "agent") return false;
  const kind = String(node.kind || "task");
  return !["tool", "browser", "http", "poc", "scan", "traffic", "finding"].includes(kind);
}

function taskStatusVerb(status: string): string {
  if (status === "running") return "开始";
  if (status === "done") return "完成";
  if (status === "blocked") return "阻塞";
  if (status === "failed") return "失败";
  if (status === "skipped") return "跳过";
  return "计划";
}

function statusText(status: string): string {
  if (status === "running") return "进行中";
  if (status === "done") return "完成";
  if (status === "blocked") return "阻塞";
  if (status === "failed") return "失败";
  if (status === "skipped") return "跳过";
  return "待处理";
}

function taskDetail(node: PlanNode): string {
  return [node.endpoint, node.parameter, node.vuln_type, node.notes].map((item) => String(item || "").trim()).filter(Boolean).join(" · ");
}

function bucketProgress(bucket: Record<string, unknown>): string {
  const done = Number(bucket.done || 0);
  const total = Number(bucket.total || 0);
  return total > 0 ? `${done}/${total}` : "";
}

function clipTimeline(value: string, limit: number): string {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function phaseEntryMessages(messages: Message[]): Message[] {
  const result: Message[] = [];
  let currentPhase = "";
  for (const message of messages) {
    const phase = phaseForStatusMessage(message);
    if (!phase) {
      result.push(message);
      continue;
    }

    if (!currentPhase) {
      for (const missingPhase of phasesBefore(phase)) {
        result.push(makeSyntheticPhaseMessage(message, missingPhase));
      }
      currentPhase = result.length && phaseForStatusMessage(result[result.length - 1]) ? phaseForStatusMessage(result[result.length - 1]) : "";
    }

    if (phase === currentPhase) continue;
    currentPhase = phase;
    result.push(message);
  }
  return result;
}

function phasesBefore(phase: string): string[] {
  const index = PHASES.indexOf(phase as typeof PHASES[number]);
  return index > 0 ? PHASES.slice(0, index) : [];
}

function makeSyntheticPhaseMessage(anchor: Message, phase: string): Message {
  return {
    id: `${anchor.id}-phase-${phase}`,
    conversation_id: anchor.conversation_id,
    role: "system",
    msg_type: "status",
    content: { phase, text: phaseLabel(phase), synthetic: true },
    parent_msg_id: null,
    created_at: anchor.created_at,
  };
}

function phaseForStatusMessage(message: Message): string {
  if (message.msg_type !== "status") return "";
  return readString(message.content.phase) || parsePhase(readString(message.content.text)) || "";
}
function isRenderableMessage(message: Message): boolean {
  if (message.role === "user" && message.msg_type === "decision") return false;
  if (message.msg_type === "tool_call") return true;
  if (["text", "status", "confirm_card", "vuln_card", "vuln_found", "asset_card", "asset_discovered", "agent_pending", "thinking", "reasoning", "agent_thinking"].includes(message.msg_type)) return true;
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
  const values = [previous, incoming].map(value => normalizeExecutionStatus(value));
  if (values.includes("fail")) return "fail";
  if (values.includes("running")) return "running";
  return incoming || previous || "done";
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
    .filter(m => m.msg_type === "confirm_card" && readString(m.content.request_id) && !decisions.has(readString(m.content.request_id)))
    .map(m => ({ ...m.content, message_id: m.id }));
  const findings = messages
    .filter(m => m.msg_type === "vuln_card" || m.msg_type === "vuln_found")
    .map(m => ({
      ...m.content,
      id: readString(m.content.id) || readString(m.content.vulnerability_id) || readString(m.content.finding_id) || m.id,
      location: m.content.location || m.content.url || m.content.affected_asset || "",
      description: m.content.description || m.content.impact,
      poc: m.content.poc || m.content.reproduction,
      affected_asset: m.content.affected_asset || m.content.url,
    }));
  const assets = messages
    .filter(m => m.msg_type === "asset_card" || m.msg_type === "asset_discovered")
    .map(m => ({ ...m.content, id: readString(m.content.id) || readString(m.content.asset_id) || m.id, address: m.content.address || m.content.name || "" }));
  const explicitEvidence = messages
    .filter(m => m.msg_type === "evidence_created")
    .map(m => ({ ...m.content, id: readString(m.content.id) || m.id }));
  const toolEvidence = messages
    .filter(m => m.msg_type === "tool_call" && readString(m.content.stdout))
    .map(m => ({
      id: m.id,
      evidence_id: readString(m.content.tool_run_id) || m.id,
      type: "tool_output",
      source_tool: m.content.tool_name,
      tool_run_id: m.content.tool_run_id,
      summary: readString(m.content.stdout),
      properties: { status: m.content.status },
    }));
  const evidence = explicitEvidence.length ? explicitEvidence : toolEvidence;

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
    plan_tree: planTreeForPhase(phase, normalizedStatus),
    findings,
    assets,
    pending_approvals: pending,
    evidence,
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

function isStrixAgentStatus(value: unknown): value is StrixAgentStatus {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && readString((value as Record<string, unknown>).id));
}

/** Ensure main agent row exists, then upsert a worker child for live collaboration tree. */
function upsertWorkerAgent(prev: StrixAgentStatus[], worker: StrixAgentStatus): StrixAgentStatus[] {
  const main: StrixAgentStatus = prev.find((a) => a.id === "node2-main" || a.role === "main") || {
    id: "node2-main",
    name: "Main Agent",
    status: "running",
    parent_id: null,
    task: "",
    skills: [],
    pending_count: 0,
    role: "main",
    current_tool: "",
    current_action: "running",
  };
  const others = prev.filter((a) => a.id !== main.id && a.id !== worker.id);
  return [
    { ...main, status: main.status === "completed" ? "running" : main.status || "running", parent_id: null },
    ...others,
    { ...worker, parent_id: "node2-main" },
  ];
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

function strixVulnerabilityToFinding(item: Record<string, unknown>): Record<string, unknown> {
  const target = item.target || item.affected_asset || "";
  return {
    ...item,
    id: item.id || item.vulnerability_id || item.title,
    vulnerability_id: item.vulnerability_id || item.id,
    strix_vulnerability_id: item.strix_vulnerability_id || item.id,
    location: item.endpoint || item.location || target,
    affected_asset: target,
    status: item.status || "confirmed",
    confidence: item.confidence || "high",
    poc: item.poc || item.poc_description || item.poc_script_code,
    remediation: item.remediation || item.remediation_steps,
    source: "strix",
  };
}

function mergeByTitle(current: Array<Record<string, unknown>>, incoming: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const merged = [...current];
  for (const item of incoming) {
    const title = String(item.title || "");
    const index = merged.findIndex(existing => title && String(existing.title || "") === title);
    if (index >= 0) merged[index] = { ...merged[index], ...item };
    else merged.push(item);
  }
  return merged;
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

function planTreeForPhase(phase: string | undefined, status: Conversation["status"] | "running"): PlanNode[] {
  const currentIndex = phase && PHASES.includes(phase as typeof PHASES[number]) ? PHASES.indexOf(phase as typeof PHASES[number]) : status === "running" ? 0 : -1;
  return PHASES.map((key, index) => ({
    node_id: `plan-phase-${key}`,
    title: PHASE_LABELS[key],
    kind: "phase",
    level: "phase",
    status: status === "completed" || index < currentIndex ? "done" : index === currentIndex ? "running" : "pending",
    priority: index * 100,
  }));
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
  if (t === "model turn" || t === "llm_waiting" || t === "tool_running") return false;
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
