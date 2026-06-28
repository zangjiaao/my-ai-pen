export default function AssetCard({ content }: { content: Record<string, unknown> }) {
  const ports = content.open_ports as number[] || [];
  const services = content.services as Array<Record<string, unknown>> || [];
  return (
    <div className="my-2 rounded-md border border-hairline bg-canvas p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm font-medium">{content.is_new ? "🖥 发现新资产" : "🖥 资产更新"}</span>
        <span className="font-mono text-xs text-ink-muted">{content.address as string}</span>
      </div>
      {ports.length > 0 && <p className="mb-1 text-sm text-ink-secondary">开放端口: {ports.join(", ")}</p>}
      {services.length > 0 && (
        <div className="space-y-0.5 text-sm text-ink-secondary">
          {services.map((s, i) => <p key={i}>· {s.port as number}/tcp — {s.name as string} {s.version as string || ""}</p>)}
        </div>
      )}
    </div>
  );
}
