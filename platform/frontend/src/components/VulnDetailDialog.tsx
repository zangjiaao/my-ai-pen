interface Props { open: boolean; finding: Record<string, unknown> | null; onClose: () => void; }

export default function VulnDetailDialog({ open, finding, onClose }: Props) {
  if (!open || !finding) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-[640px] max-h-[80vh] overflow-y-auto rounded-3xl border border-hairline-soft bg-canvas p-8" onClick={e => e.stopPropagation()}>
        <h2 className="mb-4 text-xl font-semibold">{finding.title as string}</h2>
        <div className="mb-4 space-y-2 text-sm">
          <p><span className="text-ink-secondary">等级:</span> <span className={`rounded-pill px-2 py-0.5 font-mono text-[11px] font-medium uppercase bg-severity-${finding.severity}-subtle text-severity-${finding.severity}`}>{finding.severity as string}</span></p>
          <p><span className="text-ink-secondary">位置:</span> {finding.location as string}</p>
          <p><span className="text-ink-secondary">置信度:</span> {String(Math.round((finding.confidence as number || 0) * 100))}%</p>
        </div>
        <div className="space-y-4">
          <div><h3 className="mb-1 text-sm font-medium">发现过程</h3><p className="text-sm text-ink-secondary">{finding.description as string || "暂无"}</p></div>
          <div><h3 className="mb-1 text-sm font-medium">复现步骤</h3><pre className="rounded-sm bg-canvas-inset p-3 font-mono text-[13px]">{finding.poc as string || "暂无"}</pre></div>
          <div><h3 className="mb-1 text-sm font-medium">修复建议</h3><p className="text-sm text-ink-secondary">{finding.remediation as string || "暂无"}</p></div>
        </div>
        <button onClick={onClose} className="mt-6 rounded-pill border border-hairline px-4 py-2 text-sm">关闭</button>
      </div>
    </div>
  );
}
