import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { SecurityAsset, SecurityEvidence, SecurityVulnerability } from "../lib/securityTypes";
import ApprovalCountdown from "./ApprovalCountdown";

type Tab = "discoveries" | "progress" | "pending" | "evidence";
type PlanStatus = "pending" | "running" | "done" | "skipped" | "blocked" | "failed" | string;
type PlanNode = { node_id?: string; id?: string; title?: string; status?: PlanStatus; kind?: string; level?: string; endpoint?: string | null; parameter?: string | null; vuln_type?: string | null; parent_id?: string | null; notes?: string | null; priority?: number; };
type PlanTreeItem = { key: string; node: PlanNode; children: PlanTreeItem[]; index: number };
type VisiblePlanTreeItem = { item: PlanTreeItem; depth: number };

interface Props {
  phase?: string;
  activeTool?: string;
  intakeResult?: Record<string, unknown>;
  intakeStatus?: string;
  progress?: { current: number; total: number; percent: number };
  planTree?: PlanNode[];
  findings?: Array<Record<string, unknown>>;
  assets?: Array<Record<string, unknown>>;
  pendingApprovals?: Array<Record<string, unknown>>;
  evidence?: Array<Record<string, unknown>>;
  onDecision?: (requestId: string, decision: "authorize" | "cancel") => void;
  onOpenVulnerability?: (finding: Partial<SecurityVulnerability>) => void;
  onOpenAsset?: (asset: Partial<SecurityAsset>) => void;
  onOpenEvidence?: (evidence: Partial<SecurityEvidence>) => void;
  onLocateApproval?: (requestId: string) => void;
}

const PHASE_LABELS: Record<string, string> = {
  intake: "\u76ee\u6807\u4e0e\u6388\u6743\u8303\u56f4\u68c0\u67e5",
  recon: "\u653b\u51fb\u9762\u53d1\u73b0",
  analysis: "\u8986\u76d6\u5206\u6790\u4e0e\u6d4b\u8bd5\u8ba1\u5212",
  verify: "\u9a8c\u8bc1\u4e0e\u8bc1\u636e\u786e\u8ba4",
  report: "\u62a5\u544a\u6574\u7406",
  complete: "\u4efb\u52a1\u5b8c\u6210",
};

export default function RightPanel({ phase, activeTool, intakeResult, intakeStatus, progress, planTree = [], findings = [], assets = [], pendingApprovals = [], evidence = [], onDecision, onOpenVulnerability, onOpenAsset, onOpenEvidence, onLocateApproval }: Props) {
  const [tab, setTab] = useState<Tab>("progress");

  const tabs: { key: Tab; label: string }[] = [
    { key: "progress", label: "Progress" },
    { key: "discoveries", label: `Discoveries${findings.length + assets.length ? ` (${findings.length + assets.length})` : ""}` },
    { key: "pending", label: `Pending${pendingApprovals.length ? ` (${pendingApprovals.length})` : ""}` },
    { key: "evidence", label: `Evidence${evidence.length ? ` (${evidence.length})` : ""}` },
  ];

  const percent = Math.max(0, Math.min(100, Number(progress?.percent || 0)));
  const phaseText = phase ? (PHASE_LABELS[phase] || phase) : "\u7b49\u5f85\u5f00\u59cb";
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
                <p className="font-sans text-sm">{activeTool}</p>
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
                  {intake.connectivity && <p className="break-all">连通�? {intake.connectivity}</p>}
                  {intake.reason && <p className="break-all text-severity-critical">{intake.reason}</p>}
                </div>
              </div>
            )}
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-muted">PLAN TREE</p>
              {planTree.length > 0 ? (
                <PlanTreeView nodes={planTree} />
              ) : (
                <p className="text-sm text-ink-muted">No plan nodes yet</p>
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
                <button key={(item.evidence_id || item.id) as string} type="button" onClick={() => onOpenEvidence?.(item as Partial<SecurityEvidence>)} data-testid="evidence-item" className="block w-full rounded-md border border-hairline-soft p-2 text-left transition-colors hover:bg-surface-default">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{(item.source_tool || item.type) as string}</span>
                    <span className="font-mono text-[10px] text-ink-muted">{item.evidence_id as string}</span>
                  </div>
                  <p className="line-clamp-3 break-words text-xs text-ink-muted [overflow-wrap:anywhere]">{String(item.summary || item.raw_ref || "")}</p>
                </button>
              ))}
            </div>
          )
        )}
      </div>
    </aside>
  );
}

