import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import type { AgentIdentity, Conversation, Message } from "../lib/types";
import type { SecurityAsset, SecurityEvidence, SecurityVulnerability } from "../lib/securityTypes";

const ACTIVE_CONVERSATION_KEY = "active_conversation_id";
const MESSAGE_PAGE_SIZE = 200;

const PHASES = ["intake", "recon", "analysis", "verify", "report", "complete"] as const;
const PHASE_LABELS: Record<string, string> = {
  intake: "\u76ee\u6807\u4e0e\u6388\u6743\u8303\u56f4\u68c0\u67e5",
  recon: "\u653b\u51fb\u9762\u53d1\u73b0",
  analysis: "\u8986\u76d6\u5206\u6790\u4e0e\u6d4b\u8bd5\u8ba1\u5212",
  verify: "\u9a8c\u8bc1\u4e0e\u8bc1\u636e\u786e\u8ba4",
  report: "\u62a5\u544a\u6574\u7406",
  complete: "\u4efb\u52a1\u5b8c\u6210",
};
const TEMPLATES = [
  { label: "Web 渗透", text: "对 {URL} 进行 Web 应用渗透测试" },
  { label: "主机扫描", text: "对 {IP 段} 进行全面主机安全扫描" },
  { label: "权限测试", text: "测试以下账号的权限控制和越权漏洞" },
  { label: "复测", text: "针对漏洞进行复测验证" },
];

type Progress = { current: number; total: number; percent: number };
type Todo = { id: string; title: string; status: "done" | "running" | "pending" };
type AgentNode = { id: string; name: string; type: AgentIdentity | string; status: string; token_required?: boolean };
type MentionState = { start: number; query: string } | null;

type MessageRecord = Record<string, unknown>;
type MessagesInfiniteData = InfiniteData<MessageRecord[], unknown>;

