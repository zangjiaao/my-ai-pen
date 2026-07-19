import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Download, FileText, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { authDownload, authFetch } from "../lib/api";

type ReportMeta = {
  id: string;
  title: string;
  summary?: string;
  source?: string;
  created_by?: string;
  created_at?: string | null;
  finding_count?: number;
  markdown_chars?: number;
};

type Props = {
  conversationId: string;
};

function formatWhen(iso?: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 19);
    return d.toLocaleString();
  } catch {
    return String(iso).slice(0, 19);
  }
}

export default function ReportDrawer({ conversationId }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [reports, setReports] = useState<ReportMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [formatById, setFormatById] = useState<Record<string, "markdown" | "html">>({});
  const [downloading, setDownloading] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    if (!conversationId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await authFetch<{ reports?: ReportMeta[] }>(
        `/api/reports/conversations/${conversationId}/revisions`,
      );
      setReports(Array.isArray(data.reports) ? data.reports : []);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "加载报告列表失败";
      setError(msg);
      setReports([]);
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => {
      const el = panelRef.current;
      if (el && !el.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const quickLedger = async () => {
    setCreating(true);
    setError(null);
    try {
      await authFetch(`/api/reports/conversations/${conversationId}/revisions`, {
        method: "POST",
        body: JSON.stringify({ source: "ledger", title: undefined }),
      });
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "快速生成失败");
    } finally {
      setCreating(false);
    }
  };

  const download = async (report: ReportMeta) => {
    const fmt = formatById[report.id] || "markdown";
    setDownloading(report.id);
    try {
      const { blob, filename } = await authDownload(
        `/api/reports/conversations/${conversationId}/revisions/${report.id}?format=${fmt}`,
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename || `${report.title || "report"}.${fmt === "html" ? "html" : "md"}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "下载失败");
    } finally {
      setDownloading(null);
    }
  };

  const remove = async (report: ReportMeta) => {
    const label = report.title || "该报告";
    if (!window.confirm(`确定删除报告「${label}」？此操作不可恢复。`)) return;
    setDeleting(report.id);
    setError(null);
    try {
      await authFetch(`/api/reports/conversations/${conversationId}/revisions/${report.id}`, {
        method: "DELETE",
      });
      setReports((prev) => prev.filter((r) => r.id !== report.id));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "删除失败");
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        data-testid="report-drawer-toggle"
        title="检测报告（可多份）"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-md border border-hairline px-2.5 py-1.5 text-xs text-ink-secondary transition-colors hover:bg-surface-default hover:text-ink"
      >
        <FileText size={13} />
        报告
        {reports.length > 0 && open ? (
          <span className="rounded bg-canvas-inset px-1 font-mono text-[10px]">{reports.length}</span>
        ) : null}
        <ChevronDown size={12} className={open ? "rotate-180 transition-transform" : "transition-transform"} />
      </button>

      {open && (
        <div
          data-testid="report-drawer-panel"
          className="absolute right-0 top-full z-50 mt-1 w-[min(420px,92vw)] overflow-hidden rounded-lg border border-hairline bg-canvas shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-hairline px-3 py-2">
            <div className="text-xs font-medium text-ink">检测报告</div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                title="刷新列表"
                onClick={() => void load()}
                className="rounded p-1 text-ink-muted hover:bg-surface-default hover:text-ink"
              >
                <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
              </button>
              <button
                type="button"
                title="从已确认漏洞快速合成一份草稿（不含 Agent 润色）"
                disabled={creating}
                onClick={() => void quickLedger()}
                className="inline-flex items-center gap-1 rounded border border-hairline px-1.5 py-0.5 text-[11px] text-ink-secondary hover:bg-surface-default disabled:opacity-50"
              >
                {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                快速合成
              </button>
            </div>
          </div>

          <div className="max-h-[360px] overflow-y-auto px-2 py-2">
            {error && (
              <p className="mb-2 rounded bg-severity-critical-subtle px-2 py-1 text-[11px] text-severity-critical">{error}</p>
            )}
            {loading && reports.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-ink-muted">加载中…</p>
            ) : reports.length === 0 ? (
              <div className="px-2 py-4 text-xs leading-relaxed text-ink-secondary">
                <p className="mb-2 font-medium text-ink">尚无报告版本</p>
                <p>
                  在对话中说明需要<strong>漏洞报告 / 检测报告</strong>，工作台助手或专家会根据已确认漏洞生成并保存到此处。
                </p>
                <p className="mt-2 text-ink-muted">也可点右上角「快速合成」仅用台账字段生成草稿。</p>
              </div>
            ) : (
              <ul className="space-y-2">
                {reports.map((r) => {
                  const fmt = formatById[r.id] || "markdown";
                  return (
                    <li
                      key={r.id}
                      className="rounded-md border border-hairline bg-canvas-inset/40 px-2.5 py-2"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium text-ink" title={r.title}>
                          {r.title || "未命名报告"}
                        </div>
                        <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-ink-muted">
                          <span>{formatWhen(r.created_at)}</span>
                          {r.source ? <span>· {r.source}</span> : null}
                          {typeof r.finding_count === "number" ? (
                            <span>· {r.finding_count} findings</span>
                          ) : null}
                          {r.created_by ? <span>· {r.created_by}</span> : null}
                        </div>
                        {r.summary ? (
                          <p className="mt-1 line-clamp-2 text-[11px] text-ink-secondary">{r.summary}</p>
                        ) : null}
                      </div>
                      <div className="mt-2 flex items-center justify-end gap-2">
                        <select
                          aria-label="下载格式"
                          value={fmt}
                          onChange={(e) =>
                            setFormatById((prev) => ({
                              ...prev,
                              [r.id]: e.target.value === "html" ? "html" : "markdown",
                            }))
                          }
                          className="rounded border border-hairline bg-canvas px-1.5 py-1 text-[11px] text-ink"
                        >
                          <option value="markdown">Markdown</option>
                          <option value="html">HTML</option>
                        </select>
                        <button
                          type="button"
                          disabled={downloading === r.id}
                          onClick={() => void download(r)}
                          className="inline-flex items-center gap-1 rounded-md border border-hairline bg-canvas px-2 py-1 text-[11px] text-ink-secondary hover:text-ink disabled:opacity-50"
                        >
                          {downloading === r.id ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Download size={12} />
                          )}
                          下载
                        </button>
                        <button
                          type="button"
                          data-testid="report-delete"
                          title="删除此报告"
                          disabled={deleting === r.id}
                          onClick={() => void remove(r)}
                          className="inline-flex items-center gap-1 rounded-md border border-hairline bg-canvas px-2 py-1 text-[11px] text-severity-critical hover:bg-severity-critical-subtle disabled:opacity-50"
                        >
                          {deleting === r.id ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Trash2 size={12} />
                          )}
                          删除
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
