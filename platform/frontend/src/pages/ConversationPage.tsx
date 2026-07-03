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

const ACTIVE_CONVERSATION_KEY = "active_conversation_id";
const MESSAGE_PAGE_SIZE = 200;

const TEMPLATES = [
  { label: "Web pentest", text: "Test {URL} for web application vulnerabilities" },
  { label: "Host scan", text: "Scan {IP range} for exposed services and security issues" },
  { label: "Access control", text: "Test the following accounts for access-control issues" },
  { label: "Retest", text: "Retest the vulnerability and verify the fix" },
];

type Progress = { current: number; total: number; percent: number };
type PlanNode = { node_id?: string; id?: string; title?: string; status?: string; parent_id?: string | null; kind?: string; level?: string; endpoint?: string | null; parameter?: string | null; vuln_type?: string | null; notes?: string | null; evidence_ids?: string[]; priority?: number; };
type AgentNode = { id: string; name: string; type: AgentIdentity | string; status: string; token_required?: boolean };
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
  plan_tree?: PlanNode[];
  findings?: Array<Record<string, unknown>>;
  assets?: Array<Record<string, unknown>>;
  pending_approvals?: Array<Record<string, unknown>>;
  evidence?: Array<Record<string, unknown>>;
};

export default function ConversationPage() {
  const { conversations, fetchAll } = useConversationStore();
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [restoreAttempted, setRestoreAttempted] = useState(false);
  const [stateSnapshotLoaded, setStateSnapshotLoaded] = useState(false);
  const messageScrollerRef = useRef<HTMLDivElement | null>(null);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingScrollRestoreRef = useRef<{ top: number; height: number } | null>(null);
  const pendingScrollToBottomRef = useRef(false);
  const shouldStickToBottomRef = useRef(true);
  const [input, setInput] = useState("");
  const [importingReport, setImportingReport] = useState(false);
  const [importStatus, setImportStatus] = useState<ImportStatus>(null);
  const [selectedAgent, setSelectedAgent] = useState<AgentNode | null>(null);
  const [agentNodes, setAgentNodes] = useState<AgentNode[]>([]);
  const [activeConversationNodeId, setActiveConversationNodeId] = useState<string | null>(null);
  const [agentState, setAgentState] = useState<Record<string, unknown>>({});
  const [progress, setProgress] = useState<Progress | undefined>();
  const [planTree, setPlanTree] = useState<PlanNode[]>([]);
  const [findings, setFindings] = useState<Array<Record<string, unknown>>>([]);
  const [assets, setAssets] = useState<Array<Record<string, unknown>>>([]);
  const [pendingApprovals, setPendingApprovals] = useState<Array<Record<string, unknown>>>([]);
  const [evidence, setEvidence] = useState<Array<Record<string, unknown>>>([]);
  const [running, setRunning] = useState(false);
  const [selectedVulnerability, setSelectedVulnerability] = useState<Partial<SecurityVulnerability> | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<Partial<SecurityAsset> | null>(null);
  const [selectedEvidence, setSelectedEvidence] = useState<Partial<SecurityEvidence> | null>(null);
  const [highlightedApprovalId, setHighlightedApprovalId] = useState<string | null>(null);

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
  const displayMessages = useMemo(() => groupConsecutiveToolMessages(phaseEntryMessages(messages.filter(isRenderableMessage))), [messages]);
  const activeConversation = useMemo(() => conversations.find(c => c.id === activeId), [activeId, conversations]);
  const platformAgentNodeId = useMemo(() => agentNodes.find(node => node.type === "platform")?.id || null, [agentNodes]);
  const fallbackPentestNodeId = useMemo(() => {
    const pentestNodeIds = agentNodes.filter(node => node.type === "pentest").map(node => node.id);
    return activeConversation?.node_id || activeConversationNodeId || (pentestNodeIds.length === 1 ? pentestNodeIds[0] : null);
  }, [activeConversation?.node_id, activeConversationNodeId, agentNodes]);
  const agentNameById = useMemo(() => Object.fromEntries(agentNodes.map(node => [node.id, node.name])), [agentNodes]);
  const mentionState = useMemo(() => getMentionState(input), [input]);
  const mentionOptions = useMemo(() => filterMentionOptions(agentNodes, mentionState?.query || ""), [agentNodes, mentionState]);
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
    setPlanTree(snapshot.plan_tree?.length ? snapshot.plan_tree : fallback?.plan_tree || []);
    setFindings(snapshot.findings?.length ? snapshot.findings : fallback?.findings || []);
    setAssets(snapshot.assets?.length ? snapshot.assets : fallback?.assets || []);
    setPendingApprovals(snapshot.pending_approvals?.length ? snapshot.pending_approvals : fallback?.pending_approvals || []);
    setEvidence(snapshot.evidence?.length ? snapshot.evidence : fallback?.evidence || []);
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

  const refreshConversationState = useCallback(async (id: string | null) => {
    if (!id) return;
    try {
      const state = await authFetch<ConversationSnapshot>(`/api/conversations/${id}/state`);
      applyConversationState(state);
      setStateSnapshotLoaded(true);
    } catch {
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
      setFindings(prev => upsertBy(prev, { ...m, id: m.id || m.vulnerability_id, location: m.location || m.affected_asset || "" }, "title"));
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
        stdout: m.line ? `${m.line}\n` : "",
        evidence_id: m.evidence_id,
        tool_items: [{ tool_name: m.tool_name || "", tool_run_id: m.tool_run_id, status: normalizeExecutionStatus(m.status), stdout: m.line || "", command: m.command || "", evidence_id: m.evidence_id }],
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
      const tree = Array.isArray(m.plan_tree) ? m.plan_tree as PlanNode[] : m.plan_node ? [m.plan_node as PlanNode] : [];
      if (tree.length) setPlanTree(tree);
      void refreshConversationState(messageConversationId(msg, activeId));
    },    request_decision: (msg) => {
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
      const convId = messageConversationId(msg, activeId);
      clearPendingAgentMessage(convId);
      void refreshConversationState(convId);
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
      setRunning(true);
      addMessageToConversation(convId, makeMessage(convId, "system", "status", { text: phaseLabel(phase), phase, active_tool: m.active_tool, status: m.status, intake_result: m.intake_result, message_id: m.message_id }));
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
      const phase = typeof m.phase === "string" ? m.phase : undefined;
      setAgentState({ phase, activeTool: m.active_tool, intakeResult: m.intake_result, intakeStatus: m.status });
      setProgress(progressForPhase(phase, "running"));
      setRunning(true);
      const statusMessage = readString(m.message);
      if (statusMessage) {
        addMessageToConversation(convId, makeMessage(convId, "agent", "text", { ...agentAttribution(m), text: statusMessage, message_id: m.message_id }));
      } else {
        addMessageToConversation(convId, makeMessage(convId, "system", "status", { text: phaseLabel(phase), phase, iteration: m.iteration, active_tool: m.active_tool, status: m.status, intake_result: m.intake_result, message_id: m.message_id }));
      }
    },
    task_complete: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const convId = messageConversationId(msg, activeId);
      clearPendingAgentMessage(convId);
      markMessageAutoScroll();
      setRunning(false);
      addMessageToConversation(convId, makeMessage(convId, "system", "status", { text: "Task complete - " + JSON.stringify((msg as Record<string, unknown>).summary || {}), summary: (msg as Record<string, unknown>).summary || {}, message_id: (msg as Record<string, unknown>).message_id }));
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
    setPlanTree([]);
    setFindings([]);
    setAssets([]);
    setPendingApprovals([]);
    setEvidence([]);
    setRunning(false);
  }, []);

  const loadConversation = useCallback(async (id: string | null) => {
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

  useEffect(() => { void loadAgentNodes(); }, [loadAgentNodes]);

  useEffect(() => {
    const reload = () => { void loadAgentNodes(); };
    window.addEventListener("focus", reload);
    window.addEventListener("nodes:changed", reload);
    return () => {
      window.removeEventListener("focus", reload);
      window.removeEventListener("nodes:changed", reload);
    };
  }, [loadAgentNodes]);

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

  const handleDecision = useCallback((requestId: string, decision: "authorize" | "cancel") => {
    if (!activeId || !requestId) return;
    setPendingApprovals(prev => prev.filter(item => item.request_id !== requestId));
    addMessageToConversation(activeId, makeMessage(activeId, "user", "decision", { request_id: requestId, decision }));
    send({ type: "user_decision", conversation_id: activeId, request_id: requestId, decision });
  }, [activeId, addMessageToConversation, send]);

  const chooseMention = useCallback((node: AgentNode) => {
    const state = getMentionState(input);
    const mention = `@${node.name} `;
    if (!state) {
      setInput(current => `${current}${current.endsWith(" ") || !current ? "" : " "}${mention}`);
    } else {
      setInput(current => `${current.slice(0, state.start)}${mention}${current.slice(state.start + state.query.length + 1)}`);
    }
    setSelectedAgent(node);
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

  const handleSend = useCallback(async () => {
    if (!input.trim()) return;
    const displayText = input.trim();
    const selectedMentionAgent = selectedAgent && displayText.includes(`@${selectedAgent.name}`) ? selectedAgent : resolveMentionedAgent(displayText, agentNodes);
    const text = stripAgentMention(displayText, selectedMentionAgent);
    setInput("");
    setSelectedAgent(null);

    const targetValue = extractTarget(text);
    const restartRequested = isRestartRequest(text);
    const completedConversation = isConversationComplete(activeId, conversations, planTree);
    const platformMention = selectedMentionAgent?.type === "platform";
    const startFresh = Boolean(activeId && restartRequested);

    let convId = startFresh ? null : activeId;
    if (!convId) {
      try {
        const data = await authFetch<Conversation>("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" } });
        convId = data.id;
        setActiveId(convId);
        localStorage.setItem(ACTIVE_CONVERSATION_KEY, convId);
        send({ type: "subscribe", conversation_id: convId });
        if (startFresh) resetConversationState();
        void fetchAll();
      } catch { return; }
    }

    const clientMessageId = crypto.randomUUID();
    const userContent: Record<string, unknown> = { text: displayText, client_message_id: clientMessageId };
    if (selectedMentionAgent) {
      userContent.agent_target = selectedMentionAgent.type === "platform" ? "platform" : "pentest";
      userContent.agent_node_id = selectedMentionAgent.id;
    }
    pendingScrollToBottomRef.current = true;
    shouldStickToBottomRef.current = true;
    const agentPayload = selectedMentionAgent ? { agent_target: selectedMentionAgent.type === "platform" ? "platform" : "pentest", agent_node_id: selectedMentionAgent.id } : {};
    const shouldContinueExisting = Boolean(!startFresh && activeId && !restartRequested && !completedConversation);
    const willSteerDirectly = Boolean(!platformMention && shouldContinueExisting && activeConversation?.status === "running");
    const pendingAgentSource = pendingAgentSourceForMessage(selectedMentionAgent, willSteerDirectly);
    const pendingAgentNodeId = selectedMentionAgent?.id || (pendingAgentSource === "pentest" ? activeConversation?.node_id || undefined : undefined);
    const pendingContent: Record<string, unknown> = {
      text: "Working...",
      agent_source: pendingAgentSource,
    };
    if (pendingAgentNodeId) pendingContent.agent_node_id = pendingAgentNodeId;
    setConversationMessageData(convId, data => {
      const withoutPending = removeMessageRecords(data, record => recordMessageType(record) === "agent_pending");
      const withUser = appendMessageRecord(withoutPending, messageRecordFromMessage(makeMessage(convId, "user", "text", userContent)));
      return appendMessageRecord(withUser, messageRecordFromMessage(makeMessage(convId, "agent", "agent_pending", pendingContent)));
    });

    if (!platformMention && shouldContinueExisting && activeConversation?.status === "running") {
      send({ type: "user_steer", conversation_id: convId, text, display_text: displayText, client_message_id: clientMessageId, ...agentPayload });
      return;
    }

    if (shouldContinueExisting && !targetValue) {
      setRunning(true);
      send({ type: "user_message", conversation_id: convId, text, display_text: displayText, resume: true, client_message_id: clientMessageId, ...agentPayload });
      return;
    }

    if (!targetValue) {
      send({ type: "user_message", conversation_id: convId, text, display_text: displayText, client_message_id: clientMessageId, ...agentPayload });
      return;
    }

    setRunning(true);
    setAgentState({ phase: "intake" });
    setProgress(progressForPhase("intake", "running"));
    const target = { type: targetValue.startsWith("http") ? "url" : "host", value: targetValue };
    const scope = { allow: [target.value], deny: [] };
    send({ type: "user_message", conversation_id: convId, text, target, scope, display_text: displayText, client_message_id: clientMessageId, ...agentPayload });
  }, [input, selectedAgent, agentNodes, activeId, activeConversation, conversations, planTree, resetConversationState, fetchAll, send, setConversationMessageData]);


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

function filterMentionOptions(nodes: AgentNode[], query: string): AgentNode[] {
  const normalized = query.trim().toLowerCase();
  const ordered = [...nodes].sort((a, b) => (a.type === "platform" ? -1 : b.type === "platform" ? 1 : a.name.localeCompare(b.name)));
  if (!normalized) return ordered.slice(0, 8);
  return ordered.filter(node => node.name.toLowerCase().includes(normalized) || String(node.type).toLowerCase().includes(normalized)).slice(0, 8);
}

function resolveMentionedAgent(value: string, nodes: AgentNode[]): AgentNode | null {
  return nodes.find(node => value.includes(`@${node.name}`)) || null;
}

function stripAgentMention(value: string, node: AgentNode | null): string {
  if (!node) return value;
  return value.replace(`@${node.name}`, "").replace(/\s+/g, " ").trim();
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

function pendingAgentSourceForMessage(
  selectedAgent: AgentNode | null,
  willSteerDirectly: boolean,
): AgentIdentity {
  if (selectedAgent?.type === "platform") return "platform";
  if (selectedAgent?.type === "pentest") return "pentest";
  if (willSteerDirectly) return "pentest";
  return "platform";
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
      <Sidebar activeId={activeId} onSelect={(id) => { void loadConversation(id || null); }} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar title={activeId ? conversations?.find(c => c.id === activeId)?.title : undefined} conversationId={activeId} />
        <div className="flex min-w-0 flex-1 overflow-hidden">
          <main data-testid="conversation-main" data-active-conversation-id={activeId || ""} className="flex min-w-0 flex-1 flex-col border-r border-hairline-soft">
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
              {displayMessages.map((msg, index) => <MessageRenderer key={msg.id} message={msg} previousMessage={displayMessages[index - 1]} agentNameById={agentNameById} fallbackPentestNodeId={fallbackPentestNodeId} platformAgentNodeId={platformAgentNodeId} onDecision={handleDecision} onOpenVulnerability={setSelectedVulnerability} onOpenAsset={setSelectedAsset} onOpenEvidence={setSelectedEvidence} highlightedApprovalId={highlightedApprovalId} approvalDecisionByRequestId={approvalDecisionByRequestId} />)}
            </div>
            <div className="border-t border-hairline-soft p-4">
              <div className="mb-3 flex gap-2">
                {TEMPLATES.map((t) => (
                  <button key={t.label} onClick={() => setInput(t.text)} className="rounded-pill border border-hairline px-3 py-1.5 text-xs text-ink-secondary transition-colors hover:bg-surface-default hover:text-ink">{t.label}</button>
                ))}
              </div>
              <div className="relative flex min-w-0 gap-2">
                {mentionState && mentionOptions.length > 0 && (
                  <div className="absolute bottom-full left-0 z-20 mb-2 w-72 overflow-hidden rounded-md border border-hairline bg-canvas shadow-lg">
                    {mentionOptions.map((node) => (
                      <button key={node.id} type="button" onMouseDown={(event) => { event.preventDefault(); chooseMention(node); }} className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-surface-default">
                        <span className="min-w-0 truncate">{node.name}</span>
                        <span className="ml-3 shrink-0 text-xs text-ink-muted">{node.type === "platform" ? "Platform" : node.status === "online" ? "Online" : "Offline"}</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="relative min-w-0 flex-1 rounded-md border border-hairline bg-canvas focus-within:border-ink">
                  {input && (
                    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre px-3.5 py-2.5 text-sm text-ink">
                      {renderMentionText(input)}
                    </div>
                  )}
                  <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void handleSend(); }}
                    placeholder="Type @ to choose an Agent, or describe the test request"
                    className="relative z-10 w-full bg-transparent px-3.5 py-2.5 text-sm text-transparent caret-ink placeholder:text-ink-muted focus:outline-none" />
                </div>
                {running ? (
                  <button onClick={() => { send({ type: "user_interrupt", conversation_id: activeId, action: "cancel" }); setRunning(false); }} className="rounded-pill bg-severity-critical px-5 py-2.5 text-sm font-medium text-white">Interrupt</button>
                ) : (
                  <button onClick={() => { void handleSend(); }} className="rounded-pill bg-ink px-5 py-2.5 text-sm font-medium text-white">Send</button>
                )}
              </div>
            </div>
          </main>
          <RightPanel
            phase={agentState.phase as string}
            activeTool={agentState.activeTool as string}
            intakeResult={agentState.intakeResult as Record<string, unknown> | undefined}
            intakeStatus={agentState.intakeStatus as string | undefined}
            progress={progress}
            planTree={planTree}
            findings={findings}
            assets={assets}
            pendingApprovals={pendingApprovals}
            evidence={evidence}
            onDecision={handleDecision}
            onOpenVulnerability={setSelectedVulnerability}
            onOpenAsset={setSelectedAsset}
            onOpenEvidence={setSelectedEvidence}
            onLocateApproval={locateApproval}
          />
        </div>
      </div>
      <VulnDetailDialog
        open={Boolean(selectedVulnerability)}
        vulnerabilityId={(selectedVulnerability?.id || selectedVulnerability?.vulnerability_id) as string | undefined}
        initial={selectedVulnerability}
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
    .map(m => ({ ...m.content, id: readString(m.content.id) || readString(m.content.finding_id) || m.id, location: m.content.location || m.content.affected_asset || "" }));
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
  return nodeId ? { agent_source: source, agent_node_id: nodeId } : { agent_source: source };
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
