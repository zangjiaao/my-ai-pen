export default function ScoreboardCard({ content }: { content: Record<string, unknown> }) {
  const evidence = (content.evidence as number) || 0;
  const reproducibility = (content.reproducibility as number) || 0;
  const coverage = (content.coverage as number) || 0;
  const overall = (content.overall as number) || 0;
  const bar = (val: number) => (
    <div className="h-1.5 flex-1 rounded-full bg-hairline">
      <div className="h-1.5 rounded-full bg-ink" style={{ width: `${Math.round(val * 100)}%` }} />
    </div>
  );
  return (
    <div className="my-2 rounded-md border border-hairline bg-surface-default p-4 text-sm">
      <p className="mb-2 font-medium">质量记分牌 — {content.phase as string} 阶段</p>
      <div className="space-y-1.5">
        <div className="flex items-center gap-2"><span className="w-20 text-xs text-ink-secondary">证据质量</span>{bar(evidence)}<span className="text-xs">{Math.round(evidence * 100)}%</span></div>
        <div className="flex items-center gap-2"><span className="w-20 text-xs text-ink-secondary">可复现性</span>{bar(reproducibility)}<span className="text-xs">{Math.round(reproducibility * 100)}%</span></div>
        <div className="flex items-center gap-2"><span className="w-20 text-xs text-ink-secondary">覆盖率</span>{bar(coverage)}<span className="text-xs">{Math.round(coverage * 100)}%</span></div>
      </div>
      <p className="mt-2 text-right font-semibold">{Math.round(overall)}/100</p>
    </div>
  );
}
