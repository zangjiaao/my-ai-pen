/**
 * Status board — full-width ops hub.
 *
 * Layout:
 *  1. KPI strip (small cards)
 *  2. 每日未修复漏洞 chart (2/3) | 新增漏洞列表 (1/3)
 *  3. 节点信息 | 专家信息 | 计划任务
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Legend, XAxis, YAxis } from "recharts";
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

type OpenFindingPoint = {
  date: string;
  severity: string;
  asset_id?: string | null;
};

type DailyOpenPoint = {
  date: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
  total: number;
};

type Summary = {
  vulnerabilities: {
    total: number;
    open_total: number;
    by_status: Record<string, number>;
    by_severity: Record<string, number>;
    recent: FindingItem[];
  };
  daily_open?: {
    days: number;
    series: DailyOpenPoint[];
    open_points: OpenFindingPoint[];
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
    chart_options?: { id: string; name: string; address: string }[];
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

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;

const SEV_CLASS: Record<string, string> = {
  critical: "bg-severity-critical-subtle text-severity-critical",
  high: "bg-severity-high-subtle text-severity-high",
  medium: "bg-severity-medium-subtle text-severity-medium",
  low: "bg-severity-low-subtle text-severity-low",
  info: "bg-canvas-inset text-ink-secondary",
};

const SEV_COLOR: Record<(typeof SEVERITIES)[number], string> = {
  critical: "#dc2626",
  high: "#ea580c",
  medium: "#d97706",
  low: "#2563eb",
  info: "#a3a3a3",
};

const SEV_LABEL: Record<(typeof SEVERITIES)[number], string> = {
  critical: "严重",
  high: "高危",
  medium: "中危",
  low: "低危",
  info: "信息",
};

const dailyOpenChartConfig = {
  critical: { label: SEV_LABEL.critical, color: SEV_COLOR.critical },
  high: { label: SEV_LABEL.high, color: SEV_COLOR.high },
  medium: { label: SEV_LABEL.medium, color: SEV_COLOR.medium },
  low: { label: SEV_LABEL.low, color: SEV_COLOR.low },
  info: { label: SEV_LABEL.info, color: SEV_COLOR.info },
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

function formatDayLabel(isoDate: string): string {
  // YYYY-MM-DD → M/D
  const parts = isoDate.split("-");
  if (parts.length !== 3) return isoDate;
  return `${Number(parts[1])}/${Number(parts[2])}`;
}

function buildDailySeries(
  points: OpenFindingPoint[],
  days: number,
  assetId: string | null,
): Array<DailyOpenPoint & { label: string }> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayKeys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    dayKeys.push(`${y}-${m}-${day}`);
  }

  const buckets = new Map<string, Record<(typeof SEVERITIES)[number], number>>();
  for (const key of dayKeys) {
    buckets.set(key, { critical: 0, high: 0, medium: 0, low: 0, info: 0 });
  }

  for (const p of points) {
    if (assetId && p.asset_id !== assetId) continue;
    const bucket = buckets.get(p.date);
    if (!bucket) continue;
    const sev = (SEVERITIES as readonly string[]).includes(p.severity)
      ? (p.severity as (typeof SEVERITIES)[number])
      : "info";
    bucket[sev] += 1;
  }

  return dayKeys.map((date) => {
    const b = buckets.get(date)!;
    const total = SEVERITIES.reduce((sum, s) => sum + b[s], 0);
    return { date, label: formatDayLabel(date), ...b, total };
  });
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** Empty string = all assets */
  const [chartAssetId, setChartAssetId] = useState("");

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

  const openTotal = summary?.vulnerabilities?.open_total ?? summary?.open_total ?? 0;
  const vulnsTotal = summary?.vulnerabilities?.total ?? summary?.vulns_total ?? 0;
  const recentFindings = summary?.vulnerabilities?.recent ?? [];

  const chartAssetOptions = summary?.assets?.chart_options ?? [];
  const days = summary?.daily_open?.days ?? 14;
  const openPoints = summary?.daily_open?.open_points ?? [];

  const dailyChartData = useMemo(
    () => buildDailySeries(openPoints, days, chartAssetId || null),
    [openPoints, days, chartAssetId],
  );

  const chartOpenTotal = useMemo(
    () => dailyChartData.reduce((sum, d) => sum + d.total, 0),
    [dailyChartData],
  );

  const hasChartData = chartOpenTotal > 0;

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
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
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
              </div>

              {/* 2. 每日未修复 chart (2/3) | 新增漏洞 (1/3) */}
              <div className="grid gap-4 lg:grid-cols-3 lg:items-stretch">
                <section className="flex h-[400px] min-h-0 flex-col overflow-hidden rounded-lg border border-hairline bg-canvas p-4 lg:col-span-2">
                  <div className="mb-2 flex shrink-0 flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="text-sm font-semibold tracking-tight text-ink">每日未修复漏洞</h2>
                      <p className="mt-0.5 text-[11px] text-ink-muted">
                        近 {days} 天 · 仅统计待修复 / 修复中
                        {chartOpenTotal > 0 ? ` · 合计 ${chartOpenTotal}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <label htmlFor="chart-asset-filter" className="sr-only">
                        筛选资产
                      </label>
                      <select
                        id="chart-asset-filter"
                        value={chartAssetId}
                        onChange={(e) => setChartAssetId(e.target.value)}
                        className="max-w-[14rem] rounded-md border border-hairline bg-canvas px-2.5 py-1.5 text-xs text-ink outline-none focus:border-ink-muted"
                      >
                        <option value="">全部资产</option>
                        {chartAssetOptions.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.address || a.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => navigate("/vulnerabilities?status=to_fix")}
                        className="shrink-0 text-xs text-ink-secondary hover:text-ink"
                      >
                        漏洞 →
                      </button>
                    </div>
                  </div>

                  {!hasChartData ? (
                    <Empty>所选范围内暂无未修复漏洞</Empty>
                  ) : (
                    <ChartContainer
                      config={dailyOpenChartConfig}
                      className="min-h-0 w-full flex-1 aspect-auto"
                    >
                      <BarChart
                        data={dailyChartData}
                        margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                      >
                        <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#e5e5e5" />
                        <XAxis
                          dataKey="date"
                          tickLine={false}
                          axisLine={false}
                          tick={{ fontSize: 11, fill: "#8b8b8b" }}
                          tickFormatter={formatDayLabel}
                          interval="preserveStartEnd"
                          minTickGap={16}
                        />
                        <YAxis
                          allowDecimals={false}
                          tickLine={false}
                          axisLine={false}
                          width={28}
                          tick={{ fontSize: 11, fill: "#8b8b8b" }}
                        />
                        <ChartTooltip content={<ChartTooltipContent hideZero />} />
                        <Legend
                          verticalAlign="top"
                          height={28}
                          iconType="square"
                          iconSize={8}
                          formatter={(value) => (
                            <span className="text-[11px] text-ink-secondary">
                              {SEV_LABEL[value as (typeof SEVERITIES)[number]] || value}
                            </span>
                          )}
                        />
                        {/* Bottom → top: info … critical so highest severity sits on top */}
                        {[...SEVERITIES].reverse().map((sev, idx, arr) => (
                          <Bar
                            key={sev}
                            dataKey={sev}
                            name={sev}
                            stackId="open"
                            fill={`var(--color-${sev})`}
                            radius={idx === arr.length - 1 ? [2, 2, 0, 0] : [0, 0, 0, 0]}
                            maxBarSize={36}
                          />
                        ))}
                      </BarChart>
                    </ChartContainer>
                  )}
                </section>

                <section className="flex h-[400px] min-h-0 flex-col overflow-hidden rounded-lg border border-hairline bg-canvas p-4">
                  <div className="mb-2 flex shrink-0 items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className="text-sm font-semibold tracking-tight text-ink">新增漏洞</h2>
                      <p className="mt-0.5 text-[11px] text-ink-muted">最近 {recentFindings.length} 条</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => navigate("/vulnerabilities")}
                      className="shrink-0 text-xs text-ink-secondary hover:text-ink"
                    >
                      漏洞 →
                    </button>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {recentFindings.length === 0 ? (
                      <Empty>暂无新增漏洞</Empty>
                    ) : (
                      <ul className="divide-y divide-hairline-soft">
                        {recentFindings.map((f) => (
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
                  </div>
                </section>
              </div>

              {/* 3. 节点 | 专家 | 计划任务 */}
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
                  title="计划任务"
                  meta={`启用 ${summary.schedules?.enabled ?? 0} / 共 ${summary.schedules?.total ?? 0}`}
                  actionLabel="计划"
                  onAction={() => navigate("/schedules")}
                >
                  {(summary.schedules?.items?.length ?? 0) === 0 ? (
                    <Empty>暂无计划任务</Empty>
                  ) : (
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-hairline text-xs text-ink-secondary">
                          <th className="pb-2 pr-2 font-medium">目标</th>
                          <th className="pb-2 pr-2 font-medium">周期</th>
                          <th className="pb-2 font-medium">状态</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-hairline-soft">
                        {summary.schedules.items.map((s) => (
                          <tr
                            key={s.id}
                            className="cursor-pointer hover:bg-canvas-inset"
                            onClick={() => navigate("/schedules")}
                          >
                            <td className="max-w-[8rem] truncate py-2 pr-2 font-mono text-xs" title={s.target}>
                              {s.target}
                            </td>
                            <td className="py-2 pr-2 text-xs text-ink-secondary">
                              {formatInterval(s.interval_seconds)}
                            </td>
                            <td className="py-2">
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

function Card(props: {
  title: string;
  meta?: string;
  children: React.ReactNode;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <section className="flex h-[260px] min-h-0 flex-col overflow-hidden rounded-lg border border-hairline bg-canvas p-4">
      <div className="mb-2 flex shrink-0 items-start justify-between gap-2">
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
      <div className="min-h-0 flex-1 overflow-y-auto">{props.children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="flex h-full min-h-[80px] items-center justify-center text-sm text-ink-muted">{children}</p>;
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
