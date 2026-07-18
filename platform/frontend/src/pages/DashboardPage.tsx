/**
 * Operations status board — not the product home.
 * Home remains conversation (Agent). Sidebar entry above 资产管理.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";
import { authFetch } from "../lib/api";

type RecentFinding = {
  id: string;
  title: string;
  severity: string;
  status: string;
  status_label: string;
  discovered_at?: string | null;
  conversation_id?: string | null;
};

type Summary = {
  assets_total: number;
  conversations_total: number;
  nodes_online: number;
  nodes_total: number;
  vulns_total: number;
  by_status: Record<string, number>;
  by_severity: Record<string, number>;
  open_total: number;
  recent_findings: RecentFinding[];
};

const SEV_ORDER = ["critical", "high", "medium", "low", "info"] as const;
const SEV_LABEL: Record<string, string> = {
  critical: "CRITICAL",
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
  info: "INFO",
};
const SEV_CLASS: Record<string, string> = {
  critical: "bg-severity-critical-subtle text-severity-critical",
  high: "bg-severity-high-subtle text-severity-high",
  medium: "bg-severity-medium-subtle text-severity-medium",
  low: "bg-severity-low-subtle text-severity-low",
  info: "bg-canvas-inset text-ink-secondary",
};
const STATUS_LABEL: Record<string, string> = {
  to_fix: "待修复",
  fixing: "修复中",
  fixed: "已修复",
};

export default function DashboardPage() {
  const navigate = useNavigate();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await authFetch<Summary>("/api/dashboard/summary");
        if (!cancelled) setSummary(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "加载失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex h-screen bg-canvas">
      <Sidebar activeId={null} onSelect={() => {}} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar title="状态看板" />
        <main className="flex-1 overflow-y-auto p-6">
          <div className="mb-6 max-w-5xl">
            <h1 className="text-lg font-semibold tracking-tight text-ink">状态看板</h1>
            <p className="mt-1 text-sm text-ink-secondary">
              台账透视：漏洞与资产概况。日常工作请从左侧会话进入 Agent。
            </p>
          </div>

          {loading && <p className="text-sm text-ink-muted">加载中…</p>}
          {error && (
            <div className="mb-4 max-w-xl rounded-md bg-severity-critical-subtle px-4 py-3 text-sm text-severity-critical">
              {error}
            </div>
          )}

          {summary && !loading && (
            <div className="mx-auto max-w-5xl space-y-6">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Kpi
                  label="待处理漏洞"
                  value={summary.open_total}
                  hint="待修复 + 修复中"
                  onClick={() => navigate("/vulnerabilities?status=to_fix")}
                />
                <Kpi
                  label="漏洞总数"
                  value={summary.vulns_total}
                  onClick={() => navigate("/vulnerabilities")}
                />
                <Kpi
                  label="资产"
                  value={summary.assets_total}
                  onClick={() => navigate("/assets")}
                />
                <Kpi
                  label="在线节点"
                  value={summary.nodes_online}
                  hint={`共 ${summary.nodes_total} 个`}
                  onClick={() => navigate("/nodes")}
                />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <section className="rounded-lg border border-hairline bg-canvas p-4">
                  <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-ink-muted">
                    生命周期
                  </h2>
                  <div className="space-y-2">
                    {(["to_fix", "fixing", "fixed"] as const).map((st) => {
                      const n = summary.by_status?.[st] ?? 0;
                      const total = summary.vulns_total || 1;
                      const pct = Math.round((n / total) * 100);
                      return (
                        <button
                          key={st}
                          type="button"
                          onClick={() => navigate(`/vulnerabilities?status=${st}`)}
                          className="flex w-full items-center gap-3 rounded-md px-1 py-1.5 text-left hover:bg-canvas-inset"
                        >
                          <span className="w-16 shrink-0 text-xs text-ink-secondary">
                            {STATUS_LABEL[st]}
                          </span>
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-canvas-inset">
                            <div
                              className="h-full rounded-full bg-ink/70"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="w-8 text-right font-mono text-xs text-ink">{n}</span>
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section className="rounded-lg border border-hairline bg-canvas p-4">
                  <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-ink-muted">
                    严重级别
                  </h2>
                  <div className="flex flex-wrap gap-2">
                    {SEV_ORDER.map((sev) => {
                      const n = summary.by_severity?.[sev] ?? 0;
                      return (
                        <button
                          key={sev}
                          type="button"
                          onClick={() => navigate(`/vulnerabilities?severity=${sev}`)}
                          className={`inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium ${SEV_CLASS[sev]}`}
                        >
                          {SEV_LABEL[sev]}
                          <span className="font-mono opacity-80">{n}</span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              </div>

              <section className="rounded-lg border border-hairline bg-canvas">
                <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
                  <h2 className="text-xs font-medium uppercase tracking-wider text-ink-muted">
                    最近 finding
                  </h2>
                  <button
                    type="button"
                    onClick={() => navigate("/vulnerabilities")}
                    className="text-xs text-ink-secondary hover:text-ink"
                  >
                    全部漏洞 →
                  </button>
                </div>
                {summary.recent_findings.length === 0 ? (
                  <p className="px-4 py-8 text-center text-sm text-ink-muted">
                    暂无漏洞记录。在会话中完成测试并 booking 后会出现在这里。
                  </p>
                ) : (
                  <ul className="divide-y divide-hairline-soft">
                    {summary.recent_findings.map((f) => (
                      <li key={f.id}>
                        <button
                          type="button"
                          onClick={() => navigate(`/vulnerabilities?highlight=${f.id}`)}
                          className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-canvas-inset"
                        >
                          <span
                            className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase ${SEV_CLASS[f.severity] || SEV_CLASS.info}`}
                          >
                            {f.severity}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm text-ink">{f.title}</p>
                            <p className="mt-0.5 text-xs text-ink-muted">
                              {f.status_label}
                              {f.discovered_at
                                ? ` · ${new Date(f.discovered_at).toLocaleString()}`
                                : ""}
                            </p>
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => navigate("/")}
                  className="rounded-pill bg-ink px-4 py-2 text-sm font-medium text-white hover:opacity-90"
                >
                  回到会话
                </button>
                <button
                  type="button"
                  onClick={() => navigate("/assets")}
                  className="rounded-pill border border-hairline px-4 py-2 text-sm text-ink hover:bg-canvas-inset"
                >
                  资产管理
                </button>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function Kpi(props: {
  label: string;
  value: number;
  hint?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="rounded-lg border border-hairline bg-canvas p-4 text-left transition-colors hover:bg-canvas-inset"
    >
      <p className="text-[11px] font-medium uppercase tracking-wider text-ink-muted">{props.label}</p>
      <p className="mt-1 font-mono text-2xl font-semibold tracking-tight text-ink">{props.value}</p>
      {props.hint ? <p className="mt-1 text-xs text-ink-muted">{props.hint}</p> : null}
    </button>
  );
}
