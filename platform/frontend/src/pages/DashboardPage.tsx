/**
 * Operations status board — not the product home.
 * Home remains conversation (Agent). Sidebar entry above 资产管理.
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
/** Align with tailwind severity tokens for recharts fills */
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

  const statusData = useMemo(() => {
    if (!summary) return [];
    return (["to_fix", "fixing", "fixed"] as const).map((st) => ({
      key: st,
      name: STATUS_LABEL[st],
      count: summary.by_status?.[st] ?? 0,
      fill: STATUS_COLOR[st],
    }));
  }, [summary]);

  const severityData = useMemo(() => {
    if (!summary) return [];
    return SEV_ORDER.map((sev) => ({
      key: sev,
      name: SEV_LABEL[sev],
      value: summary.by_severity?.[sev] ?? 0,
      fill: SEV_COLOR[sev],
    })).filter((d) => d.value > 0);
  }, [summary]);

  const severityEmpty = severityData.length === 0;

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
                  <h2 className="mb-1 text-xs font-medium uppercase tracking-wider text-ink-muted">
                    生命周期
                  </h2>
                  <p className="mb-3 text-[11px] text-ink-muted">点击柱条筛选漏洞列表</p>
                  <ChartContainer config={statusChartConfig} className="aspect-[4/3] w-full max-h-[240px]">
                    <BarChart
                      data={statusData}
                      margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                      onClick={(state) => {
                        const key = (state?.activePayload?.[0]?.payload as { key?: string } | undefined)?.key;
                        if (key) navigate(`/vulnerabilities?status=${key}`);
                      }}
                      style={{ cursor: "pointer" }}
                    >
                      <XAxis
                        dataKey="name"
                        tickLine={false}
                        axisLine={false}
                        tick={{ fontSize: 11, fill: "#8b8b8b" }}
                      />
                      <YAxis
                        allowDecimals={false}
                        tickLine={false}
                        axisLine={false}
                        width={28}
                        tick={{ fontSize: 11, fill: "#8b8b8b" }}
                      />
                      <ChartTooltip content={<ChartTooltipContent hideLabel nameKey="name" />} />
                      <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={48}>
                        {statusData.map((entry) => (
                          <Cell key={entry.key} fill={entry.fill} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ChartContainer>
                </section>

                <section className="rounded-lg border border-hairline bg-canvas p-4">
                  <h2 className="mb-1 text-xs font-medium uppercase tracking-wider text-ink-muted">
                    严重级别
                  </h2>
                  <p className="mb-3 text-[11px] text-ink-muted">点击扇区筛选漏洞列表</p>
                  {severityEmpty ? (
                    <p className="flex h-[220px] items-center justify-center text-sm text-ink-muted">
                      暂无按级别统计的数据
                    </p>
                  ) : (
                    <ChartContainer
                      config={severityChartConfig}
                      className="aspect-[4/3] w-full max-h-[240px]"
                    >
                      <PieChart>
                        <ChartTooltip content={<ChartTooltipContent nameKey="name" hideLabel />} />
                        <Pie
                          data={severityData}
                          dataKey="value"
                          nameKey="name"
                          innerRadius={48}
                          outerRadius={80}
                          paddingAngle={2}
                          strokeWidth={0}
                          style={{ cursor: "pointer" }}
                          onClick={(_, index) => {
                            const row = severityData[index];
                            if (row) navigate(`/vulnerabilities?severity=${row.key}`);
                          }}
                        >
                          {severityData.map((entry) => (
                            <Cell key={entry.key} fill={entry.fill} />
                          ))}
                        </Pie>
                        <Legend content={<ChartLegendContent nameKey="key" />} />
                      </PieChart>
                    </ChartContainer>
                  )}
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
