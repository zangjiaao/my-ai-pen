import { useState } from "react";
import type { SecurityAsset, SecurityVulnerability } from "../lib/securityTypes";
import ApprovalCountdown from "./ApprovalCountdown";

type Tab = "discoveries" | "progress" | "pending" | "evidence";
type TodoStatus = "done" | "running" | "pending";

interface Props {
  phase?: string;
  activeTool?: string;
  intakeResult?: Record<string, unknown>;
  intakeStatus?: string;
  progress?: { current: number; total: number; percent: number };
  todos?: Array<{ id: string; title: string; status: TodoStatus }>;
  findings?: Array<Record<string, unknown>>;
  assets?: Array<Record<string, unknown>>;
  pendingApprovals?: Array<Record<string, unknown>>;
  evidence?: Array<Record<string, unknown>>;
  onDecision?: (requestId: string, decision: "authorize" | "cancel") => void;
  onOpenVulnerability?: (finding: Partial<SecurityVulnerability>) => void;
  onOpenAsset?: (asset: Partial<SecurityAsset>) => void;
  onLocateApproval?: (requestId: string) => void;
}

const TODO_MARK: Record<TodoStatus, string> = {
  done: "✓",
  running: "•",
  pending: "",
};

const PHASE_LABELS: Record<string, string> = {
  precheck: "目标与授权范围检查",
  plan: "生成测试计划",
  recon: "资产与服务探测",
  scan: "漏洞扫描与候选发现",
  verify: "复现验证与授权确认",
  report: "同步结果与整理证据",
};

