import { Fragment, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";
import PageToolbarSkeleton from "../components/PageToolbarSkeleton";
import { authFetch } from "../lib/api";
import { useRenderAudit } from "../lib/renderAudit";

const ALL = "all";

const CATEGORIES: { value: string; label: string }[] = [
  { value: ALL, label: "全部类型" },
  { value: "auth", label: "认证" },
  { value: "conversation", label: "会话" },
  { value: "node", label: "节点" },
  { value: "asset", label: "资产" },
  { value: "vulnerability", label: "漏洞" },
  { value: "sync", label: "同步" },
];

const STATUSES: { value: string; label: string }[] = [
  { value: ALL, label: "全部结果" },
  { value: "success", label: "成功" },
  { value: "failed", label: "失败" },
];

type AuditLog = {
  id: string;
  timestamp: string;
  actor_type: string;
  actor_id: string;
  actor_name?: string | null;
  actor_display: string;
  action: string;
  action_label: string;
  resource_type?: string | null;
  resource_type_label?: string | null;
  resource_id?: string | null;
  resource_label?: string | null;
  conversation_id?: string | null;
  status: string;
  status_label: string;
  summary: string;
  detail: Record<string, unknown>;
};

const AUDIT_TABLE_CONTAINER_CLASS =
  "overflow-hidden rounded-md border border-hairline-soft bg-surface-raised";
const AUDIT_TABLE_CLASS = "w-full table-fixed";
const AUDIT_ROW_CLASS = "border-b border-hairline-soft text-sm";

function AuditTableSkeletonRows() {
  return (
    <>
      {[72, 58, 84, 66, 78, 62].map((resourceWidth, index) => (
        <tr key={index} aria-hidden="true" className={`${AUDIT_ROW_CLASS} h-[3.25rem]`}>
          <td className="px-4 py-2.5"><div className="h-3 w-28 rounded-full bg-canvas-inset" /></td>
          <td className="px-4 py-2.5"><div className="h-3 w-20 rounded-full bg-canvas-inset" /></td>
          <td className="px-4 py-2.5"><div className="h-3 w-24 rounded-full bg-canvas-inset" /></td>
          <td className="px-4 py-2.5">
            <div className="space-y-2">
              <div
                className="h-3 rounded-full bg-canvas-inset"
                style={{ width: `${resourceWidth}%` }}
              />
              <div className="h-2.5 w-24 rounded-full bg-canvas-inset" />
            </div>
          </td>
          <td className="px-4 py-2.5"><div className="h-5 w-14 rounded-md bg-canvas-inset" /></td>
          <td className="px-2 py-2.5"><div className="mx-auto h-4 w-4 rounded bg-canvas-inset" /></td>
        </tr>
      ))}
    </>
  );
}

export default function AuditPage() {
  useRenderAudit("AuditPage");
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [category, setCategory] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const [loading, setLoading] = useState(true);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const params = useMemo(() => {
    const p = new URLSearchParams();
    p.set("limit", "100");
    p.set("scope", "system");
    if (category !== ALL) p.set("category", category);
    if (status !== ALL) p.set("status", status);
    return p;
  }, [category, status]);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const auditRows = await authFetch<AuditLog[]>(`/api/audit?${params}`);
      setLogs(auditRows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作审计加载失败");
    } finally {
      setLoading(false);
      setInitialLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [params.toString()]);

  const toggle = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="flex h-screen bg-canvas">
      <Sidebar activeId={null} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar title="操作审计" />
        <main className="flex-1 overflow-y-auto p-6">
          {initialLoading ? (
            <PageToolbarSkeleton
              controls={[112, 112]}
              trailingWidth={76}
              label="正在加载审计操作栏"
              testId="audit-toolbar-loading-skeleton"
            />
          ) : (
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              className="rounded-md border border-hairline bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-ink"
            >
              {CATEGORIES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="rounded-md border border-hairline bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-ink"
            >
              {STATUSES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                void load();
              }}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-ink px-4 py-2 text-sm font-medium text-on-ink"
            >
              <RefreshCw className="h-4 w-4" />
              刷新
            </button>
          </div>
          )}

          {error && (
            <div className="mb-4 rounded-md border border-severity-critical/30 bg-severity-critical-subtle px-4 py-3 text-sm text-severity-critical">
              {error}
            </div>
          )}

          <div
            className={`${AUDIT_TABLE_CONTAINER_CLASS} ${loading && logs.length === 0 ? "animate-pulse" : ""}`}
            data-testid={loading && logs.length === 0 ? "audit-loading-skeleton" : undefined}
            role={loading && logs.length === 0 ? "status" : undefined}
            aria-label={loading && logs.length === 0 ? "正在加载操作审计" : undefined}
          >
            <table className={AUDIT_TABLE_CLASS}>
              <thead>
                <tr className="border-b border-hairline bg-surface-default text-left text-xs font-medium text-ink-secondary">
                  <th className="w-40 px-4 py-2.5">时间</th>
                  <th className="w-36 px-4 py-2.5">操作人</th>
                  <th className="w-36 px-4 py-2.5">操作</th>
                  <th className="px-4 py-2.5">对象</th>
                  <th className="w-24 px-4 py-2.5">结果</th>
                  <th className="w-12 px-2 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => {
                  const open = Boolean(expanded[log.id]);
                  const hasDetail = log.detail && Object.keys(log.detail).length > 0;
                  return (
                    <Fragment key={log.id}>
                      <tr className={`${AUDIT_ROW_CLASS} hover:bg-surface-default`}>
                        <td className="px-4 py-2.5 text-xs text-ink-muted whitespace-nowrap">
                          {formatDate(log.timestamp)}
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="truncate text-sm text-ink" title={log.actor_display}>
                            {log.actor_display || "—"}
                          </div>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="truncate text-sm font-medium text-ink" title={log.action}>
                            {log.action_label || log.action}
                          </div>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="min-w-0">
                            <div className="truncate text-sm text-ink" title={log.resource_label || ""}>
                              {log.resource_label || "—"}
                            </div>
                            {(log.resource_type_label || log.resource_id) && (
                              <div className="mt-0.5 truncate text-[11px] text-ink-muted">
                                {[log.resource_type_label, log.resource_id ? shortId(log.resource_id) : null]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={`inline-block rounded-md px-2 py-0.5 text-xs ${statusClass(log.status)}`}>
                            {log.status_label || log.status}
                          </span>
                        </td>
                        <td className="px-2 py-2.5 text-center">
                          {hasDetail ? (
                            <button
                              type="button"
                              onClick={() => toggle(log.id)}
                              className="rounded p-1 text-ink-muted hover:bg-canvas-inset hover:text-ink"
                              aria-label={open ? "收起详情" : "展开详情"}
                            >
                              {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                      {open && hasDetail ? (
                        <tr className="border-b border-hairline-soft bg-canvas-inset/40">
                          <td colSpan={6} className="px-4 py-3">
                            <p className="mb-1.5 text-[11px] font-medium text-ink-muted">详情</p>
                            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-hairline-soft bg-canvas p-3 font-mono text-[11px] text-ink-secondary">
                              {JSON.stringify(log.detail, null, 2)}
                            </pre>
                            {log.summary && log.summary !== log.action_label ? (
                              <p className="mt-2 text-xs text-ink-muted">{log.summary}</p>
                            ) : null}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
                {!logs.length && (
                  loading ? (
                    <AuditTableSkeletonRows />
                  ) : (
                    <tr>
                      <td colSpan={6} className="px-4 py-10 text-center text-sm text-ink-muted">
                        暂无操作记录
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </div>
        </main>
      </div>
    </div>
  );
}

function shortId(value?: string | null): string {
  return value ? value.slice(0, 8) : "—";
}

function formatDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function statusClass(status: string): string {
  if (status === "success") return "bg-severity-low-subtle text-severity-low";
  if (status === "failed" || status === "error") return "bg-severity-critical-subtle text-severity-critical";
  if (status === "blocked") return "bg-severity-medium-subtle text-severity-medium";
  return "bg-canvas-inset text-ink-secondary";
}
