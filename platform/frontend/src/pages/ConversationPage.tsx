import { useCallback, useEffect, useState } from "react";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";
import RightPanel from "../components/RightPanel";
import MessageRenderer from "../components/MessageRenderer";
import { useConversationStore } from "../stores/conversationStore";
import { useWebSocket } from "../hooks/useWebSocket";
import { authFetch } from "../lib/api";
import type { Conversation, Message } from "../lib/types";

const ACTIVE_CONVERSATION_KEY = "active_conversation_id";

const PHASES = ["precheck", "plan", "recon", "scan", "verify", "report"] as const;
const PHASE_LABELS: Record<string, string> = {
  precheck: "目标与授权范围检查",
  plan: "生成测试计划",
  recon: "资产与服务探测",
  scan: "漏洞扫描与候选发现",
  verify: "复现验证与授权确认",
  report: "同步结果与整理证据",
};

const TEMPLATES = [
  { label: "Web 渗透", text: "对 {URL} 进行 Web 应用渗透测试" },
  { label: "主机扫描", text: "对 {IP 段} 进行全面主机安全扫描" },
  { label: "权限测试", text: "测试以下账号的权限控制和越权漏洞" },
  { label: "复测", text: "针对漏洞进行复测验证" },
];

type Progress = { current: number; total: number; percent: number };
type Todo = { id: string; title: string; status: "done" | "running" | "pending" };

type ConversationSnapshot = {
  conversation?: Conversation;
  agent_state?: Record<string, unknown>;
  progress?: Progress;
  todos?: Todo[];
  findings?: Array<Record<string, unknown>>;
  pending_approvals?: Array<Record<string, unknown>>;
  evidence?: Array<Record<string, unknown>>;
};

