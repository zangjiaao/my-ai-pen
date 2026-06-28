export default function AttackChainCard({ content }: { content: Record<string, unknown> }) {
  const nodes = content.nodes as Array<Record<string, unknown>> || [];
  return (
    <div className="my-2 rounded-2xl border border-hairline bg-canvas p-5">
      <p className="mb-2 text-sm font-semibold">🔗 {content.chain_title as string}</p>
      <div className="space-y-2">
        {nodes.map((n, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className={`inline-block rounded-pill px-2 py-0.5 font-mono text-[11px] font-medium bg-severity-${n.severity}-subtle text-severity-${n.severity}`}>{n.severity as string}</span>
            <span className="text-sm">{n.title as string}</span>
            {i < nodes.length - 1 && <span className="text-xs text-ink-muted">↓</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
