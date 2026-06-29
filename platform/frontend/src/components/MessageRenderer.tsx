import type { Message } from "../lib/types";

function ToolCallCard({ content }: { content: Record<string, unknown> }) {
  const toolName = content.tool_name as string || "";
  const status = content.status as string || "running";
  const stdout = content.stdout as string || "";
  const statusColor = status === "running" ? "bg-status-running" : status === "done" ? "bg-status-success" : "bg-status-error";
  return (
    <div className="my-2 rounded-md border border-hairline bg-surface-default p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className={`inline-block h-2 w-2 rounded-full ${statusColor}`} />
        <span className="text-sm font-medium">🔧 {toolName}</span>
        <span className="text-xs text-ink-muted">{status}</span>
      </div>
      <pre className="max-h-64 overflow-y-auto rounded-sm bg-canvas-inset border border-hairline p-3 font-mono text-[13px] leading-relaxed whitespace-pre-wrap">{stdout || "等待输出..."}</pre>
    </div>
  );
}

function VulnCard({ content }: { content: Record<string, unknown> }) {
  const severity = content.severity as string || "info";
  const borderColor: Record<string, string> = { critical: "border-l-severity-critical", high: "border-l-severity-high", medium: "border-l-severity-medium", low: "border-l-severity-low" };
  return (
    <div className={`my-2 rounded-md border border-hairline bg-canvas border-l-3 ${borderColor[severity] || "border-l-severity-info"} p-4`}>
      <div className="mb-1 flex items-center gap-2">
        <span className={`inline-block rounded-pill px-2.5 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wider bg-severity-${severity}-subtle text-severity-${severity}`}>{severity}</span>
        <span className="font-semibold">{content.title as string}</span>
      </div>
      <p className="text-sm text-ink-secondary">{content.location as string} — 置信度: {String(Math.round((content.confidence as number || 0) * 100))}%</p>
    </div>
  );
}

function SystemNotice({ content }: { content: Record<string, unknown> }) {
  return <div className="my-2 text-center text-xs text-ink-muted">{content.text as string}</div>;
}

export default function MessageRenderer({ message }: { message: Message }) {
  const { role, msg_type, content } = message;

  if (role === "system") return <SystemNotice content={content} />;

  if (role === "user") {
    return (
      <div className="my-2 flex justify-end">
        <div className="max-w-[70%] rounded-2xl bg-surface-default px-4 py-2.5 text-sm">{content.text as string}</div>
      </div>
    );
  }

  // Agent messages
  switch (msg_type) {
    case "tool_call": return <ToolCallCard content={content} />;
    case "vuln_card": return <VulnCard content={content} />;
    case "asset_card": return <div className="my-2 rounded-md border border-hairline bg-canvas p-3 text-sm">🖥 {content.address as string} — 端口: {JSON.stringify(content.open_ports)}</div>;
    case "status": return <div className="my-2 text-center text-xs text-ink-muted">{content.text as string}</div>;
    case "text":
    default:
      return <div className="my-2 text-sm leading-relaxed">{content.text as string}</div>;
  }
}
