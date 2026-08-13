import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/api";
import ConfirmDialog from "./ConfirmDialog";
import FindingCard, { groupFindingsByKind } from "./cards/FindingCard";
import VulnDetailDialog from "./VulnDetailDialog";
import { type SecurityVulnerability } from "../lib/securityTypes";

type RelatedVuln = {
  id: string;
  title: string;
  severity: string;
  status: string;
  confidence?: string;
  port?: string | null;
  description?: string | null;
};

type CatalogAsset = {
  id: string;
  address: string;
  name: string;
  tags: string[];
  services?: { port: string; name?: string; tags?: string[]; paths?: { path: string }[] }[];
  related_vulnerabilities?: RelatedVuln[];
};

type Member = { asset_id: string; ports: string[] };

type Tab = "members" | "surface" | "risk" | "intel";

interface Props {
  open: boolean;
  group: { id: string; name: string; members: Member[] } | null;
  catalog: CatalogAsset[];
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
  onOpenHost: (assetId: string) => void;
  onOpenService: (assetId: string, port: string) => void;
}

export default function GroupLedgerDialog({
  open,
  group,
  catalog,
  onClose,
  onSaved,
  onDeleted,
  onOpenHost,
  onOpenService,
}: Props) {
  const [tab, setTab] = useState<Tab>("members");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [addHostId, setAddHostId] = useState("");
  const [addPorts, setAddPorts] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [selectedVuln, setSelectedVuln] = useState<Partial<SecurityVulnerability> | null>(null);

  useEffect(() => {
    if (!open || !group) return;
    setTab("members");
    setName(group.name);
    setError("");
    setConfirmDelete(false);
    setAddHostId("");
    setAddPorts([]);
  }, [open, group?.id, group?.name]);

  const catalogById = useMemo(() => new Map(catalog.map((a) => [a.id, a])), [catalog]);
  const members = group?.members || [];
  const memberAssets = members
    .map((m) => ({ member: m, asset: catalogById.get(m.asset_id) }))
    .filter((row): row is { member: Member; asset: CatalogAsset } => Boolean(row.asset));

  const unusedHosts = catalog.filter((a) => !members.some((m) => m.asset_id === a.id));
  const addTarget = catalogById.get(addHostId);
  const addPortOptions = (addTarget?.services || []).map((s) => s.port).filter(Boolean);

  const vulns = useMemo(() => {
    const rows: RelatedVuln[] = [];
    for (const { member, asset } of memberAssets) {
      for (const v of asset.related_vulnerabilities || []) {
        if (!member.ports.length || !v.port || member.ports.includes(String(v.port))) {
          rows.push(v);
        }
      }
    }
    return rows;
  }, [memberAssets]);

  const paths = useMemo(() => {
    const out: { host: string; port: string; path: string }[] = [];
    for (const { member, asset } of memberAssets) {
      for (const svc of asset.services || []) {
        if (member.ports.length && !member.ports.includes(svc.port)) continue;
        for (const p of svc.paths || []) {
          if (p.path) out.push({ host: asset.address, port: svc.port, path: p.path });
        }
      }
    }
    return out;
  }, [memberAssets]);

  const riskGroups = useMemo(
    () =>
      groupFindingsByKind(
        vulns.map((v) => ({
          id: v.id,
          title: v.title,
          severity: v.severity,
          status: v.status,
          confidence: v.confidence,
          port: v.port,
          description: v.description,
        })),
      ),
    [vulns],
  );

  if (!open || !group) return null;

  const saveName = async () => {
    const next = name.trim();
    if (!next) {
      setError("组名不能为空");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await authFetch(`/api/asset-groups/${group.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: next }),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "重命名失败");
    } finally {
      setSaving(false);
    }
  };

  const removeHost = async (assetId: string) => {
    setError("");
    try {
      await authFetch(`/api/asset-groups/${group.id}/hosts/${assetId}`, { method: "DELETE" });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "移出失败");
    }
  };

  const addHost = async () => {
    if (!addHostId) {
      setError("请选择主机");
      return;
    }
    setAdding(true);
    setError("");
    try {
      await authFetch(`/api/asset-groups/${group.id}/hosts/${addHostId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ports: addPorts }),
      });
      setAddHostId("");
      setAddPorts([]);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "装入失败");
    } finally {
      setAdding(false);
    }
  };

  const deleteGroup = async () => {
    setDeleting(true);
    try {
      await authFetch(`/api/asset-groups/${group.id}`, { method: "DELETE" });
      setConfirmDelete(false);
      onDeleted();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除组失败");
    } finally {
      setDeleting(false);
    }
  };

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "members", label: "组装", count: members.length },
    { key: "surface", label: "攻击面", count: paths.length },
    { key: "risk", label: "漏洞", count: vulns.length },
    { key: "intel", label: "情报" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center theme-overlay px-4 py-6" onClick={onClose}>
      <div
        className="flex max-h-[min(90vh,760px)] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-hairline-soft bg-canvas shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-5 pt-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-ink-muted">组</p>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => {
                  if (name.trim() && name.trim() !== group.name) void saveName();
                }}
                className="w-full border-0 bg-transparent text-lg font-semibold outline-none focus:ring-0"
              />
            </div>
            <button type="button" onClick={onClose} className="rounded-md border px-3 py-1.5 text-xs">
              关闭
            </button>
          </div>
        </div>

        <div className="shrink-0 border-b border-hairline-soft px-5">
          <div className="flex gap-4">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`px-0.5 py-2.5 text-[13px] font-medium ${
                  tab === t.key
                    ? "border-b-2 border-ink text-ink"
                    : "border-b-2 border-transparent text-ink-secondary hover:text-ink"
                }`}
              >
                {t.label}
                {t.count != null ? <span className="ml-1 text-[11px] font-normal text-ink-muted">{t.count}</span> : null}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error ? (
            <div className="mb-3 rounded-md border border-severity-critical/30 bg-severity-critical-subtle px-3 py-2 text-sm text-severity-critical">
              {error}
            </div>
          ) : null}

          {tab === "members" ? (
            <div className="space-y-3">
              {memberAssets.map(({ member, asset }) => (
                <div key={asset.id} className="rounded-md border border-hairline-soft px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      className="truncate font-mono text-sm hover:underline"
                      onClick={() => onOpenHost(asset.id)}
                    >
                      {asset.address}
                    </button>
                    <button
                      type="button"
                      className="text-[11px] text-ink-muted hover:text-severity-critical"
                      onClick={() => void removeHost(asset.id)}
                    >
                      移出
                    </button>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {member.ports.length ? (
                      member.ports.map((port) => (
                        <button
                          key={port}
                          type="button"
                          onClick={() => onOpenService(asset.id, port)}
                          className="rounded-md border border-hairline bg-canvas-inset px-1.5 py-0.5 font-mono text-[11px] hover:border-ink"
                        >
                          {port}
                        </button>
                      ))
                    ) : (
                      <span className="text-[11px] text-ink-muted">裸主机</span>
                    )}
                  </div>
                </div>
              ))}
              {!memberAssets.length ? <p className="text-sm text-ink-muted">组内还没有主机。</p> : null}

              <div className="rounded-md border border-dashed border-hairline px-3 py-2.5">
                <p className="text-[11px] font-medium text-ink-secondary">装入主机</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <select
                    value={addHostId}
                    onChange={(e) => {
                      setAddHostId(e.target.value);
                      setAddPorts([]);
                    }}
                    className="min-w-[10rem] flex-1 rounded-md border border-hairline px-2 py-1.5 text-sm"
                  >
                    <option value="">选择主机…</option>
                    {unusedHosts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.address}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={adding || !addHostId}
                    onClick={() => void addHost()}
                    className="rounded-md bg-ink px-3 py-1.5 text-xs font-medium text-on-ink disabled:opacity-50"
                  >
                    {adding ? "写入…" : "装入"}
                  </button>
                </div>
                {addPortOptions.length ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {addPortOptions.map((port) => (
                      <label key={port} className="inline-flex items-center gap-1 text-[11px]">
                        <input
                          type="checkbox"
                          checked={addPorts.includes(port)}
                          onChange={() =>
                            setAddPorts((prev) =>
                              prev.includes(port) ? prev.filter((p) => p !== port) : [...prev, port],
                            )
                          }
                        />
                        <span className="font-mono">{port}</span>
                      </label>
                    ))}
                    <span className="text-[11px] text-ink-muted">不勾 = 裸主机</span>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {tab === "surface" ? (
            paths.length ? (
              <ul className="space-y-1">
                {paths.map((p) => (
                  <li key={`${p.host}:${p.port}:${p.path}`} className="font-mono text-xs text-ink-secondary">
                    <button type="button" className="hover:underline" onClick={() => onOpenService(catalog.find((a) => a.address === p.host)?.id || "", p.port)}>
                      {p.host}:{p.port}
                    </button>{" "}
                    {p.path}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-muted">本组还没有收编路径。订洞或被接受的 HTTP(S) 会挂到端口下。</p>
            )
          ) : null}

          {tab === "risk" ? (
            <div className="space-y-3">
              {riskGroups.map((g) =>
                g.items.length === 0 ? null : (
                  <section key={g.id} className="space-y-2">
                    <p className="text-xs font-medium text-ink-muted">
                      {g.label} ({g.items.length})
                    </p>
                    {g.items.map((finding, index) => (
                      <FindingCard
                        key={String(finding.id || `${g.id}-${index}`)}
                        finding={finding}
                        onOpen={setSelectedVuln}
                      />
                    ))}
                  </section>
                ),
              )}
              {!vulns.length ? <p className="text-sm text-ink-muted">本组组装范围内暂无漏洞。</p> : null}
            </div>
          ) : null}

          {tab === "intel" ? (
            <p className="text-sm leading-relaxed text-ink-muted">
              情报块还没接入。组 / 主机 / 端口的档案位已经留好，不会用空话填充。
            </p>
          ) : null}
        </div>

        <div className="shrink-0 border-t border-hairline-soft px-5 py-3">
          <button
            type="button"
            className="text-xs text-severity-critical hover:underline"
            onClick={() => setConfirmDelete(true)}
          >
            删除组
          </button>
        </div>
      </div>

      <VulnDetailDialog
        open={Boolean(selectedVuln)}
        vulnerabilityId={(selectedVuln?.id || selectedVuln?.vulnerability_id) as string | undefined}
        initial={selectedVuln}
        onClose={() => setSelectedVuln(null)}
      />
      <ConfirmDialog
        open={confirmDelete}
        title="删除组"
        description={`确定删除组「${group.name}」？主机会回到未分组，不会删除主机。`}
        busy={deleting}
        confirmLabel="删除组"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void deleteGroup()}
      />
    </div>
  );
}
