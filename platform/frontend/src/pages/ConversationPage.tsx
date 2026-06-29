import { useState, useCallback } from "react";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";
import RightPanel from "../components/RightPanel";
import MessageRenderer from "../components/MessageRenderer";
import { useConversationStore } from "../stores/conversationStore";
import { useWebSocket } from "../hooks/useWebSocket";
import { authFetch } from "../lib/api";
import type { Message } from "../lib/types";

const TEMPLATES = [
  { label: "Web 渗透", text: "对 {URL} 进行 Web 应用渗透测试" },
  { label: "主机扫描", text: "对 {IP 段} 进行全面主机安全扫描" },
  { label: "权限测试", text: "测试以下账号的权限控制和越权漏洞" },
  { label: "复测", text: "针对漏洞进行复测验证" },
];

export default function ConversationPage() {
  const { conversations, fetchAll } = useConversationStore();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [agentState, setAgentState] = useState<Record<string, unknown>>({});
  const [findings, setFindings] = useState<Array<Record<string, unknown>>>([]);
  const [running, setRunning] = useState(false);

  const { send } = useWebSocket({
    vuln_found: (msg) => { const m = msg as Record<string,unknown>; setFindings(prev => [...prev.filter(f => f.title !== m.title), { title: m.title, severity: m.severity, location: m.location || '' }]); setMessages((prev) => [...prev, { id: crypto.randomUUID(), conversation_id: activeId || "", role: "agent", msg_type: "vuln_card", content: m, parent_msg_id: null, created_at: new Date().toISOString() }]); },
    tool_output: (msg) => {
      const { tool_name, line } = msg as Record<string, string>;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.msg_type === "tool_call" && (last.content as Record<string, unknown>).tool_name === tool_name) {
          return [...prev.slice(0, -1), { ...last, content: { ...last.content, stdout: ((last.content as Record<string, string>).stdout || "") + line + "\n" } }];
        }
        return [...prev, { id: crypto.randomUUID(), conversation_id: activeId || "", role: "agent", msg_type: "tool_call", content: { tool_name, command: "", status: "running", stdout: line + "\n" }, parent_msg_id: null, created_at: new Date().toISOString() }];
      });
    },
    asset_discovered: (msg) => setMessages((prev) => [...prev, { id: crypto.randomUUID(), conversation_id: activeId || "", role: "agent", msg_type: "asset_card", content: msg as Record<string, unknown>, parent_msg_id: null, created_at: new Date().toISOString() }]),
    status_update: (msg) => { const m = msg as Record<string,unknown>; setAgentState({ phase: m.phase, iteration: m.iteration, maxIteration: 50, activeTool: m.active_tool }); setMessages((prev) => [...prev, { id: crypto.randomUUID(), conversation_id: activeId || "", role: "system", msg_type: "status", content: { text: `Phase: ${m.phase}` }, parent_msg_id: null, created_at: new Date().toISOString() }]); },
    task_complete: (msg) => { setRunning(false); setMessages((prev) => [...prev, { id: crypto.randomUUID(), conversation_id: activeId || "", role: "system", msg_type: "status", content: { text: "任务完成 — " + JSON.stringify((msg as Record<string,unknown>).summary) }, parent_msg_id: null, created_at: new Date().toISOString() }]); },
    task_error: (msg) => { setRunning(false); setMessages((prev) => [...prev, { id: crypto.randomUUID(), conversation_id: activeId || "", role: "system", msg_type: "status", content: { text: "任务失败: " + ((msg as Record<string,unknown>).message || '') }, parent_msg_id: null, created_at: new Date().toISOString() }]); },
    text: (msg) => { const c = (msg as Record<string,unknown>).content || msg; setMessages((prev) => [...prev, { id: crypto.randomUUID(), conversation_id: activeId || "", role: "agent", msg_type: "text", content: c as Record<string, unknown>, parent_msg_id: null, created_at: new Date().toISOString() }]); },
    task_error: (msg) => { console.log("[error]", msg); },
  });

  const handleSend = useCallback(async () => {
    if (!input.trim()) return;
    const text = input;
    setInput("");

    // 第一条消息 → 创建会话
    let convId = activeId;
    if (!convId) {
      try {
        const data = await authFetch("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" } });
        convId = data.id as string;
        setActiveId(convId);
        fetchAll();
      } catch { return; }
    }

    setRunning(true);
    const userMsg: Message = { id: crypto.randomUUID(), conversation_id: convId, role: "user", msg_type: "text", content: { text }, parent_msg_id: null, created_at: new Date().toISOString() };
    setMessages((prev) => [...prev, userMsg]);
    const url = extractUrl(text);
    const target = url ? { type: "url", value: url } : null;
    send({ type: "user_message", conversation_id: convId, text, target });
  }, [input, activeId, fetchAll, send]);

  function extractUrl(t: string): string | null {
    const m = t.match(/https?:\/\/\S+/); return m ? m[0] : null;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <Sidebar activeId={activeId} onSelect={async (id) => { if (!id) { setActiveId(null); setMessages([]); return; } setActiveId(id); try { const data = await authFetch(`/api/conversations/${id}/messages`); setMessages(data.map((m: Record<string,unknown>) => ({ ...m, parent_msg_id: null }) as Message)); } catch { setMessages([]); } }} />
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
              {messages.map((msg) => <MessageRenderer key={msg.id} message={msg} />)}
            </div>
            <div className="border-t border-hairline-soft p-4">
              <div className="mb-3 flex gap-2">
                {TEMPLATES.map((t) => (
                  <button key={t.label} onClick={() => setInput(t.text)} className="rounded-pill border border-hairline px-3 py-1.5 text-xs text-ink-secondary transition-colors hover:bg-surface-default hover:text-ink">{t.label}</button>
                ))}
              </div>
              <div className="flex gap-2">
                <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSend()}
                  placeholder="描述你的测试需求。例如：对 https://example.com 做渗透测试，测试账号 admin/admin123（高权限）和 viewer/viewer123（低权限）..."
                  className="flex-1 rounded-md border border-hairline bg-canvas px-3.5 py-2.5 text-sm placeholder:text-ink-muted focus:border-ink focus:outline-none" />
                {running ? (
                  <button onClick={() => { send({ type: "user_interrupt", conversation_id: activeId, action: "cancel" }); setRunning(false); }} className="rounded-pill bg-severity-critical px-5 py-2.5 text-sm font-medium text-white">中止</button>
                ) : (
                  <button onClick={handleSend} className="rounded-pill bg-ink px-5 py-2.5 text-sm font-medium text-white">发送</button>
                )}
              </div>
            </div>
          </main>
          <RightPanel phase={agentState.phase as string} iteration={agentState.iteration as number} maxIteration={agentState.maxIteration as number} activeTool={agentState.activeTool as string} findings={findings} />
        </div>
      </div>
    </div>
  );
}