function PlanTreeView({ nodes }: { nodes: PlanNode[] }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => defaultCollapsedKeys(nodes));
  const [userTouchedCollapse, setUserTouchedCollapse] = useState(false);
  const roots = buildPlanTree(nodes);
  const rows = flattenVisiblePlanTree(roots, collapsed);

  useEffect(() => {
    if (!userTouchedCollapse) setCollapsed(defaultCollapsedKeys(nodes));
  }, [nodes, userTouchedCollapse]);

  const toggle = (key: string) => {
    setUserTouchedCollapse(true);
    setCollapsed((value) => {
      const next = new Set(value);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="space-y-1.5" data-testid="plan-tree-list">
      {rows.map(({ item, depth }) => {
        const node = item.node;
        const status = String(node.status || "pending");
        const hasChildren = item.children.length > 0;
        const ToggleIcon = collapsed.has(item.key) ? ChevronRight : ChevronDown;
        return (
          <div
            key={item.key}
            data-plan-node-id={item.key}
            className="rounded-md px-2.5 py-2 transition-colors hover:bg-canvas-inset"
            style={{ marginLeft: depth ? `${Math.min(depth, 6) * 14}px` : undefined }}
          >
            <div className="flex min-w-0 items-start gap-2">
              <button
                type="button"
                aria-label={hasChildren ? `${collapsed.has(item.key) ? "Expand" : "Collapse"} plan node` : "Plan leaf node"}
                aria-expanded={hasChildren ? !collapsed.has(item.key) : undefined}
                disabled={!hasChildren}
                onClick={() => toggle(item.key)}
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm ${hasChildren ? "text-ink-muted hover:bg-canvas-inset hover:text-ink" : "cursor-default text-transparent"}`}
              >
                {hasChildren ? <ToggleIcon size={14} /> : <span className="h-1.5 w-1.5 rounded-full bg-hairline" />}
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-start justify-between gap-2">
                  <span className="min-w-0 break-words text-sm font-medium [overflow-wrap:anywhere]">{String(node.title || "Untitled plan node")}</span>
                  <span className={`shrink-0 text-[10px] uppercase ${planStatusColor(status)}`}>{status}</span>
                </div>
                <PlanNodeMeta node={node} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PlanNodeMeta({ node }: { node: PlanNode }) {
  if (node.level && node.level !== "work_item") return null;
  const location = String(node.endpoint || (node.kind && node.kind !== "phase" && node.kind !== "objective" ? node.kind : ""));
  const testDetail = node.parameter || node.vuln_type ? `${String(node.vuln_type || "test")} / ${String(node.parameter || "-")}` : "";
  if (!location && !testDetail) return null;
  return (
    <div className="mt-1 space-y-0.5">
      {location && <p className="break-words font-mono text-[11px] text-ink-muted [overflow-wrap:anywhere]">{location}</p>}
      {testDetail && <p className="break-words text-[11px] text-ink-secondary [overflow-wrap:anywhere]">{testDetail}</p>}
    </div>
  );
}

function defaultCollapsedKeys(nodes: PlanNode[]): Set<string> {
  const keys = new Set<string>();
  nodes.forEach((node, index) => {
    if (node.level === "objective") keys.add(planNodeKey(node, index));
  });
  return keys;
}

function buildPlanTree(nodes: PlanNode[]): PlanTreeItem[] {
  const items: PlanTreeItem[] = nodes.map((node, index) => ({ key: planNodeKey(node, index), node, children: [], index }));
  const byKey = new Map(items.map((item) => [item.key, item]));
  const roots: PlanTreeItem[] = [];

  for (const item of items) {
    const parentId = String(item.node.parent_id || "").trim();
    const parent = parentId ? byKey.get(parentId) : undefined;
    if (parent && parent !== item) parent.children.push(item);
    else roots.push(item);
  }

  return roots.sort(byInputOrder);
}

function flattenVisiblePlanTree(nodes: PlanTreeItem[], collapsed: Set<string>, depth = 0): VisiblePlanTreeItem[] {
  const rows: VisiblePlanTreeItem[] = [];
  for (const item of [...nodes].sort(byInputOrder)) {
    rows.push({ item, depth });
    if (!collapsed.has(item.key) && item.children.length > 0) {
      rows.push(...flattenVisiblePlanTree(item.children, collapsed, depth + 1));
    }
  }
  return rows;
}

function byInputOrder(left: PlanTreeItem, right: PlanTreeItem) {
  return left.index - right.index;
}

function planNodeKey(node: PlanNode, index: number) {
  return String(node.node_id || node.id || `plan-node-${index}`);
}

function planStatusColor(status: string) {
  if (status === "done") return "text-status-success";
  if (status === "running") return "text-status-running";
  if (status === "failed" || status === "blocked") return "text-severity-critical";
  return "text-ink-muted";
}

function normalizeIntake(intakeResult?: Record<string, unknown>, intakeStatus?: string) {
  if (!intakeResult) return null;
  const ok = intakeResult.ok === true;
  const connectivity = intakeResult.connectivity as Record<string, unknown> | undefined;
  const dns = Array.isArray(intakeResult.dns_addresses) ? intakeResult.dns_addresses.join(", ") : "";
  const connText = connectivity?.checked
    ? `${connectivity.ok ? "\u53ef\u8fbe" : "\u4e0d\u53ef\u8fbe"} ${connectivity.host || ""}${connectivity.port ? `:${connectivity.port}` : ""}`.trim()
    : "\u672a\u68c0\u67e5";
  return {
    ok,
    label: ok ? "\u901a\u8fc7" : "\u5931\u8d25",
    target: String(intakeResult.target || ""),
    dns,
    connectivity: connText,
    reason: String(intakeResult.reason || (intakeStatus === "failed" ? "\u9884\u68c0\u5931\u8d25" : "")),
  };
}