export default function ConversationPage() {
  const { conversations, fetchAll } = useConversationStore();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [restoreAttempted, setRestoreAttempted] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [agentState, setAgentState] = useState<Record<string, unknown>>({});
  const [progress, setProgress] = useState<Progress | undefined>();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [findings, setFindings] = useState<Array<Record<string, unknown>>>([]);
  const [pendingApprovals, setPendingApprovals] = useState<Array<Record<string, unknown>>>([]);
  const [evidence, setEvidence] = useState<Array<Record<string, unknown>>>([]);
  const [running, setRunning] = useState(false);

  const applyConversationState = useCallback((snapshot: ConversationSnapshot) => {
    setAgentState(snapshot.agent_state || {});
    setProgress(snapshot.progress);
    setTodos(snapshot.todos || []);
    setFindings(snapshot.findings || []);
    setPendingApprovals(snapshot.pending_approvals || []);
    setEvidence(snapshot.evidence || []);
    setRunning(snapshot.conversation?.status === "running");
  }, []);

  const refreshConversationState = useCallback(async (id: string | null) => {
    if (!id) return;
    try {
      const state = await authFetch<ConversationSnapshot>(`/api/conversations/${id}/state`);
      applyConversationState(state);
    } catch {
      // The live stream remains usable even if a snapshot refresh races startup.
    }
  }, [applyConversationState]);

  const { send } = useWebSocket({
    vuln_found: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      setFindings(prev => upsertBy(prev, { title: m.title, severity: m.severity, location: m.location || m.affected_asset || "" }, "title"));
      setMessages(prev => [...prev, makeMessage(messageConversationId(m, activeId), "agent", "vuln_card", m)]);
      void refreshConversationState(messageConversationId(m, activeId));
    },
    tool_output: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const { tool_name, line, status } = msg as Record<string, string>;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.msg_type === "tool_call" && (last.content as Record<string, unknown>).tool_name === tool_name) {
          return [...prev.slice(0, -1), { ...last, content: { ...last.content, status: status || "running", stdout: ((last.content as Record<string, string>).stdout || "") + line + "\n" } }];
        }
        return [...prev, makeMessage(messageConversationId(msg, activeId), "agent", "tool_call", { tool_name, command: "", status: status || "running", stdout: line + "\n" })];
      });
      void refreshConversationState(messageConversationId(msg, activeId));
    },
    asset_discovered: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      setMessages(prev => [...prev, makeMessage(messageConversationId(msg, activeId), "agent", "asset_card", msg as Record<string, unknown>)]);
      void refreshConversationState(messageConversationId(msg, activeId));
    },
    evidence_created: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      setEvidence(prev => upsertBy(prev, m, "evidence_id"));
      void refreshConversationState(messageConversationId(m, activeId));
    },
    request_decision: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      setPendingApprovals(prev => upsertBy(prev, m, "request_id"));
      setMessages(prev => [...prev, makeMessage(messageConversationId(msg, activeId), "agent", "confirm_card", m)]);
      void refreshConversationState(messageConversationId(m, activeId));
    },
    status_update: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const m = msg as Record<string, unknown>;
      const phase = typeof m.phase === "string" ? m.phase : undefined;
      setAgentState({ phase, activeTool: m.active_tool });
      setProgress(progressForPhase(phase, "running"));
      setTodos(todosForPhase(phase, "running"));
      setRunning(true);
      setMessages(prev => [...prev, makeMessage(messageConversationId(msg, activeId), "system", "status", { text: `Phase: ${phase || ""}`, phase, iteration: m.iteration, active_tool: m.active_tool })]);
    },
    task_complete: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const convId = messageConversationId(msg, activeId);
      setRunning(false);
      setMessages(prev => [...prev, makeMessage(convId, "system", "status", { text: "任务完成 - " + JSON.stringify((msg as Record<string, unknown>).summary || {}), summary: (msg as Record<string, unknown>).summary || {} })]);
      void fetchAll();
      void refreshConversationState(convId);
    },
    task_error: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const convId = messageConversationId(msg, activeId);
      setRunning(false);
      setMessages(prev => [...prev, makeMessage(convId, "system", "status", { text: "任务失败: " + ((msg as Record<string, unknown>).message || "") })]);
      void fetchAll();
      void refreshConversationState(convId);
    },
    text: (msg) => {
      if (!isActiveMessage(msg, activeId)) return;
      const c = (msg as Record<string, unknown>).content || msg;
      setMessages(prev => [...prev, makeMessage(messageConversationId(msg, activeId), "agent", "text", c as Record<string, unknown>)]);
    },
  });

  const resetConversationState = useCallback(() => {
    setMessages([]);
    setAgentState({});
    setProgress(undefined);
    setTodos([]);
    setFindings([]);
    setPendingApprovals([]);
    setEvidence([]);
    setRunning(false);
  }, []);

  const loadConversation = useCallback(async (id: string | null) => {
    if (!id) {
      localStorage.removeItem(ACTIVE_CONVERSATION_KEY);
      setActiveId(null);
      resetConversationState();
      return;
    }

    setActiveId(id);
    localStorage.setItem(ACTIVE_CONVERSATION_KEY, id);
    send({ type: "subscribe", conversation_id: id });

    try {
      const [messageData, state] = await Promise.all([
        authFetch<Array<Record<string, unknown>>>(`/api/conversations/${id}/messages`),
        authFetch<ConversationSnapshot>(`/api/conversations/${id}/state`),
      ]);
      setMessages(messageData.map(normalizeMessage(id)));
      applyConversationState(state);
    } catch {
      resetConversationState();
    }
  }, [applyConversationState, resetConversationState, send]);

  useEffect(() => { void fetchAll(); }, [fetchAll]);

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
    setMessages(prev => [...prev, makeMessage(activeId, "user", "text", { text: decision === "authorize" ? "已授权执行" : "已取消该操作" })]);
    send({ type: "user_decision", conversation_id: activeId, request_id: requestId, decision });
  }, [activeId, send]);

  const handleSend = useCallback(async () => {
    if (!input.trim()) return;
    const text = input;
    setInput("");

    let convId = activeId;
    if (!convId) {
      try {
        const data = await authFetch<Conversation>("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" } });
        convId = data.id;
        setActiveId(convId);
        localStorage.setItem(ACTIVE_CONVERSATION_KEY, convId);
        send({ type: "subscribe", conversation_id: convId });
        void fetchAll();
      } catch { return; }
    }

    setRunning(true);
    setAgentState({ phase: "precheck" });
    setProgress(progressForPhase("precheck", "running"));
    setTodos(todosForPhase("precheck", "running"));
    setMessages(prev => [...prev, makeMessage(convId, "user", "text", { text })]);
    const targetValue = extractTarget(text);
    const target = targetValue ? { type: targetValue.startsWith("http") ? "url" : "host", value: targetValue } : null;
    const scope = target ? { allow: [target.value], deny: [] } : { allow: [], deny: [] };
    send({ type: "user_message", conversation_id: convId, text, target, scope });
  }, [input, activeId, fetchAll, send]);

  function extractTarget(t: string): string | null {
    const url = t.match(/https?:\/\/\S+/);
    if (url) return url[0];
    const ip = t.match(/\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/);
    return ip ? ip[0] : null;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <Sidebar activeId={activeId} onSelect={(id) => { void loadConversation(id || null); }} />
      <div className="flex flex-1 flex-col">
        <TopBar title={activeId ? conversations?.find(c => c.id === activeId)?.title : undefined} />
        <div className="flex flex-1 overflow-hidden">
          <main className="flex flex-1 flex-col border-r border-hairline-soft">
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {messages.length === 0 && (
                <div className="flex h-full items-center justify-center">
                  <div className="text-center">
                    <h2 className="text-xl font-semibold">开始新的渗透测试</h2>
                    <p className="mt-2 text-sm text-ink-secondary">在下方输入测试目标，Agent 将自动开始工作</p>
                  </div>
                </div>
              )}
              {messages.map((msg) => <MessageRenderer key={msg.id} message={msg} onDecision={handleDecision} />)}
            </div>
            <div className="border-t border-hairline-soft p-4">
              <div className="mb-3 flex gap-2">
                {TEMPLATES.map((t) => (
                  <button key={t.label} onClick={() => setInput(t.text)} className="rounded-pill border border-hairline px-3 py-1.5 text-xs text-ink-secondary transition-colors hover:bg-surface-default hover:text-ink">{t.label}</button>
                ))}
              </div>
              <div className="flex gap-2">
                <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void handleSend(); }}
                  placeholder="描述你的测试需求。例如：对 http://host.docker.internal:8080/login.php 做低风险 recon"
                  className="flex-1 rounded-md border border-hairline bg-canvas px-3.5 py-2.5 text-sm placeholder:text-ink-muted focus:border-ink focus:outline-none" />
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
            progress={progress}
            todos={todos}
            findings={findings}
            pendingApprovals={pendingApprovals}
            evidence={evidence}
            onDecision={handleDecision}
          />
        </div>
      </div>
    </div>
  );
}

function normalizeMessage(conversationId: string) {
  return (m: Record<string, unknown>): Message => ({
    id: String(m.id || crypto.randomUUID()),
    conversation_id: String(m.conversation_id || conversationId),
    role: m.role as Message["role"],
    msg_type: String(m.msg_type || "text"),
    content: (m.content || {}) as Record<string, unknown>,
    parent_msg_id: null,
    created_at: String(m.created_at || new Date().toISOString()),
  });
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
  return { id: crypto.randomUUID(), conversation_id: conversationId || "", role, msg_type, content, parent_msg_id: null, created_at: new Date().toISOString() };
}