/**
 * Status board — full-width ops hub.
 *
 * Layout:
 *  1. KPI strip (small cards)
 *  2. 资产对应漏洞 | 新增漏洞信息 | 修复状态
 *  3. 节点信息 | 专家信息 | 任务
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bar, BarChart, Cell, XAxis, YAxis } from "recharts";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "../components/ui/chart";
import { authFetch } from "../lib/api";

type FindingItem = {
  id: string;
  title: string;
  severity: string;
  status: string;
  status_label: string;
  discovered_at?: string | null;
  conversation_id?: string | null;
  asset_id?: string | null;
};

type Summary = {
  vulnerabilities: {
    total: number;
    open_total: number;
    by_status: Record<string, number>;
    by_severity: Record<string, number>;
    recent: FindingItem[];
  };
  assets: {
    total: number;
    with_open_vulns: number;
    items: {
      id: string;
      name: string;
      address: string;
      type: string;
      open_vulns: number;
      total_vulns: number;
      highest_severity?: string | null;
      tags: string[];
      updated_at?: string | null;
    }[];
  };
  nodes: {
    total: number;
    online: number;
    offline: number;
    items: {
      id: string;
      name: string;
      status: string;
      type: string;
      current_sessions: number;
      last_heartbeat?: string | null;
      offers?: string[];
    }[];
  };
  experts: {
    total: number;
    items: {
      id: string;
      name: string;
      pack_id: string;
      node_id: string;
      node_name?: string | null;
      enabled: boolean;
    }[];
  };
  tasks: {
    total: number;
    by_status: Record<string, number>;
    running: number;
    recent: {
      id: string;
      title: string;
      status: string;
      working: boolean;
      last_active_at?: string | null;
      node_id?: string | null;
    }[];
  };
  schedules: {
    total: number;
    enabled: number;
    items: {
      id: string;
      target: string;
      engagement: string;
      interval_seconds: number;
      enabled: boolean;
      next_fire_at?: string | null;
    }[];
  };
  open_total?: number;
  vulns_total?: number;
  experts_total?: number;
  schedules_total?: number;
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
const STATUS_COLOR: Record<string, string> = {
  to_fix: "#d97706",
  fixing: "#2563eb",
  fixed: "#16a34a",
};
const TASK_STATUS_LABEL: Record<string, string> = {
  created: "已创建",
  running: "运行中",
  working: "工作中",
  busy: "忙碌",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  incomplete: "未完成",
};

const statusChartConfig = {
  count: { label: "数量", color: "#171717" },
  to_fix: { label: "待修复", color: STATUS_COLOR.to_fix },
  fixing: { label: "修复中", color: STATUS_COLOR.fixing },
  fixed: { label: "已修复", color: STATUS_COLOR.fixed },
} satisfies ChartConfig;

function formatWhen(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatInterval(sec: number): string {
  if (sec >= 86400 && sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec >= 3600 && sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec >= 60 && sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

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

  const byStatus = summary?.vulnerabilities?.by_status ?? {};
  const openTotal = summary?.vulnerabilities?.open_total ?? summary?.open_total ?? 0;
  const vulnsTotal = summary?.vulnerabilities?.total ?? summary?.vulns_total ?? 0;
  const recentFindings = summary?.vulnerabilities?.recent ?? [];

  const statusData = useMemo(
    () =>
      (["to_fix", "fixing", "fixed"] as const).map((st) => ({
        key: st,
        name: STATUS_LABEL[st],
        count: byStatus[st] ?? 0,
        fill: STATUS_COLOR[st],
      })),
    [byStatus],
  );

  return (
    <div className="flex h-screen bg-canvas">
      <Sidebar activeId={null} onSelect={() => {}} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar title="状态看板" />
        <main className="flex-1 overflow-y-auto p-6">
          {loading && <p className="text-sm text-ink-muted">加载中…</p>}
          {error && (
            <div className="mb-4 max-w-xl rounded-md bg-severity-critical-subtle px-4 py-3 text-sm text-severity-critical">
              {error}
            </div>
          )}

          {summary && !loading && (
            <div className="space-y-6">
              {/* 1. KPI strip */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <Kpi label="待处理漏洞" value={openTotal} onClick={() => navigate("/vulnerabilities?status=to_fix")} />
                <Kpi label="漏洞总数" value={vulnsTotal} onClick={() => navigate("/vulnerabilities")} />
                <Kpi label="资产" value={summary.assets?.total ?? 0} onClick={() => navigate("/assets")} />
                <Kpi
                  label="在线节点"
                  value={summary.nodes?.online ?? 0}
                  hint={`共 ${summary.nodes?.total ?? 0}`}
                  onClick={() => navigate("/nodes")}
                />
                <Kpi
                  label="专家"
                  value={summary.experts?.total ?? summary.experts_total ?? 0}
                  onClick={() => navigate("/experts")}
                />
                <Kpi
                  label="进行中任务"
                  value={summary.tasks?.running ?? 0}
                  hint={`会话 ${summary.tasks?.total ?? 0}`}
                  onClick={() => navigate("/")}
                />
              </div>

              {/* 2. 资产对应漏洞 | 新增漏洞 | 修复状态 */}
              <div className="grid gap-4 lg:grid-cols-3">
                <Card
                  title="资产对应漏洞"
                  meta={`${summary.assets?.with_open_vulns ?? 0} 个资产有待处理漏洞`}
                  actionLabel="资产"
                  onAction={() => navigate("/assets")}
                >
                  {(summary.assets?.items?.length ?? 0) === 0 ? (
                    <Empty>暂无资产</Empty>
                  ) : (
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-hairline text-xs text-ink-secondary">
                          <th className="pb-2 pr-2 font-medium">资产</th>
                          <th className="pb-2 pr-2 font-medium">开放</th>
                          <th className="pb-2 font-medium">最高</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-hairline-soft">
                        {summary.assets.items.map((a) => (
                          <tr
                            key={a.id}
                            className="cursor-pointer hover:bg-canvas-inset"
                            onClick={() => navigate("/assets")}
                          >
                            <td className="max-w-[10rem] truncate py-2 pr-2 font-mono text-xs" title={a.address}>
                              {a.address}
                            </td>
                            <td className="py-2 pr-2 font-mono text-xs">
                              {a.open_vulns}
                              <span className="text-ink-muted">/{a.total_vulns}</span>
                            </td>
                            <td className="py-2">
                              {a.highest_severity ? (
                                <span
                                  className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${SEV_CLASS[a.highest_severity] || SEV_CLASS.info}`}
                                >
                                  {a.highest_severity}
                                </span>
                              ) : (
                                <span className="text-xs text-ink-muted">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Card>

                <Card
                  title="新增漏洞信息"
                  meta={`最近 ${recentFindings.length} 条`}
                  actionLabel="漏洞"
                  onAction={() => navigate("/vulnerabilities")}
                >
                  {recentFindings.length === 0 ? (
                    <Empty>暂无新增漏洞</Empty>
                  ) : (
                    <ul className="divide-y divide-hairline-soft">
                      {recentFindings.slice(0, 8).map((f) => (
                        <li key={f.id}>
                          <button
                            type="button"
                            onClick={() => navigate(`/vulnerabilities?highlight=${f.id}`)}
                            className="flex w-full items-start gap-2 py-2 text-left hover:bg-canvas-inset"
                          >
                            <span
                              className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase ${SEV_CLASS[f.severity] || SEV_CLASS.info}`}
                            >
                              {f.severity}
                            </span>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm text-ink">{f.title}</p>
                              <p className="text-[11px] text-ink-muted">
                                {f.status_label}
                                {f.discovered_at ? ` · ${formatWhen(f.discovered_at)}` : ""}
                              </p>
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>

                <Card
                  title="修复状态"
                  meta={`待修复 ${byStatusCount(byStatus, "to_fix")} · 修复中 ${byStatusCount(byStatus, "fixing")} · 已修复 ${byStatusCount(byStatus, "fixed")}`}
                  actionLabel="漏洞"
                  onAction={() => navigate("/vulnerabilities")}
                >
                  <ChartContainer config={statusChartConfig} className="h-[220px] w-full aspect-auto">
                    <BarChart
                      data={statusData}
                      margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                      onClick={(state) => {
                        const key = (state?.activePayload?.[0]?.payload as { key?: string })?.key;
                        if (key) navigate(`/vulnerabilities?status=${key}`);
                      }}
                      style={{ cursor: "pointer" }}
                    >
                      <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "#8b8b8b" }} />
                      <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={28} tick={{ fontSize: 11, fill: "#8b8b8b" }} />
                      <ChartTooltip content={<ChartTooltipContent hideLabel nameKey="name" />} />
                      <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={48}>
                        {statusData.map((e) => (
                          <Cell key={e.key} fill={e.fill} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ChartContainer>
                </Card>
              </div>

              {/* 3. 节点 | 专家 | 任务 */}
              <div className="grid gap-4 lg:grid-cols-3">
                <Card
                  title="节点信息"
                  meta={`在线 ${summary.nodes?.online ?? 0} · 离线 ${summary.nodes?.offline ?? 0}`}
                  actionLabel="节点"
                  onAction={() => navigate("/nodes")}
                >
                  {(summary.nodes?.items?.length ?? 0) === 0 ? (
                    <Empty>暂无节点</Empty>
                  ) : (
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-hairline text-xs text-ink-secondary">
                          <th className="pb-2 pr-2 font-medium">名称</th>
                          <th className="pb-2 pr-2 font-medium">状态</th>
                          <th className="pb-2 font-medium">会话</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-hairline-soft">
                        {summary.nodes.items.map((n) => (
                          <tr
                            key={n.id}
                            className="cursor-pointer hover:bg-canvas-inset"
                            onClick={() => navigate("/nodes")}
                          >
                            <td className="py-2 pr-2 text-xs font-medium">{n.name}</td>
                            <td className="py-2 pr-2">
                              <span
                                className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                  n.status === "online"
                                    ? "bg-status-success/15 text-status-success"
                                    : "bg-canvas-inset text-ink-muted"
                                }`}
                              >
                                {n.status}
                              </span>
                            </td>
                            <td className="py-2 font-mono text-xs">{n.current_sessions}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Card>

                <Card
                  title="专家信息"
                  meta={`共 ${summary.experts?.total ?? 0} 个实例`}
                  actionLabel="专家"
                  onAction={() => navigate("/experts")}
                >
                  {(summary.experts?.items?.length ?? 0) === 0 ? (
                    <Empty>暂无专家实例</Empty>
                  ) : (
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-hairline text-xs text-ink-secondary">
                          <th className="pb-2 pr-2 font-medium">名称</th>
                          <th className="pb-2 pr-2 font-medium">Pack</th>
                          <th className="pb-2 font-medium">节点</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-hairline-soft">
                        {summary.experts.items.map((e) => (
                          <tr
                            key={e.id}
                            className="cursor-pointer hover:bg-canvas-inset"
                            onClick={() => navigate("/experts")}
                          >
                            <td className="py-2 pr-2 text-xs font-medium">@{e.name}</td>
                            <td className="py-2 pr-2 font-mono text-xs text-ink-secondary">{e.pack_id}</td>
                            <td className="max-w-[6rem] truncate py-2 text-xs text-ink-muted" title={e.node_name || e.node_id}>
                              {e.node_name || e.node_id.slice(0, 8)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Card>

                <Card
                  title="任务"
                  meta={`进行中 ${summary.tasks?.running ?? 0} · 会话 ${summary.tasks?.total ?? 0} · 计划 ${summary.schedules?.enabled ?? 0}/${summary.schedules?.total ?? 0}`}
                  actionLabel="会话"
                  onAction={() => navigate("/")}
                >
                  {(summary.tasks?.recent?.length ?? 0) === 0 &&
                  (summary.schedules?.items?.length ?? 0) === 0 ? (
                    <Empty>暂无任务与计划</Empty>
                  ) : (
                    <div className="space-y-3">
                      {(summary.tasks?.recent?.length ?? 0) > 0 && (
                        <ul className="divide-y divide-hairline-soft rounded-md border border-hairline-soft">
                          {summary.tasks.recent.slice(0, 6).map((t) => (
                            <li key={t.id}>
                              <button
                                type="button"
                                onClick={() => {
                                  localStorage.setItem("active_conversation_id", t.id);
                                  navigate("/");
                                }}
                                className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-canvas-inset"
                              >
                                <span
                                  className={`h-2 w-2 shrink-0 rounded-full ${
                                    t.working || t.status === "running"
                                      ? "bg-status-running"
                                      : t.status === "completed"
                                        ? "bg-status-success"
                                        : t.status === "failed"
                                          ? "bg-status-error"
                                          : "bg-ink-muted"
                                  }`}
                                />
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-xs font-medium text-ink">{t.title}</p>
                                  <p className="text-[11px] text-ink-muted">
                                    {TASK_STATUS_LABEL[t.status] || t.status}
                                    {t.working ? " · 工作中" : ""}
                                  </p>
                                </div>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      {(summary.schedules?.items?.length ?? 0) > 0 && (
                        <div>
                          <div className="mb-1 flex items-center justify-between">
                            <p className="text-[11px] font-medium uppercase tracking-wider text-ink-muted">
                              计划任务
                            </p>
                            <button
                              type="button"
                              className="text-[11px] text-ink-secondary hover:text-ink"
                              onClick={() => navigate("/schedules")}
                            >
                              全部 →
                            </button>
                          </div>
                          <ul className="divide-y divide-hairline-soft rounded-md border border-hairline-soft">
                            {summary.schedules.items.slice(0, 4).map((s) => (
                              <li
                                key={s.id}
                                className="flex cursor-pointer items-center justify-between gap-2 px-2.5 py-2 hover:bg-canvas-inset"
                                onClick={() => navigate("/schedules")}
                              >
                                <span className="min-w-0 truncate font-mono text-[11px] text-ink" title={s.target}>
                                  {s.target}
                                </span>
                                <span className="shrink-0 text-[11px] text-ink-muted">
                                  {formatInterval(s.interval_seconds)}
                                  {s.enabled ? "" : " · 停"}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </Card>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function byStatusCount(by: Record<string, number>, key: string): number {
  return by[key] ?? 0;
}

function Card(props: {
  title: string;
  meta?: string;
  children: React.ReactNode;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <section className="flex min-h-[280px] flex-col rounded-lg border border-hairline bg-canvas p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight text-ink">{props.title}</h2>
          {props.meta ? <p className="mt-0.5 text-[11px] text-ink-muted">{props.meta}</p> : null}
        </div>
        {props.actionLabel && props.onAction ? (
          <button type="button" onClick={props.onAction} className="shrink-0 text-xs text-ink-secondary hover:text-ink">
            {props.actionLabel} →
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{props.children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="flex h-full min-h-[120px] items-center justify-center text-sm text-ink-muted">{children}</p>;
}

function Kpi(props: { label: string; value: number; hint?: string; onClick?: () => void }) {
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
