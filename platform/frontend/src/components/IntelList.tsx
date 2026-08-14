import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/api";
import {
  filterIntelRows,
  hangLabel,
  isIntelNew,
  type IntelRow,
} from "../lib/intelView";

type Filter = "active" | "forgotten" | "sealed";

export function IntelList({
  rows,
  currentTaskId,
  emptyCopy,
  showHang = false,
  showArchive = true,
}: {
  rows: IntelRow[];
  currentTaskId?: string | null;
  emptyCopy: string;
  showHang?: boolean;
  showArchive?: boolean;
}) {
  const [filter, setFilter] = useState<Filter>("active");
  const [opened, setOpened] = useState<IntelRow | null>(null);
  const living = useMemo(() => filterIntelRows(rows, "active"), [rows]);
  const forgotten = useMemo(() => filterIntelRows(rows, "forgotten"), [rows]);
  const sealed = useMemo(() => filterIntelRows(rows, "sealed"), [rows]);
  const visible = filter === "active" ? living : filter === "forgotten" ? forgotten : sealed;

  return (
    <div className="space-y-3" data-testid="intel-list">
      {showArchive ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="intel-filter-active"
            onClick={() => setFilter("active")}
            className={`rounded-md px-2 py-1 text-[11px] ${filter === "active" ? "bg-canvas-inset text-ink" : "text-ink-muted hover:text-ink"}`}
          >
            线索 ({living.length})
          </button>
          <button
            type="button"
            data-testid="intel-filter-forgotten"
            onClick={() => setFilter("forgotten")}
            className={`rounded-md px-2 py-1 text-[11px] ${filter === "forgotten" ? "bg-canvas-inset text-ink" : "text-ink-muted hover:text-ink"}`}
          >
            已遗忘 ({forgotten.length})
          </button>
          <button
            type="button"
            data-testid="intel-filter-sealed"
            onClick={() => setFilter("sealed")}
            className={`rounded-md px-2 py-1 text-[11px] ${filter === "sealed" ? "bg-canvas-inset text-ink" : "text-ink-muted hover:text-ink"}`}
          >
            遗忘区 ({sealed.length})
          </button>
        </div>
      ) : null}
      {!visible.length ? (
        <p className="text-sm text-ink-muted" data-testid="intel-empty">
          {filter === "forgotten" ? "没有已遗忘的线索。" : filter === "sealed" ? "遗忘区是空的。" : emptyCopy}
        </p>
      ) : (
        <ul className="space-y-2">
          {visible.map((row) => (
            <li key={String(row.id)}>
              <button
                type="button"
                data-testid={`intel-row-${row.id}`}
                onClick={() => setOpened(row)}
                className="flex w-full items-start justify-between gap-2 rounded-md border border-hairline-soft px-2.5 py-2 text-left hover:bg-canvas-inset/60"
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5">
                    {isIntelNew(row, currentTaskId) && filter === "active" ? (
                      <span className="inline-block shrink-0 rounded-md bg-status-success/15 px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase text-status-success">
                        New
                      </span>
                    ) : null}
                    <span className="truncate text-sm text-ink">{row.summary || "(无摘要)"}</span>
                  </span>
                  <span className="mt-0.5 block font-mono text-[11px] text-ink-muted">
                    {row.id ? `${row.id} · ` : ""}
                    {row.kind || "config"}
                    {showHang && hangLabel(row) ? ` · ${hangLabel(row)}` : ""}
                    {row.port && !showHang ? ` · :${row.port}` : ""}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {opened ? <IntelDetailDialog row={opened} onClose={() => setOpened(null)} /> : null}
    </div>
  );
}

function IntelDetailDialog({ row, onClose }: { row: IntelRow; onClose: () => void }) {
  const [full, setFull] = useState<IntelRow>(row);
  const [error, setError] = useState("");

  useEffect(() => {
    const id = String(row.id || "").trim();
    if (!id) return;
    let cancelled = false;
    authFetch<{ intel?: IntelRow }>(`/api/intel/${encodeURIComponent(id)}`)
      .then((data) => {
        if (!cancelled && data.intel) setFull(data.intel);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [row.id]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center theme-overlay px-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-lg border border-hairline-soft bg-canvas p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="intel-detail"
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-wide text-ink-muted">线索</p>
            <h3 className="text-sm font-semibold text-ink">{full.summary || row.summary}</h3>
            <p className="mt-1 font-mono text-[11px] text-ink-muted">
              {full.kind || row.kind} · {hangLabel(full) || hangLabel(row) || "Host"}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md border border-hairline px-3 py-1.5 text-xs">
            关闭
          </button>
        </div>
        {error ? <p className="text-sm text-severity-critical">{error}</p> : null}
        <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-canvas-inset p-3 text-[12px] text-ink">
          {full.body || "（无正文）"}
        </pre>
      </div>
    </div>
  );
}

export function useAssetIntel(assetId: string | null | undefined, port?: string | null) {
  const [rows, setRows] = useState<IntelRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const id = String(assetId || "").trim();
    if (!id) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const qs = new URLSearchParams({ asset_id: id, status: "all", limit: "100" });
    if (port) qs.set("port", String(port));
    authFetch<{ intel?: IntelRow[] }>(`/api/intel?${qs.toString()}`)
      .then((data) => {
        if (!cancelled) setRows(Array.isArray(data.intel) ? data.intel : []);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [assetId, port]);

  return { rows, loading };
}