export default function RightPanel({ phase, activeTool, intakeResult, intakeStatus, progress, todos = [], findings = [], assets = [], pendingApprovals = [], evidence = [], onDecision, onOpenVulnerability, onOpenAsset, onLocateApproval }: Props) {
  const [tab, setTab] = useState<Tab>("progress");

  const tabs: { key: Tab; label: string }[] = [
    { key: "progress", label: "Progress" },
    { key: "discoveries", label: `Discoveries${findings.length + assets.length ? ` (${findings.length + assets.length})` : ""}` },
    { key: "pending", label: `Pending${pendingApprovals.length ? ` (${pendingApprovals.length})` : ""}` },
    { key: "evidence", label: `Evidence${evidence.length ? ` (${evidence.length})` : ""}` },
  ];

  const percent = Math.max(0, Math.min(100, Number(progress?.percent || 0)));
  const phaseText = phase ? (PHASE_LABELS[phase] || phase) : "等待开始";
  const intake = normalizeIntake(intakeResult, intakeStatus);

  return (
    <aside className="w-[360px] flex-shrink-0 border-l border-hairline bg-canvas flex flex-col">
      <nav className="grid grid-cols-4 border-b border-hairline-soft">
        {tabs.map((t) => (
          <button key={t.key} data-testid={`right-tab-${t.key}`} onClick={() => setTab(t.key)}
            className={`py-2.5 text-sm font-medium transition-colors ${tab === t.key ? "text-ink border-b-2 border-ink" : "text-ink-secondary border-b-2 border-transparent hover:text-ink"}`}>
            {t.label}
          </button>
        ))}
      </nav>
      <div className="flex-1 overflow-y-auto p-4">
        {tab === "progress" && (
          <div className="space-y-4">
            <div>
              <p className="text-xs text-ink-muted mb-1">当前阶段</p>
              <p className="text-sm font-medium">{phaseText}</p>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between text-xs text-ink-muted">
                <span>阶段进度</span>
                <span data-testid="phase-progress">{progress ? `${progress.current}/${progress.total}` : "0/6"}</span>
              </div>
              <div className="h-1.5 rounded-full bg-hairline">
                <div className="h-1.5 rounded-full bg-ink transition-all" style={{ width: `${percent}%` }} />
              </div>
            </div>
            {activeTool && (
              <div>
                <p className="text-xs text-ink-muted mb-1">活跃工具</p>
                <p className="text-sm font-mono">{activeTool}</p>
              </div>
            )}
            {intake && (
              <div data-testid="intake-result" className="rounded-md border border-hairline-soft p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">预检</p>
                  <span className={`rounded-pill px-2 py-0.5 text-[11px] font-medium ${intake.ok ? "bg-status-success text-white" : "bg-severity-critical text-white"}`}>{intake.label}</span>
                </div>
                <div className="space-y-1 text-xs text-ink-secondary">
                  {intake.target && <p className="break-all">目标: {intake.target}</p>}
                  {intake.dns && <p className="break-all">DNS: {intake.dns}</p>}
                  {intake.connectivity && <p className="break-all">连通性: {intake.connectivity}</p>}
                  {intake.reason && <p className="break-all text-severity-critical">{intake.reason}</p>}
                </div>
              </div>
            )}
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-muted">TODO</p>
              {todos.length === 0 ? (
                <p className="text-sm text-ink-muted">等待 Agent 生成计划</p>
              ) : (
                <div className="space-y-2" data-testid="todo-list">
                  {todos.map((item) => (
                    <div key={item.id} className="flex items-center gap-2 rounded-md border border-hairline-soft px-2.5 py-2">
                      <span className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border text-xs ${item.status === "done" ? "border-status-success bg-status-success text-white" : item.status === "running" ? "border-status-running text-status-running" : "border-hairline text-transparent"}`}>{TODO_MARK[item.status]}</span>
                      <span className={`min-w-0 text-sm ${item.status === "pending" ? "text-ink-muted" : "text-ink"}`}>{item.title}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        {tab === "discoveries" && (
          findings.length + assets.length === 0 ? (
            <p className="text-sm text-ink-muted">No discoveries yet</p>
          ) : (
            <div className="space-y-2">
              {findings.map((f, i) => (
                <button key={(f.id as string) || (f.vulnerability_id as string) || i} type="button" onClick={() => onOpenVulnerability?.(f as Partial<SecurityVulnerability>)} className="block w-full rounded-md border border-hairline-soft p-2 text-left transition-colors hover:bg-surface-default">
                  <div className="mb-1 flex items-center gap-1">
                    <span className={`inline-block rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase bg-severity-${f.severity || "info"}-subtle text-severity-${f.severity || "info"}`}>{String(f.severity || "info")}</span>
                    <span className="truncate text-sm font-medium">{String(f.title || "Untitled vulnerability")}</span>
                  </div>
                  <p className="break-words text-xs text-ink-muted">{String(f.location || f.affected_asset || f.status || "")}</p>
                </button>
              ))}
              {assets.map((asset, i) => {
                const props = asset.properties as Record<string, unknown> | undefined;
                const ports = Array.isArray(asset.open_ports) ? asset.open_ports : Array.isArray(props?.open_ports) ? props.open_ports as unknown[] : [];
                return (
                  <button key={(asset.id as string) || (asset.asset_id as string) || (asset.address as string) || i} type="button" onClick={() => onOpenAsset?.(asset as Partial<SecurityAsset>)} className="block w-full rounded-md border border-hairline-soft p-2 text-left transition-colors hover:bg-surface-default">
                    <div className="mb-1 flex items-center gap-1">
                      <span className="rounded-md bg-canvas-inset px-1.5 py-0.5 text-[10px] uppercase text-ink-secondary">{String(asset.asset_type || asset.type || "asset")}</span>
                      <span className="truncate text-sm font-medium">{String(asset.address || asset.name || "Unknown asset")}</span>
                    </div>
                    <p className="break-words text-xs text-ink-muted">ports: {ports.length ? ports.join(", ") : "-"}</p>
                  </button>
                );
              })}
            </div>
          )
        )}
        {tab === "pending" && (
          pendingApprovals.length === 0 ? <p className="text-sm text-ink-muted">No pending approvals</p> : (
            <div className="space-y-3" data-testid="pending-list">
              {pendingApprovals.map((item) => {
                const requestId = String(item.request_id || "");
                return (
                  <div key={requestId} data-testid="pending-item" data-approval-request-id={requestId} className="rounded-md border border-hairline p-3">
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-xs uppercase text-ink-muted">{String(item.risk_level || "unknown")}</div>
                        <div className="mt-1 break-words text-sm font-medium [overflow-wrap:anywhere]">{String(item.question || "")}</div>
                      </div>
                      <ApprovalCountdown expiresAt={item.expires_at} compact />
                    </div>
                    {Boolean(item.proposed_action) && <pre className="mb-2 max-h-24 overflow-auto rounded bg-canvas-inset p-2 font-mono text-xs whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{String(item.proposed_action)}</pre>}
                    <div className="flex flex-wrap gap-2">
                      <button data-testid="pending-locate" type="button" onClick={() => onLocateApproval?.(requestId)} className="rounded-pill border border-hairline px-3 py-1.5 text-xs">Locate</button>
                      <button type="button" onClick={() => onDecision?.(requestId, "authorize")} className="rounded-pill bg-ink px-3 py-1.5 text-xs text-white">Authorize</button>
                      <button type="button" onClick={() => onDecision?.(requestId, "cancel")} className="rounded-pill border px-3 py-1.5 text-xs">Cancel</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )
        )}
        {tab === "evidence" && (
          evidence.length === 0 ? <p className="text-sm text-ink-muted">暂无证据</p> : (
            <div className="space-y-2" data-testid="evidence-list">
              {evidence.map((item) => (
                <div key={(item.evidence_id || item.id) as string} data-testid="evidence-item" className="rounded-md border border-hairline-soft p-2">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{(item.source_tool || item.type) as string}</span>
                    <span className="font-mono text-[10px] text-ink-muted">{item.evidence_id as string}</span>
                  </div>
                  <p className="line-clamp-3 text-xs text-ink-muted">{String(item.summary || item.raw_ref || "")}</p>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </aside>
  );
}
function normalizeIntake(intakeResult?: Record<string, unknown>, intakeStatus?: string) {
  if (!intakeResult) return null;
  const ok = intakeResult.ok === true;
  const connectivity = intakeResult.connectivity as Record<string, unknown> | undefined;
  const dns = Array.isArray(intakeResult.dns_addresses) ? intakeResult.dns_addresses.join(", ") : "";
  const connText = connectivity?.checked
    ? `${connectivity.ok ? "可达" : "不可达"} ${connectivity.host || ""}${connectivity.port ? `:${connectivity.port}` : ""}`.trim()
    : "未检查";
  return {
    ok,
    label: ok ? "通过" : "失败",
    target: String(intakeResult.target || ""),
    dns,
    connectivity: connText,
    reason: String(intakeResult.reason || (intakeStatus === "failed" ? "预检失败" : "")),
  };
}
