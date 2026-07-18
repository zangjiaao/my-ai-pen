/**
 * Status board — information hub (not product home).
 * Sections: vulnerabilities, assets, nodes, tasks, schedules.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bar, BarChart, Cell, Legend, Pie, PieChart, XAxis, YAxis } from "recharts";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";
import {
  ChartContainer,
  ChartLegendContent,
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
    recent: {
      id: string;
      name: string;
      address: string;
      type: string;
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
      last_fire_at?: string | null;
    }[];
  };
  // flat fallbacks
  vulns_total?: number;
  open_total?: number;
  by_status?: Record<string, number>;
  by_severity?: Record<string, number>;
  recent_findings?: FindingItem[];
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
const SEV_COLOR: Record<string, string> = {
  critical: "#d73a31",
  high: "#d97706",
  medium: "#b45309",
  low: "#2563eb",
  info: "#6b7280",
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

const severityChartConfig = {
  critical: { label: "CRITICAL", color: SEV_COLOR.critical },
  high: { label: "HIGH", color: SEV_COLOR.high },
  medium: { label: "MEDIUM", color: SEV_COLOR.medium },
  low: { label: "LOW", color: SEV_COLOR.low },
  info: { label: "INFO", color: SEV_COLOR.info },
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
  if (sec >= 86400 && sec % 86400 === 0) return `${sec / 86400} 天`;
  if (sec >= 3600 && sec % 3600 === 0) return `${sec / 3600} 小时`;
  if (sec >= 60 && sec % 60 === 0) return `${sec / 60} 分钟`;
  return `${sec} 秒`;
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

  const vulns = summary?.vulnerabilities;
  const byStatus = vulns?.by_status ?? summary?.by_status ?? {};
  const bySeverity = vulns?.by_severity ?? summary?.by_severity ?? {};
  const recentFindings = vulns?.recent ?? summary?.recent_findings ?? [];
  const openTotal = vulns?.open_total ?? summary?.open_total ?? 0;
  const vulnsTotal = vulns?.total ?? summary?.vulns_total ?? 0;

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

  const severityData = useMemo(
    () =>
      SEV_ORDER.map((sev) => ({
        key: sev,
        name: SEV_LABEL[sev],
        value: bySeverity[sev] ?? 0,
        fill: SEV_COLOR[sev],
      })).filter((d) => d.value > 0),
    [bySeverity],
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
            <div className="mx-auto max-w-6xl space-y-8">
              {/* KPI strip */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <Kpi
                  label="待处理漏洞"
                  value={openTotal}
                  onClick={() => navigate("/vulnerabilities?status=to_fix")}
                />
                <Kpi
                  label="漏洞总数"
                  value={vulnsTotal}
                  onClick={() => navigate("/vulnerabilities")}
                />
                <Kpi
                  label="资产"
                  value={summary.assets?.total ?? 0}
                  onClick={() => navigate("/assets")}
                />
                <Kpi
                  label="在线节点"
                  value={summary.nodes?.online ?? 0}
                  hint={`共 ${summary.nodes?.total ?? 0} 个`}
                  onClick={() => navigate("/nodes")}
                />
                <Kpi
                  label="进行中任务"
                  value={summary.tasks?.running ?? 0}
                  hint={`会话 ${summary.tasks?.total ?? 0}`}
                  onClick={() => navigate("/")}
                />
              </div>

              {/* 1. Vulnerabilities */}
              <Section
                title="漏洞信息"
                actionLabel="全部漏洞"
                onAction={() => navigate("/vulnerabilities")}
              >
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-md border border-hairline-soft p-3">
                    <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-muted">
                      生命周期
                    </h3>
                    <ChartContainer
                      config={statusChartConfig}
                      className="aspect-[4/3] w-full max-h-[200px]"
                    >
                      <BarChart
                        data={statusData}
                        margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
                        onClick={(state) => {
                          const key = (state?.activePayload?.[0]?.payload as { key?: string })?.key;
                          if (key) navigate(`/vulnerabilities?status=${key}`);
                        }}
                        style={{ cursor: "pointer" }}
                      >
                        <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "#8b8b8b" }} />
                        <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={28} tick={{ fontSize: 11, fill: "#8b8b8b" }} />
                        <ChartTooltip content={<ChartTooltipContent hideLabel nameKey="name" />} />
                        <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={40}>
                          {statusData.map((e) => (
                            <Cell key={e.key} fill={e.fill} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ChartContainer>
                  </div>
                  <div className="rounded-md border border-hairline-soft p-3">
                    <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-muted">
                      严重级别
                    </h3>
                    {severityData.length === 0 ? (
                      <p className="flex h-[180px] items-center justify-center text-sm text-ink-muted">暂无数据</p>
                    ) : (
                      <ChartContainer
                        config={severityChartConfig}
                        className="aspect-[4/3] w-full max-h-[200px]"
                      >
                        <PieChart>
                          <ChartTooltip content={<ChartTooltipContent nameKey="name" hideLabel />} />
                          <Pie
                            data={severityData}
                            dataKey="value"
                            nameKey="name"
                            innerRadius={42}
                            outerRadius={72}
                            paddingAngle={2}
                            strokeWidth={0}
                            style={{ cursor: "pointer" }}
                            onClick={(_, index) => {
                              const row = severityData[index];
                              if (row) navigate(`/vulnerabilities?severity=${row.key}`);
                            }}
                          >
                            {severityData.map((e) => (
                              <Cell key={e.key} fill={e.fill} />
                            ))}
                          </Pie>
                          <Legend content={<ChartLegendContent />} />
                        </PieChart>
                      </ChartContainer>
                    )}
                  </div>
                </div>
                <div className="mt-3 overflow-hidden rounded-md border border-hairline-soft">
                  <div className="border-b border-hairline-soft bg-surface-default px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-ink-muted">
                    最近 finding
                  </div>
                  {recentFindings.length === 0 ? (
                    <p className="px-3 py-6 text-center text-sm text-ink-muted">暂无漏洞记录</p>
                  ) : (
                    <ul className="divide-y divide-hairline-soft">
                      {recentFindings.slice(0, 6).map((f) => (
                        <li key={f.id}>
                          <button
                            type="button"
                            onClick={() => navigate(`/vulnerabilities?highlight=${f.id}`)}
                            className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-canvas-inset"
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
                                {f.discovered_at ? ` · ${formatWhen(f.discovered_at)}` : ""}
                              </p>
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Section>

              {/* 2 + 3. Assets & Nodes */}
              <div className="grid gap-4 lg:grid-cols-2">
                <Section
                  title="资产信息"
                  actionLabel="资产管理"
                  onAction={() => navigate("/assets")}
                >
                  <p className="mb-2 text-xs text-ink-muted">共 {summary.assets?.total ?? 0} 个主机资产</p>
                  {(summary.assets?.recent?.length ?? 0) === 0 ? (
                    <p className="py-6 text-center text-sm text-ink-muted">暂无资产，请在资产管理中添加</p>
                  ) : (
                    <div className="overflow-hidden rounded-md border border-hairline-soft">
                      <table className="w-full text-left text-sm">
                        <thead>
                          <tr className="border-b border-hairline bg-surface-default text-xs text-ink-secondary">
                            <th className="px-3 py-2">地址</th>
                            <th className="px-3 py-2">类型</th>
                            <th className="px-3 py-2">更新</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-hairline-soft">
                          {summary.assets.recent.map((a) => (
                            <tr
                              key={a.id}
                              className="cursor-pointer hover:bg-canvas-inset"
                              onClick={() => navigate("/assets")}
                            >
                              <td className="max-w-[180px] truncate px-3 py-2 font-mono text-xs">{a.address}</td>
                              <td className="px-3 py-2 text-xs text-ink-secondary">{a.type}</td>
                              <td className="px-3 py-2 text-xs text-ink-muted">{formatWhen(a.updated_at)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Section>

                <Section title="节点信息" actionLabel="节点管理" onAction={() => navigate("/nodes")}>
                  <div className="mb-2 flex gap-3 text-xs text-ink-muted">
                    <span>
                      在线 <strong className="text-ink">{summary.nodes?.online ?? 0}</strong>
                    </span>
                    <span>
                      离线 <strong className="text-ink">{summary.nodes?.offline ?? 0}</strong>
                    </span>
                    <span>
                      合计 <strong className="text-ink">{summary.nodes?.total ?? 0}</strong>
                    </span>
                  </div>
                  {(summary.nodes?.items?.length ?? 0) === 0 ? (
                    <p className="py-6 text-center text-sm text-ink-muted">暂无节点，请在节点管理中注册</p>
                  ) : (
                    <div className="overflow-hidden rounded-md border border-hairline-soft">
                      <table className="w-full text-left text-sm">
                        <thead>
                          <tr className="border-b border-hairline bg-surface-default text-xs text-ink-secondary">
                            <th className="px-3 py-2">名称</th>
                            <th className="px-3 py-2">状态</th>
                            <th className="px-3 py-2">会话</th>
                            <th className="px-3 py-2">心跳</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-hairline-soft">
                          {summary.nodes.items.map((n) => (
                            <tr
                              key={n.id}
                              className="cursor-pointer hover:bg-canvas-inset"
                              onClick={() => navigate("/nodes")}
                            >
                              <td className="px-3 py-2 text-xs font-medium">{n.name}</td>
                              <td className="px-3 py-2">
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
                              <td className="px-3 py-2 font-mono text-xs">{n.current_sessions}</td>
                              <td className="px-3 py-2 text-xs text-ink-muted">{formatWhen(n.last_heartbeat)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Section>
              </div>

              {/* 4 + 5. Tasks & Schedules */}
              <div className="grid gap-4 lg:grid-cols-2">
                <Section title="任务状态" actionLabel="打开会话" onAction={() => navigate("/")}>
                  <div className="mb-2 flex flex-wrap gap-2 text-xs">
                    {Object.entries(summary.tasks?.by_status || {}).map(([st, n]) => (
                      <span
                        key={st}
                        className="rounded-md border border-hairline bg-canvas-inset px-2 py-1 text-ink-secondary"
                      >
                        {TASK_STATUS_LABEL[st] || st}{" "}
                        <span className="font-mono text-ink">{n}</span>
                      </span>
                    ))}
                    {(summary.tasks?.total ?? 0) === 0 && (
                      <span className="text-ink-muted">暂无会话任务</span>
                    )}
                  </div>
                  {(summary.tasks?.recent?.length ?? 0) === 0 ? (
                    <p className="py-6 text-center text-sm text-ink-muted">最近无任务活动</p>
                  ) : (
                    <div className="overflow-hidden rounded-md border border-hairline-soft">
                      <ul className="divide-y divide-hairline-soft">
                        {summary.tasks.recent.map((t) => (
                          <li key={t.id}>
                            <button
                              type="button"
                              onClick={() => {
                                localStorage.setItem("active_conversation_id", t.id);
                                navigate("/");
                              }}
                              className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-canvas-inset"
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
                                <p className="truncate text-sm text-ink">{t.title}</p>
                                <p className="text-xs text-ink-muted">
                                  {TASK_STATUS_LABEL[t.status] || t.status}
                                  {t.working ? " · 工作中" : ""}
                                  {t.last_active_at ? ` · ${formatWhen(t.last_active_at)}` : ""}
                                </p>
                              </div>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </Section>

                <Section
                  title="计划任务"
                  actionLabel="任务计划"
                  onAction={() => navigate("/schedules")}
                >
                  <p className="mb-2 text-xs text-ink-muted">
                    共 {summary.schedules?.total ?? 0} 个计划 · 启用{" "}
                    {summary.schedules?.enabled ?? 0}
                  </p>
                  {(summary.schedules?.items?.length ?? 0) === 0 ? (
                    <p className="py-6 text-center text-sm text-ink-muted">暂无计划任务</p>
                  ) : (
                    <div className="overflow-hidden rounded-md border border-hairline-soft">
                      <table className="w-full text-left text-sm">
                        <thead>
                          <tr className="border-b border-hairline bg-surface-default text-xs text-ink-secondary">
                            <th className="px-3 py-2">目标</th>
                            <th className="px-3 py-2">周期</th>
                            <th className="px-3 py-2">下次</th>
                            <th className="px-3 py-2">状态</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-hairline-soft">
                          {summary.schedules.items.map((s) => (
                            <tr
                              key={s.id}
                              className="cursor-pointer hover:bg-canvas-inset"
                              onClick={() => navigate("/schedules")}
                            >
                              <td className="max-w-[140px] truncate px-3 py-2 font-mono text-xs" title={s.target}>
                                {s.target}
                              </td>
                              <td className="px-3 py-2 text-xs">{formatInterval(s.interval_seconds)}</td>
                              <td className="px-3 py-2 text-xs text-ink-muted">{formatWhen(s.next_fire_at)}</td>
                              <td className="px-3 py-2">
                                <span
                                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                    s.enabled
                                      ? "bg-status-success/15 text-status-success"
                                      : "bg-canvas-inset text-ink-muted"
                                  }`}
                                >
                                  {s.enabled ? "启用" : "停用"}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Section>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function Section(props: {
  title: string;
  children: React.ReactNode;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-tight text-ink">{props.title}</h2>
        {props.actionLabel && props.onAction ? (
          <button
            type="button"
            onClick={props.onAction}
            className="text-xs text-ink-secondary hover:text-ink"
          >
            {props.actionLabel} →
          </button>
        ) : null}
      </div>
      {props.children}
    </section>
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
