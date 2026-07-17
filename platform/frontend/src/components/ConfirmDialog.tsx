interface Props {
  open: boolean;
  title: string;
  description: string;
  onConfirm: () => void;
  onCancel: () => void;
  error?: string | null;
  /** Disable buttons and show progress label while work is in flight. */
  busy?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
}

export default function ConfirmDialog({
  open,
  title,
  description,
  onConfirm,
  onCancel,
  error,
  busy = false,
  confirmLabel = "删除",
  cancelLabel = "取消",
}: Props) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div className="w-[400px] rounded-3xl border border-hairline-soft bg-canvas p-6 shadow-lg" onClick={e => e.stopPropagation()}>
        <h3 className="mb-2 text-lg font-semibold">{title}</h3>
        <p className="mb-4 whitespace-pre-line text-sm text-ink-secondary">{description}</p>
        {error && <p className="mb-4 rounded-md border border-severity-critical/30 bg-severity-critical/10 px-3 py-2 text-sm text-severity-critical">{error}</p>}
        <div className="flex justify-end gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-pill border border-hairline bg-canvas px-4 py-2 text-sm text-ink transition-colors hover:bg-surface-default disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="rounded-pill bg-severity-critical px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "处理中…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
