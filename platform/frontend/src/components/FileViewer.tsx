interface Props { open: boolean; filePath: string; content: string; onClose: () => void; }

export default function FileViewer({ open, filePath, content, onClose }: Props) {
  if (!open) return null;
  const ext = filePath.split(".").pop() || "";
  const lang = { py: "python", ts: "typescript", tsx: "tsx", js: "javascript", json: "json", yaml: "yaml", yml: "yaml", md: "markdown", sh: "bash", txt: "text" }[ext] || "text";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-[800px] max-h-[80vh] flex flex-col rounded-3xl border border-hairline-soft bg-canvas" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-hairline-soft px-6 py-3">
          <span className="font-mono text-sm">{filePath}</span>
          <button onClick={onClose} className="rounded-pill border px-3 py-1 text-sm">关闭</button>
        </div>
        <pre className="flex-1 overflow-auto bg-canvas-inset p-4 font-mono text-[13px] leading-relaxed">{content}</pre>
      </div>
    </div>
  );
}
