import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Eye } from "lucide-react";
import { authFetch } from "../lib/api";
import {
  accessCount,
  filterIntelRows,
  hangLabel,
  intelStatus,
  isIntelNew,
  type IntelRow,
  type IntelStatus,
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
  const [accessById, setAccessById] = useState<Record<string, number>>({});
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
                <IntelAccessMark
                  count={accessById[String(row.id || "")] ?? accessCount(row)}
                  className="mt-0.5 shrink-0"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
      {opened ? (
        <IntelDetailDialog
          row={opened}
          currentTaskId={currentTaskId}
          accessCountOverride={accessById[String(opened.id || "")]}
          onAccessed={(next) => {
            const id = String(next.id || opened.id || "").trim();
            if (!id) return;
            setAccessById((prev) => ({ ...prev, [id]: accessCount(next) }));
            setOpened(next);
          }}
          onClose={() => setOpened(null)}
        />
      ) : null}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  credential_status: "AUTH",
  secret: "SECRET",
  token: "TOKEN",
  flag: "FLAG",
  path_hint: "PATH",
  account: "ACCOUNT",
  config: "CONFIG",
};

const KIND_CHIP: Record<string, string> = {
  credential_status: "bg-canvas-inset text-ink-secondary",
  secret: "bg-key-secret-subtle text-key-secret",
  token: "bg-key-token-subtle text-key-token",
  flag: "bg-status-success-subtle text-status-success",
  path_hint: "bg-canvas-inset text-ink-secondary",
  account: "bg-canvas-inset text-ink-secondary",
  config: "bg-canvas-inset text-ink-secondary",
};

const STATUS_STEPS: Array<{ id: IntelStatus; label: string }> = [
  { id: "active", label: "在用" },
  { id: "forgotten", label: "已遗忘" },
  { id: "sealed", label: "遗忘区" },
];

function kindLabel(kind: unknown): string {
  const raw = String(kind || "").trim();
  return KIND_LABEL[raw] || raw.toUpperCase() || "NOTE";
}

function kindChipClass(kind: unknown): string {
  return KIND_CHIP[String(kind || "").trim()] || "bg-canvas-inset text-ink-secondary";
}

function isSecretKind(kind: unknown): boolean {
  return ["secret", "token", "flag"].includes(String(kind || "").trim());
}

function sourceLabel(source: unknown): string {
  const raw = String(source || "").trim().toLowerCase();
  if (raw === "user") return "操作者";
  if (raw === "agent") return "Agent";
  return raw || "—";
}

function formatIntelTime(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.slice(0, 19).replace("T", " ");
}

function IntelAccessMark({ count, className = "" }: { count: number; className?: string }) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] tabular-nums text-ink-muted ${className}`.trim()}
      data-testid="intel-access-count"
      title={`访问 ${n} 次`}
    >
      <Eye size={13} strokeWidth={1.75} aria-hidden />
      <span className="font-mono">{n}</span>
    </span>
  );
}

function IntelDetailDialog({
  row,
  currentTaskId,
  accessCountOverride,
  onAccessed,
  onClose,
}: {
  row: IntelRow;
  currentTaskId?: string | null;
  accessCountOverride?: number;
  onAccessed?: (row: IntelRow) => void;
  onClose: () => void;
}) {
  const [full, setFull] = useState<IntelRow>(row);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(Boolean(row.body));

  useEffect(() => {
    const id = String(row.id || "").trim();
    if (!id) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    setLoaded(Boolean(row.body));
    authFetch<{ intel?: IntelRow }>(`/api/intel/${encodeURIComponent(id)}`)
      .then((data) => {
        if (cancelled) return;
        if (data.intel) {
          setFull(data.intel);
          onAccessed?.(data.intel);
        }
        setLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "加载失败");
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [row.id, row.body]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  const kind = full.kind || row.kind;
  const status = intelStatus(full);
  const hang = hangLabel(full) || hangLabel(row);
  const summary = String(full.summary || row.summary || "").trim() || "Untitled clue";
  const body = String(full.body || "").trim();
  const secret = isSecretKind(kind);
  const stamp = formatIntelTime(full.updated_at || full.created_at || row.updated_at || row.created_at);
  const recordId = String(full.id || row.id || "").trim();
  const isNew = isIntelNew(full, currentTaskId) || isIntelNew(row, currentTaskId);

  // Body portal: RightPanel keeps a transform from enter animation, which would
  // otherwise trap position:fixed inside the panel.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center theme-overlay px-4" onClick={onClose}>
      <div
        className="max-h-[88vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-hairline-soft bg-canvas p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="intel-detail"
        role="dialog"
        aria-modal="true"
        aria-labelledby="intel-detail-title"
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className={`inline-block shrink-0 rounded-md px-2.5 py-0.5 font-mono text-[11px] font-medium uppercase ${kindChipClass(kind)}`}>
                {kindLabel(kind)}
              </span>
              {isNew ? (
                <span className="inline-block shrink-0 rounded-md bg-status-success/15 px-2.5 py-0.5 font-mono text-[11px] font-medium uppercase text-status-success">
                  New
                </span>
              ) : null}
              <h2
                id="intel-detail-title"
                className={`min-w-0 break-words text-xl font-semibold ${secret ? "font-mono" : ""}`}
              >
                {summary}
              </h2>
              <IntelAccessMark
                count={accessCountOverride ?? accessCount(full)}
                className="ml-0.5"
              />
            </div>
            {!loaded && !error ? <p className="mt-1 text-xs text-ink-muted">Loading...</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex-shrink-0 rounded-md border border-hairline px-3 py-1.5 text-xs hover:bg-surface-default"
          >
            关闭
          </button>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          {STATUS_STEPS.map((step) => (
            <span
              key={step.id}
              className={`rounded-md border px-2.5 py-1 text-[11px] font-medium ${
                step.id === status
                  ? "border-ink bg-ink text-on-ink"
                  : "border-hairline text-ink-secondary"
              }`}
            >
              {step.label}
            </span>
          ))}
        </div>

        {error ? (
          <div className="mb-4 rounded-md border border-severity-critical/30 bg-severity-critical-subtle px-3 py-2 text-sm text-severity-critical">
            {error}
          </div>
        ) : null}

        <section className="mt-1">
          <h3 className="mb-2 text-xs font-semibold uppercase text-ink-secondary">Description</h3>
          {secret && body ? (
            <div
              className={`rounded-md border px-3 py-2.5 ${
                kind === "flag"
                  ? "border-status-success/30 bg-status-success/10"
                  : "border-status-running/25 bg-status-running/10"
              }`}
            >
              <p
                className={`text-[10px] font-semibold uppercase tracking-wide ${
                  kind === "flag" ? "text-status-success" : "text-status-running"
                }`}
              >
                {kindLabel(kind)}
              </p>
              <p className="mt-1 break-all whitespace-pre-wrap font-mono text-sm font-semibold text-ink">{body}</p>
            </div>
          ) : (
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-secondary">
              {body || (loaded ? "—" : "Loading...")}
            </p>
          )}
        </section>

        <section className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase text-ink-secondary">Location</h3>
          <p className="break-all font-mono text-sm leading-relaxed text-ink-secondary">
            {hang || "—"}
          </p>
        </section>

        <section className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase text-ink-secondary">Record</h3>
          <p className="break-all font-mono text-sm leading-relaxed text-ink-secondary">
            {[recordId || "—", sourceLabel(full.source || row.source), stamp].filter(Boolean).join(" · ")}
          </p>
        </section>
      </div>
    </div>,
    document.body,
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
