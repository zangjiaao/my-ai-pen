import { useState } from "react";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";
import RightPanel from "../components/RightPanel";
import MessageRenderer from "../components/MessageRenderer";
import { useConversations } from "../hooks/useApi";
import { useWebSocket } from "../hooks/useWebSocket";
import type { Message } from "../lib/types";

const TEMPLATES = [
  { label: "Web 渗透", text: "对 {URL} 进行 Web 应用渗透测试" },
  { label: "主机扫描", text: "对 {IP 段} 进行全面主机安全扫描" },
  { label: "权限测试", text: "测试以下账号的权限控制和越权漏洞" },
  { label: "复测", text: "针对漏洞进行复测验证" },
];

export default function ConversationPage() {
  const { data: conversations } = useConversations();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");

  useWebSocket({
    status_update: (msg) => console.log("[status]", msg),
    vuln_found: (msg) => setMessages((prev) => [...prev, { id: crypto.randomUUID(), conversation_id: activeId || "", role: "agent", msg_type: "vuln_card", content: msg as Record<string, unknown>, parent_msg_id: null, created_at: new Date().toISOString() }]),
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
  });

  const handleSend = () => {
    if (!input.trim()) return;
    const msg: Message = { id: crypto.randomUUID(), conversation_id: activeId || "", role: "user", msg_type: "text", content: { text: input }, parent_msg_id: null, created_at: new Date().toISOString() };
    setMessages((prev) => [...prev, msg]);
    setInput("");
  };

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <Sidebar conversations={conversations || []} activeId={activeId} onSelect={setActiveId} />
      <div className="flex flex-1 flex-col">
        <TopBar title={activeId ? conversations?.find(c => c.id === activeId)?.title : undefined} />
        <div className="flex flex-1 overflow-hidden">
          {/* 对话区 */}
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
            {/* 输入区 */}
            <div className="border-t border-hairline-soft p-4">
              <div className="flex gap-2 mb-3">
                {TEMPLATES.map((t) => (
                  <button key={t.label} onClick={() => setInput(t.text)} className="rounded-pill border border-hairline px-3 py-1.5 text-xs text-ink-secondary transition-colors hover:bg-surface-default hover:text-ink">
                    {t.label}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSend()}
                  placeholder="描述你的测试需求。例如：对 https://example.com 做渗透测试，测试账号 admin/admin123（高权限）和 viewer/viewer123（低权限），重点检查权限提升和 API 鉴权绕过。"
                  className="flex-1 rounded-md border border-hairline bg-canvas px-3.5 py-2.5 text-sm placeholder:text-ink-muted focus:border-ink focus:outline-none" />
                <button onClick={handleSend} className="rounded-pill bg-ink px-5 py-2.5 text-sm font-medium text-white">发送</button>
              </div>
            </div>
          </main>
          <RightPanel />
        </div>
      </div>
    </div>
  );
}
