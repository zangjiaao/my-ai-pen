/**
 * Status board — full-width ops hub.
 *
 * Layout:
 *  1. KPI strip (small cards)
 *  2. 每日未修复漏洞 chart (3/5) | 新增漏洞列表 (2/5)
 *  3. 事实流量 | 节点/专家 | 计划任务
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  BarChart3,
  Bot,
  CalendarClock,
  ClipboardList,
  Network,
  Server,
  Shield,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";
import VulnDetailDialog from "../components/VulnDetailDialog";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "../components/ui/chart";
import { authFetch } from "../lib/api";
import { casePath } from "../lib/caseRoutes";
import { expertLabel, packCapabilities, resolveExpertColor } from "../lib/experts";
import type { SecurityVulnerability } from "../lib/securityTypes";
import {
  TRAFFIC_EMPTY_COPY,
  filterTrafficListRows,
  projectTrafficListRows,
  type TrafficExchange,
  type TrafficListRow,
  type TrafficSourceFilter,
} from "../lib/trafficAuditView";

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
      node_status?: string | null;
      color?: string | null;
      enabled: boolean;
      is_default?: boolean;
      description?: string | null;
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
  finding_pace?: {
    last_7d: number;
    prev_7d: number;
  };
  traffic?: {
    total: number;
    items: TrafficExchange[];
  };
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
  critical: "var(--color-severity-critical)",
  high: "var(--color-severity-high)",
  medium: "var(--color-severity-medium)",
  low: "var(--color-severity-low)",
  info: "var(--color-severity-info)",
};

const SEV_FILL: Record<(typeof SEVERITIES)[number], string> = {
  critical: "fill-severity-critical",
  high: "fill-severity-high",
  medium: "fill-severity-medium",
  low: "fill-severity-low",
  info: "fill-severity-info",
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
  /** Inline vuln detail — list row opens dialog, not /vulnerabilities. */
  const [selectedVuln, setSelectedVuln] = useState<Partial<SecurityVulnerability> | null>(null);
  const [opsTab, setOpsTab] = useState<"nodes" | "experts">("experts");
  const [trafficSource, setTrafficSource] = useState<TrafficSourceFilter>("all");

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

  const openFinding = (f: FindingItem) => {
    setSelectedVuln({
      id: f.id,
      vulnerability_id: f.id,
      title: f.title,
      severity: f.severity,
      status: f.status,
      status_label: f.status_label,
      discovered_at: f.discovered_at,
      conversation_id: f.conversation_id ?? undefined,
      asset_id: f.asset_id ?? undefined,
    });
  };

  const openTotal = summary?.vulnerabilities?.open_total ?? summary?.open_total ?? 0;
  const vulnsTotal = summary?.vulnerabilities?.total ?? summary?.vulns_total ?? 0;
  const recentFindings = summary?.vulnerabilities?.recent ?? [];

  const chartAssetOptions = summary?.assets?.chart_options ?? [];
  const days = summary?.daily_open?.days ?? 20;
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
      <Sidebar activeId={null} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar title="状态看板" />
        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
          {loading && <p className="text-sm text-ink-muted">加载中…</p>}
          {error && (
            <div className="mb-4 max-w-xl rounded-md bg-severity-critical-subtle px-4 py-3 text-sm text-severity-critical">
              {error}
            </div>
          )}

          {summary && !loading && (
            <div className="flex min-h-0 flex-1 flex-col gap-4">
              {/* 1. KPI strip — title / value / trend */}
              <div className="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <Kpi
                  icon={ShieldAlert}
                  label="待处理漏洞"
                  value={openTotal}
                  hint={vulnsTotal > 0 ? `占总数 ${Math.round((openTotal / vulnsTotal) * 100)}%` : undefined}
                  onClick={() => navigate("/vulnerabilities?status=to_fix")}
                />
                <Kpi
                  icon={Shield}
                  label="漏洞总数"
                  value={vulnsTotal}
                  {...paceProps(summary.finding_pace?.last_7d ?? 0, summary.finding_pace?.prev_7d ?? 0)}
                  onClick={() => navigate("/vulnerabilities")}
                />
                <Kpi
                  icon={Server}
                  label="资产"
                  value={summary.assets?.total ?? 0}
                  hint={`${summary.assets?.with_open_vulns ?? 0} 个有未修复`}
                  onClick={() => navigate("/assets")}
                />
                <Kpi
                  icon={Network}
                  label="在线节点"
                  value={summary.nodes?.online ?? 0}
                  hint={`共 ${summary.nodes?.total ?? 0}`}
                  onClick={() => navigate("/nodes")}
                />
                <Kpi
                  icon={Bot}
                  label="专家"
                  value={summary.experts?.total ?? summary.experts_total ?? 0}
                  onClick={() => navigate("/experts")}
                />
              </div>

              <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,6fr)_minmax(0,4fr)] gap-4">
              {/* 2. 每日未修复 (6fr) | 新增漏洞 (4fr) */}
              <div className="grid min-h-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,6fr)_minmax(0,4fr)] lg:items-stretch">
                <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-hairline bg-canvas p-6">
                  <div className="mb-3 flex shrink-0 flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle icon={BarChart3}>每日未修复漏洞</CardTitle>
                      <p className="mt-0.5 text-[11px] text-ink-muted">
                        近 {days} 天 · 仅统计待修复 / 修复中
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
                    </div>
                  </div>

                  {!hasChartData ? (
                    <Empty>所选范围内暂无未修复漏洞</Empty>
                  ) : (
                    <ChartContainer
                      config={dailyOpenChartConfig}
                      className="min-h-0 w-full flex-1 aspect-auto pt-4"
                    >
                      <BarChart
                        data={dailyChartData}
                        margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                      >
                        <CartesianGrid vertical={false} stroke="var(--color-chart-grid)" />
                        <XAxis
                          dataKey="date"
                          tickLine={false}
                          axisLine={false}
                          tickMargin={8}
                          minTickGap={32}
                          tick={{ fontSize: 11, fill: "var(--color-chart-tick)" }}
                          tickFormatter={formatDayLabel}
                          interval="preserveStartEnd"
                        />
                        <YAxis
                          allowDecimals={false}
                          tickLine={false}
                          axisLine={false}
                          tickMargin={4}
                          width={35}
                          tick={{ fontSize: 11, fill: "var(--color-chart-tick)" }}
                        />
                        <ChartTooltip cursor={false} content={<ChartTooltipContent hideZero />} />
                        {/* Bottom → top: critical … info so 严重 sits at the base */}
                        {SEVERITIES.map((sev) => (
                          <Bar
                            key={sev}
                            dataKey={sev}
                            name={SEV_LABEL[sev]}
                            stackId="open"
                            fill={SEV_COLOR[sev]}
                            radius={6}
                            className={`stroke-canvas ${SEV_FILL[sev]}`}
                            strokeWidth={3}
                          />
                        ))}
                      </BarChart>
                    </ChartContainer>
                  )}
                </section>

                <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-hairline bg-canvas p-6">
                  <div className="mb-2 flex shrink-0 items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle icon={ClipboardList}>新增漏洞</CardTitle>
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
                  <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
                    {recentFindings.length === 0 ? (
                      <Empty>暂无新增漏洞</Empty>
                    ) : (
                      <table className="w-full table-fixed text-left text-sm">
                        <colgroup>
                          <col className="w-[4.5rem]" />
                          <col />
                          <col className="w-[9.5rem]" />
                        </colgroup>
                        <thead className="sticky top-0 z-10 bg-canvas">
                          <tr className="border-b border-hairline text-[11px] text-ink-secondary">
                            <th className="bg-canvas pb-2 pr-2 font-medium">级别</th>
                            <th className="bg-canvas pb-2 pr-2 font-medium">漏洞名</th>
                            <th className="bg-canvas pb-2 font-medium">发现时间</th>
                          </tr>
                        </thead>
                        <tbody>
                          {recentFindings.map((f) => (
                            <tr
                              key={f.id}
                              className="cursor-pointer border-b border-hairline-soft last:border-b-0 hover:bg-canvas-inset"
                              onClick={() => openFinding(f)}
                            >
                              <td className="py-2 pr-2 align-middle">
                                <span
                                  className={`inline-block rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${SEV_CLASS[f.severity] || SEV_CLASS.info}`}
                                >
                                  {SEV_LABEL[f.severity as (typeof SEVERITIES)[number]] || f.severity}
                                </span>
                              </td>
                              <td className="truncate py-2 pr-2 align-middle text-xs text-ink" title={f.title}>
                                {f.title}
                              </td>
                              <td className="whitespace-nowrap py-2 align-middle text-[11px] text-ink-muted">
                                {formatWhen(f.discovered_at)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </section>
              </div>

              {/* 3. 事实流量 | 节点/专家 | 计划任务 */}
              <div className="grid min-h-0 gap-4 lg:grid-cols-3">
                <Card
                  icon={Activity}
                  title="事实流量"
                  meta={`最近 ${summary.traffic?.items?.length ?? 0} 条`}
                  headerRight={
                    <select
                      value={trafficSource}
                      onChange={(e) => setTrafficSource(e.target.value as TrafficSourceFilter)}
                      className="h-7 rounded-md border border-hairline bg-canvas px-2 text-[11px] leading-none text-ink outline-none focus:border-ink"
                      aria-label="Filter by source"
                    >
                      <option value="all">All sources</option>
                      <option value="http">http</option>
                      <option value="browser">browser</option>
                      <option value="curl">curl</option>
                    </select>
                  }
                >
                  <DashboardTrafficTable
                    exchanges={summary.traffic?.items ?? []}
                    source={trafficSource}
                    onOpenCase={(id) => navigate(casePath(id))}
                  />
                </Card>

                <Card
                  icon={opsTab === "nodes" ? Network : Bot}
                  title={opsTab === "nodes" ? "节点信息" : "专家信息"}
                  meta={
                    opsTab === "nodes"
                      ? `在线 ${summary.nodes?.online ?? 0} · 离线 ${summary.nodes?.offline ?? 0}`
                      : `共 ${summary.experts?.total ?? 0} 个实例`
                  }
                  headerRight={
                    <div className="flex h-7 items-center rounded-md border border-hairline p-0.5">
                      <button
                        type="button"
                        onClick={() => setOpsTab("nodes")}
                        className={`h-full rounded px-2 text-[11px] leading-none ${
                          opsTab === "nodes" ? "bg-canvas-inset font-medium text-ink" : "text-ink-muted hover:text-ink"
                        }`}
                      >
                        节点
                      </button>
                      <button
                        type="button"
                        onClick={() => setOpsTab("experts")}
                        className={`h-full rounded px-2 text-[11px] leading-none ${
                          opsTab === "experts" ? "bg-canvas-inset font-medium text-ink" : "text-ink-muted hover:text-ink"
                        }`}
                      >
                        专家
                      </button>
                    </div>
                  }
                >
                  {opsTab === "nodes" ? (
                    (summary.nodes?.items?.length ?? 0) === 0 ? (
                      <Empty>暂无节点</Empty>
                    ) : (
                      <ul className="flex flex-col">
                        {summary.nodes.items.map((n) => (
                          <li key={n.id}>
                            <Tile
                              flush
                              title={n.name}
                              meta={`${n.type} · ${n.current_sessions} 会话`}
                              dot={n.status === "online" ? "var(--color-status-success)" : "var(--color-ink-muted)"}
                              badge={
                                <StatusPill on={n.status === "online"}>
                                  {n.status === "online" ? "在线" : n.status}
                                </StatusPill>
                              }
                              onClick={() => navigate("/nodes")}
                            />
                          </li>
                        ))}
                      </ul>
                    )
                  ) : (summary.experts?.items?.length ?? 0) === 0 ? (
                    <Empty>暂无专家实例</Empty>
                  ) : (
                    <ul className="flex flex-col">
                      {summary.experts.items.map((e) => (
                        <li key={e.id}>
                          <ExpertTile expert={e} onClick={() => navigate("/experts")} />
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>

                <Card
                  icon={CalendarClock}
                  title="计划任务"
                  meta={`启用 ${summary.schedules?.enabled ?? 0} / 共 ${summary.schedules?.total ?? 0}`}
                  headerRight={
                    <button
                      type="button"
                      onClick={() => navigate("/schedules")}
                      className="h-7 rounded-md border border-hairline bg-canvas px-2 text-[11px] leading-none text-ink-secondary hover:text-ink"
                    >
                      计划 →
                    </button>
                  }
                >
                  {(summary.schedules?.items?.length ?? 0) === 0 ? (
                    <Empty>暂无计划任务</Empty>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {summary.schedules.items.map((s) => (
                        <li key={s.id}>
                          <Tile
                            title={s.target}
                            meta={`${formatInterval(s.interval_seconds)}${s.next_fire_at ? ` · ${formatWhen(s.next_fire_at)}` : ""}`}
                            badge={<StatusPill on={s.enabled}>{s.enabled ? "启用" : "停用"}</StatusPill>}
                            onClick={() => navigate("/schedules")}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>
              </div>
            </div>
          )}
        </main>
      </div>

      <VulnDetailDialog
        open={Boolean(selectedVuln)}
        vulnerabilityId={selectedVuln?.id || selectedVuln?.vulnerability_id}
        initial={selectedVuln}
        onClose={() => setSelectedVuln(null)}
      />
    </div>
  );
}

function CardTitle(props: { icon: LucideIcon; children: React.ReactNode }) {
  const Icon = props.icon;
  return (
    <h2 className="flex items-center gap-1.5 text-sm font-semibold tracking-tight text-ink">
      <Icon size={14} strokeWidth={1.75} className="shrink-0" />
      {props.children}
    </h2>
  );
}

function Card(props: {
  icon: LucideIcon;
  title: string;
  meta?: string;
  children: React.ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  headerRight?: React.ReactNode;
}) {
  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-hairline bg-canvas p-6">
      <div className="mb-2 flex shrink-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <CardTitle icon={props.icon}>{props.title}</CardTitle>
          {props.meta ? <p className="mt-0.5 text-[11px] text-ink-muted">{props.meta}</p> : null}
        </div>
        {props.headerRight ? <div className="shrink-0">{props.headerRight}</div> : null}
        {!props.headerRight && props.actionLabel && props.onAction ? (
          <button type="button" onClick={props.onAction} className="shrink-0 text-xs text-ink-secondary hover:text-ink">
            {props.actionLabel} →
          </button>
        ) : null}
      </div>
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">{props.children}</div>
    </section>
  );
}

function trafficMethodTextClass(method: string): string {
  switch (String(method || "").toUpperCase()) {
    case "GET":
      return "text-status-running";
    case "POST":
      return "text-status-success";
    case "PUT":
    case "PATCH":
      return "text-severity-high";
    case "DELETE":
      return "text-severity-critical";
    case "HEAD":
    case "OPTIONS":
      return "text-ink-secondary";
    default:
      return "text-ink";
  }
}

function trafficStatusTextClass(row: Pick<TrafficListRow, "status" | "pending" | "phase">): string {
  if (row.pending) return "text-status-running";
  if (row.phase === "failed" || row.status === "failed" || row.status === "err") {
    return "text-severity-critical";
  }
  const code = Number(row.status);
  if (!Number.isFinite(code)) return "text-ink-secondary";
  if (code >= 200 && code < 300) return "text-status-success";
  if (code >= 300 && code < 400) return "text-status-running";
  if (code >= 400 && code < 500) return "text-severity-high";
  if (code >= 500) return "text-severity-critical";
  return "text-ink-secondary";
}

function DashboardTrafficTable(props: {
  exchanges: TrafficExchange[];
  source: TrafficSourceFilter;
  onOpenCase: (conversationId: string) => void;
}) {
  const rows = useMemo(() => projectTrafficListRows(props.exchanges), [props.exchanges]);
  const visible = useMemo(
    () => filterTrafficListRows(rows, { source: props.source }),
    [rows, props.source],
  );
  const convByExchange = useMemo(() => {
    const m = new Map<string, string>();
    for (const ex of props.exchanges) {
      const id = String(ex.exchange_id || "");
      const cid = String(ex.conversation_id || "");
      if (id && cid) m.set(id, cid);
    }
    return m;
  }, [props.exchanges]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {!props.exchanges.length ? (
        <p className="text-sm text-ink-muted">{TRAFFIC_EMPTY_COPY}</p>
      ) : !visible.length ? (
        <p className="text-sm text-ink-muted">No exchanges match filter</p>
      ) : (
        <div className="no-scrollbar min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[420px] table-fixed border-collapse text-left">
            <thead className="sticky top-0 z-10 bg-canvas">
              <tr className="border-b border-hairline-soft text-[10px] font-medium uppercase tracking-wide text-ink-muted">
                <th className="bg-canvas px-1 py-1.5 font-medium">#</th>
                <th className="bg-canvas px-1 py-1.5 font-medium">Method</th>
                <th className="bg-canvas px-1 py-1.5 font-medium">Domain</th>
                <th className="bg-canvas px-1 py-1.5 font-medium">Path</th>
                <th className="bg-canvas px-1 py-1.5 font-medium">Status</th>
                <th className="bg-canvas px-1 py-1.5 font-medium">Source</th>
                <th className="bg-canvas px-1 py-1.5 font-medium">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline-soft">
              {visible.map((row) => {
                const convId = convByExchange.get(row.exchange_id) || "";
                return (
                  <tr
                    key={row.exchange_id}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (convId) props.onOpenCase(convId);
                    }}
                    onKeyDown={(e) => {
                      if ((e.key === "Enter" || e.key === " ") && convId) {
                        e.preventDefault();
                        props.onOpenCase(convId);
                      }
                    }}
                    className="cursor-pointer font-mono text-[11px] text-ink hover:bg-canvas-inset/60"
                    title={row.url}
                  >
                    <td className="whitespace-nowrap px-1 py-1.5 text-ink-muted">{row.index}</td>
                    <td className={`whitespace-nowrap px-1 py-1.5 font-semibold ${trafficMethodTextClass(row.method)}`}>
                      {row.method}
                    </td>
                    <td className="truncate px-1 py-1.5" title={row.domain}>
                      {row.domain || "—"}
                    </td>
                    <td className="truncate px-1 py-1.5" title={row.path}>
                      {row.path || "/"}
                    </td>
                    <td className={`whitespace-nowrap px-1 py-1.5 font-medium ${trafficStatusTextClass(row)}`}>
                      {row.status}
                    </td>
                    <td className="whitespace-nowrap px-1 py-1.5 text-ink-muted">{row.source}</td>
                    <td className="whitespace-nowrap px-1 py-1.5 text-ink-muted">{row.duration}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ExpertTile(props: {
  expert: {
    id: string;
    name: string;
    pack_id: string;
    node_id: string;
    node_name?: string | null;
    node_status?: string | null;
    color?: string | null;
    enabled: boolean;
    is_default?: boolean;
    description?: string | null;
  };
  onClick: () => void;
}) {
  const e = props.expert;
  const accent = resolveExpertColor(e.color, e.id);
  const pack = expertLabel(e.pack_id);
  const caps = packCapabilities(e.pack_id);
  const nodeOnline = (e.node_status || "").toLowerCase() === "online";
  const nodeLabel = e.node_name || e.node_id.slice(0, 8);
  const meta = [
    pack,
    nodeOnline ? nodeLabel : `${nodeLabel}（离线）`,
    `技能 ${caps.skills.length}`,
    `工具 ${caps.tools.length}`,
  ].join(" · ");

  return (
    <Tile
      flush
      title={e.name}
      meta={meta}
      dot={accent}
      badge={
        e.is_default && e.enabled ? (
          <StatusPill on>默认</StatusPill>
        ) : !e.enabled ? (
          <StatusPill on={false}>停用</StatusPill>
        ) : null
      }
      onClick={props.onClick}
    />
  );
}

function Tile(props: {
  title: string;
  meta?: string;
  badge?: React.ReactNode;
  dot?: string;
  flush?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={
        props.flush
          ? "flex w-full items-center justify-between gap-3 rounded-md px-1 py-1.5 text-left transition-colors hover:bg-canvas-inset"
          : "flex w-full items-start justify-between gap-3 rounded-md border border-hairline bg-canvas-inset px-3 py-2.5 text-left transition-colors hover:border-ink-muted/40 hover:bg-surface-elevated"
      }
    >
      <div
        className="flex min-w-0 flex-1 items-center gap-2"
        title={props.meta ? `${props.title} · ${props.meta}` : props.title}
      >
        {props.dot ? (
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: props.dot }} aria-hidden />
        ) : null}
        <p className="min-w-0 truncate">
          <span className="text-sm font-medium text-ink">{props.title}</span>
          {props.meta ? <span className="text-[11px] text-ink-muted"> · {props.meta}</span> : null}
        </p>
      </div>
      {props.badge}
    </button>
  );
}

function StatusPill({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
        on ? "bg-status-success/15 text-status-success" : "bg-canvas text-ink-muted"
      }`}
    >
      {children}
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="flex h-full min-h-[80px] items-center justify-center text-sm text-ink-muted">{children}</p>;
}

function paceProps(last: number, prev: number): { hint: string; tone: "up" | "down" | "flat" } {
  const d = last - prev;
  if (d === 0 && prev === 0) return { hint: "近 7 天无新增", tone: "flat" };
  if (d === 0) return { hint: "与前 7 天持平", tone: "flat" };
  const sign = d > 0 ? "+" : "";
  const text = prev === 0 ? `${sign}${d}` : `${sign}${d} · ${sign}${Math.round((d / prev) * 100)}%`;
  return { hint: text, tone: d > 0 ? "up" : "down" };
}

function Kpi(props: {
  icon: LucideIcon;
  label: string;
  value: number;
  hint?: string;
  tone?: "up" | "down" | "flat";
  onClick?: () => void;
}) {
  const Icon = props.icon;
  const toneClass =
    props.tone === "up" ? "text-severity-critical" : props.tone === "down" ? "text-status-success" : "text-ink-muted";
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="flex min-h-[9rem] flex-col rounded-lg border border-hairline bg-canvas p-6 text-left transition-colors hover:bg-canvas-inset"
    >
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-ink-muted">
        <Icon size={13} strokeWidth={1.75} className="shrink-0" />
        {props.label}
      </p>
      <p className="mt-2 font-mono text-2xl font-semibold tracking-tight text-ink">{props.value}</p>
      {props.hint ? (
        <p className={`mt-auto flex items-center gap-1 pt-3 text-xs ${toneClass}`}>
          {props.tone === "up" ? <TrendingUp size={12} /> : null}
          {props.tone === "down" ? <TrendingDown size={12} /> : null}
          {props.hint}
        </p>
      ) : null}
    </button>
  );
}
