export default function SummaryCard({ content }: { content: Record<string, unknown> }) {
  return (
    <div className="my-2 rounded-md bg-surface-default p-4 text-sm">
      <p className="mb-2 font-medium">📋 阶段摘要</p>
      <div className="grid grid-cols-3 gap-3 text-center">
        <div><p className="text-lg font-semibold">{String(content.hosts_found || 0)}</p><p className="text-xs text-ink-muted">主机</p></div>
        <div><p className="text-lg font-semibold">{String(content.ports_open || 0)}</p><p className="text-xs text-ink-muted">端口</p></div>
        <div><p className="text-lg font-semibold">{String(content.vulns_found || 0)}</p><p className="text-xs text-ink-muted">漏洞</p></div>
      </div>
    </div>
  );
}