type ConversationSnapshot = {
  conversation?: Conversation;
  agent_state?: Record<string, unknown>;
  progress?: Progress;
  todos?: Todo[];
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
  const pendingScrollRestoreRef = useRef<{ top: number; height: number } | null>(null);
  const pendingScrollToBottomRef = useRef(false);
  const shouldStickToBottomRef = useRef(true);
  const [input, setInput] = useState("");
  const [selectedAgent, setSelectedAgent] = useState<AgentNode | null>(null);
  const [agentNodes, setAgentNodes] = useState<AgentNode[]>([]);
  const [agentState, setAgentState] = useState<Record<string, unknown>>({});
  const [progress, setProgress] = useState<Progress | undefined>();
  const [todos, setTodos] = useState<Todo[]>([]);
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
  const activeConversation = useMemo(() => conversations.find(c => c.id === activeId), [activeId, conversations]);
  const platformAgentNodeId = useMemo(() => agentNodes.find(node => node.type === "platform")?.id || null, [agentNodes]);
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
    setTodos(snapshot.todos?.length ? snapshot.todos : fallback?.todos || []);
    setFindings(snapshot.findings?.length ? snapshot.findings : fallback?.findings || []);
    setAssets(snapshot.assets?.length ? snapshot.assets : fallback?.assets || []);
    setPendingApprovals(snapshot.pending_approvals?.length ? snapshot.pending_approvals : fallback?.pending_approvals || []);
    setEvidence(snapshot.evidence?.length ? snapshot.evidence : fallback?.evidence || []);
    setRunning((snapshot.conversation || fallback?.conversation)?.status === "running");
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
        tool_name: m.tool_name || "",
        tool_run_id: m.tool_run_id,
        command: m.command || "",
        status: normalizeExecutionStatus(m.status),
        stdout: m.line ? `${m.line}\n` : "",
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
      const convId = messageConversationId(msg, activeId);
      clearPendingAgentMessage(convId);
      void refreshConversationState(convId);
    },
    intake_update: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      const phase = typeof m.phase === "string" ? m.phase : "intake";
      clearPendingAgentMessage(messageConversationId(msg, activeId));
      setAgentState({ phase, activeTool: m.active_tool, intakeResult: m.intake_result, intakeStatus: m.status });
      setProgress(progressForPhase(phase, "running"));
      setTodos(todosForPhase(phase, "running"));
      setRunning(true);
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
      setTodos(todosForPhase(phase, "running"));
      setRunning(true);
      addMessageToConversation(convId, makeMessage(convId, "system", "status", { text: `Phase: ${phase || ""}`, phase, iteration: m.iteration, active_tool: m.active_tool, status: m.status, intake_result: m.intake_result, message_id: m.message_id }));
    },
    task_complete: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const convId = messageConversationId(msg, activeId);
      clearPendingAgentMessage(convId);
      markMessageAutoScroll();
      setRunning(false);
      addMessageToConversation(convId, makeMessage(convId, "system", "status", { text: "任务完成 - " + JSON.stringify((msg as Record<string, unknown>).summary || {}), summary: (msg as Record<string, unknown>).summary || {}, message_id: (msg as Record<string, unknown>).message_id }));
      void fetchAll();
      void refreshConversationState(convId);
    },
    task_error: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const convId = messageConversationId(msg, activeId);
      clearPendingAgentMessage(convId);
      markMessageAutoScroll();
      setRunning(false);
      addMessageToConversation(convId, makeMessage(convId, "system", "status", { text: "任务失败: " + ((msg as Record<string, unknown>).message || ""), message_id: (msg as Record<string, unknown>).message_id }));
      void fetchAll();
      void refreshConversationState(convId);
    },
    text: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const c = (msg as Record<string, unknown>).content || msg;
      const convId = messageConversationId(msg, activeId);
      clearPendingAgentMessage(convId);
      markMessageAutoScroll();
      addMessageToConversation(convId, makeMessage(convId, "agent", "text", c as Record<string, unknown>));
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
    setProgress(undefined);
    setTodos([]);
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

  const handleSend = useCallback(async () => {
    if (!input.trim()) return;
    const selectedMentionAgent = selectedAgent && input.includes(`@${selectedAgent.name}`) ? selectedAgent : resolveMentionedAgent(input, agentNodes);
    const text = stripAgentMention(input, selectedMentionAgent);
    setInput("");
    setSelectedAgent(null);

    const targetValue = extractTarget(text);
    const restartRequested = isRestartRequest(text);
    const completedConversation = isConversationComplete(activeId, conversations, todos);
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
    const userContent: Record<string, unknown> = { text, client_message_id: clientMessageId };
    if (selectedMentionAgent) {
      userContent.agent_target = selectedMentionAgent.type === "platform" ? "platform" : "pentest";
      userContent.agent_node_id = selectedMentionAgent.id;
    }
    pendingScrollToBottomRef.current = true;
    shouldStickToBottomRef.current = true;
    const agentPayload = selectedMentionAgent ? { agent_target: selectedMentionAgent.type === "platform" ? "platform" : "pentest", agent_node_id: selectedMentionAgent.id } : {};
    const shouldContinueExisting = Boolean(!startFresh && activeId && !restartRequested && !completedConversation);
    const pendingAgentSource = pendingAgentSourceForMessage(selectedMentionAgent, targetValue, activeConversation?.status, todos);
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
      send({ type: "user_steer", conversation_id: convId, text, client_message_id: clientMessageId, ...agentPayload });
      return;
    }

    if (shouldContinueExisting && !targetValue) {
      setRunning(true);
      send({ type: "user_message", conversation_id: convId, text, resume: true, client_message_id: clientMessageId, ...agentPayload });
      return;
    }

    if (!targetValue) {
      send({ type: "user_message", conversation_id: convId, text, client_message_id: clientMessageId, ...agentPayload });
      return;
    }

    setRunning(true);
    setAgentState({ phase: "intake" });
    setProgress(progressForPhase("intake", "running"));
    setTodos(todosForPhase("intake", "running"));
    const target = { type: targetValue.startsWith("http") ? "url" : "host", value: targetValue };
    const scope = { allow: [target.value], deny: [] };
    send({ type: "user_message", conversation_id: convId, text, target, scope, client_message_id: clientMessageId, ...agentPayload });
  }, [input, selectedAgent, agentNodes, activeId, activeConversation, conversations, todos, resetConversationState, fetchAll, send, setConversationMessageData]);


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

