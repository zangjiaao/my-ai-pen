export default function ConfirmCard({ content, onAuthorize, onCancel }: { content: Record<string, unknown>; onAuthorize: () => void; onCancel: () => void }) {
  return (
    <div className="my-2 rounded-2xl border border-hairline bg-surface-elevated p-5">
      <p className="mb-2 text-sm font-medium">需要你的确认</p>
      <p className="mb-1 text-xs text-ink-muted">风险等级: {content.risk_level as string}</p>
      <p className="mb-3 text-sm">{content.question as string}</p>
      <div className="flex gap-2">
        <button data-testid="confirm-authorize" onClick={onAuthorize} className="rounded-pill bg-ink px-4 py-2 text-sm font-medium text-white">授权执行</button>
        <button data-testid="confirm-cancel" onClick={onCancel} className="rounded-pill border border-hairline bg-canvas px-4 py-2 text-sm text-ink">取消</button>
      </div>
    </div>
  );
}