/**
 * Spec #541 — Surface tab home is Host cards (pending Workset / admitted Hosts).
 * Path tree lives in per-Host detail. Search is isolated from RightPanel.
 */
import { useMemo, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { handleTypedInput, useRenderAudit } from "../lib/renderAudit";
import {
  extractHost,
  filterHostCards,
  type HostCard,
  type HostCardViewFilter,
} from "../lib/hostCardProjection";
import { authFetch } from "../lib/api";
import type { WorksetProjection } from "../lib/workset";
import type { SecurityVulnerability } from "../lib/securityTypes";
import FindingCard from "./cards/FindingCard";
import { IntelList } from "./IntelList";
import ConfirmDialog from "./ConfirmDialog";
import {
  attachFindingsToSurface,
  buildSurfaceTree,
  SurfaceTreeView,
  type SurfaceKnownAsset,
} from "./SurfaceInventory";

const FILTERS: { value: HostCardViewFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "待准入" },
  { value: "admitted", label: "已准入" },
  { value: "untested", label: "Untested" },
  { value: "findings", label: "Findings" },
];

export default function SurfaceHostCards({
  cards,
  knownAssets = [],
  conversationId,
  currentTaskId,
  selectedId = null,
  onSelect,
  onOpenVulnerability,
  onEnrolledAsset,
  onWorksetUpdated,
}: {
  cards: HostCard[];
  knownAssets?: SurfaceKnownAsset[];
  conversationId?: string | null;
  currentTaskId?: string | null;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  onOpenVulnerability?: (finding: Partial<SecurityVulnerability>) => void;
  onEnrolledAsset?: (asset: Record<string, unknown>) => void;
  onWorksetUpdated?: (workset: WorksetProjection) => void;
}) {
  useRenderAudit("SurfaceHostCards");
  const [query, setQuery] = useState("");
  const [viewFilter, setViewFilter] = useState<HostCardViewFilter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<{ kind: "adopt" | "reject"; card: HostCard } | null>(null);

  const selected = cards.find((c) => c.id === selectedId) || null;
  const filtered = useMemo(() => filterHostCards(cards, query, viewFilter), [cards, query, viewFilter]);
  const counts = useMemo(
    () => ({
      all: cards.length,
      pending: cards.filter((c) => c.admission === "pending").length,
      admitted: cards.filter((c) => c.admission === "admitted").length,
      untested: cards.filter((c) => c.admission === "admitted" && c.untestedCount > 0).length,
      findings: cards.filter((c) => c.findingCount > 0).length,
    }),
    [cards],
  );

  const patchWorkset = async (card: HostCard, status: "adopted" | "rejected") => {
    if (!conversationId || !card.worksetItemId) return;
    setBusyId(card.id);
    setError("");
    try {
      const out = await authFetch<{
        workset?: WorksetProjection;
        registered_asset?: Record<string, unknown>;
      }>(`/api/conversations/${conversationId}/workset/${encodeURIComponent(card.worksetItemId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (out.workset) onWorksetUpdated?.(out.workset);
      if (out.registered_asset) onEnrolledAsset?.(out.registered_asset);
      if (status === "adopted" && out.registered_asset) {
        const hid = String(out.registered_asset.id || out.registered_asset.asset_id || "");
        if (hid) onSelect?.(hid);
      }
      setConfirm(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Workset update failed");
    } finally {
      setBusyId(null);
    }
  };

  if (selected) {
    return (
      <div className="space-y-3" data-testid="surface-host-detail">
        <button
          type="button"
          data-testid="surface-host-back"
          onClick={() => onSelect?.(null)}
          className="inline-flex items-center gap-1 text-[12px] text-ink-muted hover:text-ink"
        >
          <ChevronLeft size={14} />
          Surface
        </button>
        <HostDetail
          card={selected}
          knownAssets={knownAssets}
          currentTaskId={currentTaskId}
          conversationId={conversationId}
          onOpenVulnerability={onOpenVulnerability}
          onEnrolledAsset={onEnrolledAsset}
          onAskAdopt={() => setConfirm({ kind: "adopt", card: selected })}
          onAskReject={() => setConfirm({ kind: "reject", card: selected })}
          busy={busyId === selected.id}
        />
        {error ? <p className="text-[12px] text-severity-critical">{error}</p> : null}
        <ConfirmDialog
          open={Boolean(confirm)}
          title={confirm?.kind === "reject" ? "拒绝准入" : "纳入 Scope"}
          description={
            confirm?.kind === "reject"
              ? `拒绝 ${confirm.card.address}？仍留在 Workset，不会建成 Owner Host。`
              : `把 ${confirm?.card.address || ""} 登记为 Host 并扩本 Case Scope？`
          }
          confirmLabel={confirm?.kind === "reject" ? "拒绝" : "纳入"}
          busy={Boolean(busyId)}
          error={error || null}
          onCancel={() => {
            if (!busyId) {
              setConfirm(null);
              setError("");
            }
          }}
          onConfirm={() => {
            if (confirm) void patchWorkset(confirm.card, confirm.kind === "reject" ? "rejected" : "adopted");
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="surface-host-cards">
      <div className="flex flex-wrap items-center gap-2" data-testid="surface-toolbar">
        <input
          type="search"
          value={query}
          onChange={handleTypedInput("SurfaceHostCards", setQuery)}
          placeholder="Search host…"
          data-testid="surface-search"
          className="min-w-0 flex-1 rounded-md border border-hairline bg-canvas px-2.5 py-1.5 text-[12px] text-ink placeholder:text-ink-muted outline-none focus:border-ink"
          aria-label="Search host cards"
        />
        <select
          value={viewFilter}
          onChange={(e) => setViewFilter(e.target.value as HostCardViewFilter)}
          data-testid="surface-view-filter"
          className="shrink-0 rounded-md border border-hairline bg-canvas px-2 py-1.5 text-[12px] text-ink outline-none focus:border-ink"
          aria-label="Filter host cards"
        >
          {FILTERS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label} ({counts[opt.value]})
            </option>
          ))}
        </select>
      </div>
      {filtered.length === 0 ? (
        <p className="text-sm text-ink-muted" data-testid="surface-empty">
          {cards.length === 0 ? "No Hosts in this Case yet" : "No hosts match search/filter"}
        </p>
      ) : (
        <div className="space-y-2">
          {filtered.map((card) => (
            <button
              key={card.id}
              type="button"
              data-testid={`surface-host-card-${card.id}`}
              data-admission={card.admission}
              onClick={() => onSelect?.(card.id)}
              className="flex w-full flex-col rounded-lg border border-hairline bg-canvas px-3 py-2.5 text-left hover:bg-surface-default"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-[13px] font-medium text-ink">{card.address}</span>
                <span
                  className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] ${
                    card.admission === "pending"
                      ? "bg-status-running/12 text-status-running"
                      : "bg-status-success/15 text-status-success"
                  }`}
                >
                  {card.admission === "pending" ? "待准入" : "已准入"}
                </span>
              </div>
              {card.aliases.length > 0 ? (
                <span className="mt-0.5 truncate font-mono text-[11px] text-ink-muted">{card.aliases.join(" · ")}</span>
              ) : null}
              <div className="mt-1.5 flex flex-wrap gap-1.5 text-[10px] text-ink-muted">
                {card.admission === "admitted" && card.untestedCount > 0 ? <span>untested {card.untestedCount}</span> : null}
                {card.findingCount > 0 ? <span>findings {card.findingCount}</span> : null}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function HostDetail({
  card,
  knownAssets,
  currentTaskId,
  conversationId,
  onOpenVulnerability,
  onEnrolledAsset,
  onAskAdopt,
  onAskReject,
  busy,
}: {
  card: HostCard;
  knownAssets: SurfaceKnownAsset[];
  currentTaskId?: string | null;
  conversationId?: string | null;
  onOpenVulnerability?: (finding: Partial<SecurityVulnerability>) => void;
  onEnrolledAsset?: (asset: Record<string, unknown>) => void;
  onAskAdopt: () => void;
  onAskReject: () => void;
  busy: boolean;
}) {
  const surfaceKeyList = card.paths.map((e) => e.key);
  const findingAttachment = attachFindingsToSurface(card.findings, surfaceKeyList, card.paths);
  const tree = buildSurfaceTree(card.paths, findingAttachment.byPath);
  const identity = new Set(
    [card.address, ...card.aliases].map((h) => extractHost(h)).filter(Boolean),
  );
  const ports = [
    ...new Set(
      knownAssets.flatMap((asset) => {
        const names = [asset.address, ...(asset.aliases || [])].map((h) => extractHost(h));
        if (!names.some((n) => identity.has(n))) return [];
        return (asset.ports || []).map((p) => String(p).trim()).filter(Boolean);
      }),
    ),
  ];

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center justify-between gap-2">
          <h3 className="truncate font-mono text-sm font-medium text-ink">{card.address}</h3>
          <span
            className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] ${
              card.admission === "pending"
                ? "bg-status-running/12 text-status-running"
                : "bg-status-success/15 text-status-success"
            }`}
          >
            {card.admission === "pending" ? "待准入" : "已准入"}
          </span>
        </div>
        {card.aliases.map((a) => (
          <p key={a} className="font-mono text-[11px] text-ink-muted">
            {a}
          </p>
        ))}
      </div>

      {card.admission === "pending" ? (
        <section className="space-y-2" data-testid="surface-pending-detail">
          <dl className="space-y-1 text-[12px] text-ink-secondary">
            {card.intelSource ? (
              <div>
                <dt className="text-ink-muted">source</dt>
                <dd>{card.intelSource}</dd>
              </div>
            ) : null}
            {card.attribution ? (
              <div>
                <dt className="text-ink-muted">attribution</dt>
                <dd>{card.attribution}</dd>
              </div>
            ) : null}
            {card.confidence ? (
              <div>
                <dt className="text-ink-muted">confidence</dt>
                <dd>{card.confidence}</dd>
              </div>
            ) : null}
            {card.scopeDecision ? (
              <div>
                <dt className="text-ink-muted">scope</dt>
                <dd>{card.scopeDecision}</dd>
              </div>
            ) : null}
          </dl>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="surface-host-adopt"
              disabled={busy}
              onClick={onAskAdopt}
              className="rounded-md bg-ink px-3 py-1.5 text-[12px] font-medium text-on-ink disabled:opacity-50"
            >
              纳入
            </button>
            <button
              type="button"
              data-testid="surface-host-reject"
              disabled={busy}
              onClick={onAskReject}
              className="rounded-md border border-hairline px-3 py-1.5 text-[12px] text-ink disabled:opacity-50"
            >
              拒绝
            </button>
          </div>
        </section>
      ) : (
        <>
          {ports.length > 0 ? (
            <section className="space-y-1" data-testid="surface-host-ports">
              <p className="text-xs font-medium text-ink-muted">Ports</p>
              <p className="font-mono text-[12px] text-ink">{ports.join(" · ")}</p>
            </section>
          ) : null}
          {tree.length > 0 ? (
            <SurfaceTreeView
              roots={tree}
              total={card.paths.length}
              findingsTotal={card.findingCount}
              knownAssets={knownAssets}
              onOpenVulnerability={onOpenVulnerability}
              onEnrolledAsset={onEnrolledAsset}
            />
          ) : (
            <p className="text-[12px] text-ink-muted">No paths on this Host yet</p>
          )}
          {card.findings.length > 0 ? (
            <section className="space-y-2">
              <p className="text-xs font-medium text-ink-muted">Findings ({card.findings.length})</p>
              {card.findings.map((finding, index) => (
                <FindingCard
                  key={String(finding.id || index)}
                  finding={finding}
                  onOpen={onOpenVulnerability}
                />
              ))}
            </section>
          ) : null}
          <IntelList
            rows={card.intel}
            currentTaskId={currentTaskId}
            conversationId={conversationId}
            emptyCopy="这台主机还没有线索。Agent 笔记本会记在这里。"
            showHang={false}
            showArchive={false}
          />
        </>
      )}
    </div>
  );
}