function isConversationComplete(activeId: string | null, conversations: Conversation[], todos: Todo[]): boolean {
  const conversation = conversations.find(c => c.id === activeId);
  if (conversation?.status === "completed") return true;
  if (todos.length > 0 && todos.every(item => item.status === "done")) return true;
  return false;
}

function pendingAgentSourceForMessage(
  selectedAgent: AgentNode | null,
  targetValue: string | null,
  conversationStatus: Conversation["status"] | undefined,
  todos: Todo[],
): AgentIdentity {
  if (selectedAgent?.type === "platform") return "platform";
  if (selectedAgent?.type === "pentest") return "pentest";
  if (targetValue || conversationStatus === "running" || todos.some(item => item.status === "running" || item.status === "pending")) return "pentest";
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
                  <div className="text-center">
                    <h2 className="text-xl font-semibold">开始新的渗透测试</h2>
                    <p className="mt-2 text-sm text-ink-secondary">在下方输入测试目标，Agent 将自动开始工作</p>
                  </div>
                </div>
              )}
              {messages.length === 0 && activeId && (
                <div className="flex h-full items-center justify-center">
                  <div className="text-center">
                    <h2 className="text-xl font-semibold">暂无对话记录</h2>
                    <p className="mt-2 text-sm text-ink-secondary">该会话已选中，但历史消息为空或暂时无法加载。</p>
                  </div>
                </div>
              )}
              {messageQuery.isFetchingNextPage && <div className="py-2 text-center text-xs text-ink-muted">Loading older messages...</div>}
              {messageQuery.hasNextPage && !messageQuery.isFetchingNextPage && <button type="button" onClick={fetchOlderMessages} className="mx-auto block rounded-pill border border-hairline px-3 py-1.5 text-xs text-ink-secondary">Load older messages</button>}
              {messages.map((msg, index) => <MessageRenderer key={msg.id} message={msg} previousMessage={messages[index - 1]} agentNameById={agentNameById} fallbackPentestNodeId={activeConversation?.node_id || null} platformAgentNodeId={platformAgentNodeId} onDecision={handleDecision} onOpenVulnerability={setSelectedVulnerability} onOpenAsset={setSelectedAsset} highlightedApprovalId={highlightedApprovalId} approvalDecisionByRequestId={approvalDecisionByRequestId} />)}
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
                        <span className="ml-3 shrink-0 text-xs text-ink-muted">{node.type === "platform" ? "平台" : node.status === "online" ? "在线" : "离线"}</span>
                      </button>
                    ))}
                  </div>
                )}
                <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void handleSend(); }}
                  placeholder="输入 @ 选择 Agent，或直接描述测试需求"
                  className="min-w-0 flex-1 rounded-md border border-hairline bg-canvas px-3.5 py-2.5 text-sm placeholder:text-ink-muted focus:border-ink focus:outline-none" />
                {running ? (
                  <button onClick={() => { send({ type: "user_interrupt", conversation_id: activeId, action: "cancel" }); setRunning(false); }} className="rounded-pill bg-severity-critical px-5 py-2.5 text-sm font-medium text-white">中断</button>
                ) : (
                  <button onClick={() => { void handleSend(); }} className="rounded-pill bg-ink px-5 py-2.5 text-sm font-medium text-white">发送</button>
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
            todos={todos}
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
    todos: todosForPhase(phase, normalizedStatus),
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

function todosForPhase(phase: string | undefined, status: Conversation["status"] | "running"): Todo[] {
  const currentIndex = phase && PHASES.includes(phase as typeof PHASES[number]) ? PHASES.indexOf(phase as typeof PHASES[number]) : status === "running" ? 0 : -1;
  return PHASES.map((key, index) => ({
    id: key,
    title: PHASE_LABELS[key],
    status: status === "completed" || index < currentIndex ? "done" : index === currentIndex ? "running" : "pending",
  }));
}

function isActiveMessage(msg: Record<string, unknown>, activeId: string | null): boolean {
  const convId = msg.conversation_id;
  return !activeId || !convId || String(convId) === activeId;
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
