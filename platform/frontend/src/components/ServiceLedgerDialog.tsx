import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/api";
import FindingCard, { groupFindingsByKind } from "./cards/FindingCard";
import { IntelList, useAssetIntel } from "./IntelList";
import VulnDetailDialog from "./VulnDetailDialog";
import { asString, type SecurityVulnerability } from "../lib/securityTypes";

type RelatedVuln = {
  id: string;
  title: string;
  severity: string;
  status: string;
  confidence?: string;
  port?: string | null;
  description?: string | null;
};

type ServiceRow = {
  port: string;
  name?: string;
  note?: string | null;
  tags?: string[];
  paths?: { path: string; source?: string }[];
  url?: string | null;
};

type AssetDetail = {
  id: string;
  address: string;
  name: string;
  tags?: string[];
  services?: ServiceRow[];
  related_vulnerabilities?: RelatedVuln[];
};

type Tab = "edit" | "surface" | "risk" | "intel";

interface Props {
  open: boolean;
  assetId: string | null;
  port: string | null;
  knownTags?: string[];
  onClose: () => void;
  onSaved?: () => void;
}

export default function ServiceLedgerDialog({
  open,
  assetId,
  port,
  knownTags = [],
  onClose,
  onSaved,
}: Props) {
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>("edit");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [selectedVuln, setSelectedVuln] = useState<Partial<SecurityVulnerability> | null>(null);
  const { rows: intelRows } = useAssetIntel(open ? assetId : null, port);

  useEffect(() => {
    if (!open || !assetId) return;
    setTab("edit");
    setError("");
    setSelectedVuln(null);
    setLoading(true);
    authFetch<AssetDetail>(`/api/assets/${assetId}`)
      .then((data) => {
        setDetail(data);
        const svc = (data.services || []).find((s) => String(s.port) === String(port));
        setName(svc?.name || "");
        setNote(svc?.note || "");
        setTags(svc?.tags || []);
        setTagDraft("");
      })
      .catch((err) => setError(err instanceof Error ? err.message : "加载失败"))
      .finally(() => setLoading(false));
  }, [open, assetId, port]);

  const svc = useMemo(
    () => (detail?.services || []).find((s) => String(s.port) === String(port)),
    [detail, port],
  );
  const vulns = useMemo(
    () => (detail?.related_vulnerabilities || []).filter((v) => String(v.port || "") === String(port)),
    [detail, port],
  );
  const paths = svc?.paths || [];
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

  if (!open || !assetId || !port) return null;

  const addTag = (raw: string) => {
    const tag = raw.trim();
    if (!tag) return;
    setTags((prev) => (prev.some((t) => t.toLowerCase() === tag.toLowerCase()) ? prev : [...prev, tag]));
    setTagDraft("");
  };

  const save = async () => {
    setSaving(true);
    setError("");
    const nextTags = [...tags];
    const draft = tagDraft.trim();
    if (draft && !nextTags.some((t) => t.toLowerCase() === draft.toLowerCase())) nextTags.push(draft);
    try {
      const updated = await authFetch<AssetDetail>(`/api/assets/${assetId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          services: [{ port, name: name.trim(), note: note.trim(), tags: nextTags }],
        }),
      });
      setDetail(updated);
      setTags(nextTags);
      setTagDraft("");
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "edit", label: "编辑" },
    { key: "surface", label: "攻击面", count: paths.length },
    { key: "risk", label: "漏洞", count: vulns.length },
    { key: "intel", label: "情报", count: intelRows.filter((r) => (r.forget_count || 0) <= 0).length },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center theme-overlay px-4 py-6" onClick={onClose}>
      <div
        className="flex max-h-[min(90vh,720px)] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-hairline-soft bg-canvas shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-5 pt-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] text-ink-muted">端口 / 服务</p>
              <h2 className="font-mono text-lg font-semibold">
                {asString(detail?.address, "…")}:{port}
                {name ? <span className="ml-2 text-sm font-normal text-ink-muted">/{name}</span> : null}
              </h2>
              {loading ? <p className="text-[11px] text-ink-muted">加载中…</p> : null}
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
                {t.count != null && t.count > 0 ? (
                  <span className="ml-1 text-[11px] font-normal text-ink-muted">{t.count}</span>
                ) : null}
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

          {tab === "edit" ? (
            <div className="space-y-3">
              <label className="block space-y-1">
                <span className="text-[11px] text-ink-muted">服务名</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="http / ssh …"
                  className="w-full rounded-md border border-hairline bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-ink"
                />
              </label>
              <div className="space-y-1">
                <span className="text-[11px] text-ink-muted">标签</span>
                <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 py-2">
                  {tags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1 rounded-md bg-canvas-inset px-2 py-1 text-xs text-ink"
                    >
                      {tag}
                      <button
                        type="button"
                        onClick={() => setTags((prev) => prev.filter((t) => t !== tag))}
                        className="rounded text-ink-muted hover:text-severity-critical"
                        aria-label={`移除标签 ${tag}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === ",") {
                        e.preventDefault();
                        addTag(tagDraft);
                      }
                    }}
                    placeholder={tags.length ? "继续添加…" : "输入标签后回车"}
                    className="min-w-[8rem] flex-1 border-0 bg-transparent px-1 py-1 text-sm text-ink outline-none placeholder:text-ink-muted"
                  />
                  <button
                    type="button"
                    disabled={!tagDraft.trim()}
                    onClick={() => addTag(tagDraft)}
                    className="shrink-0 rounded-md border border-hairline px-2 py-1 text-[11px] text-ink-secondary hover:bg-canvas disabled:opacity-40"
                  >
                    添加
                  </button>
                </div>
                {knownTags.filter((t) => !tags.some((x) => x.toLowerCase() === t.toLowerCase())).length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {knownTags
                      .filter((t) => !tags.some((x) => x.toLowerCase() === t.toLowerCase()))
                      .slice(0, 8)
                      .map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => addTag(t)}
                          className="rounded-md border border-dashed border-hairline px-2 py-0.5 text-[11px] text-ink-secondary hover:border-ink hover:bg-surface hover:text-ink"
                        >
                          + {t}
                        </button>
                      ))}
                  </div>
                ) : null}
              </div>
              <label className="block space-y-1">
                <span className="text-[11px] text-ink-muted">备注</span>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  className="w-full rounded-md border border-hairline bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-ink"
                />
              </label>
            </div>
          ) : null}

          {tab === "surface" ? (
            paths.length ? (
              <ul className="space-y-1">
                {paths.map((p) => (
                  <li key={p.path} className="font-mono text-xs text-ink-secondary">
                    {p.path}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-muted">这个端口还没有收编路径。</p>
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
              {!vulns.length ? <p className="text-sm text-ink-muted">这个端口暂无漏洞。</p> : null}
            </div>
          ) : null}

          {tab === "intel" ? (
            <IntelList
              rows={intelRows}
              emptyCopy="这个端口还没有线索。Agent 笔记本会记在这里。"
            />
          ) : null}
        </div>

        {tab === "edit" ? (
          <div className="shrink-0 border-t border-hairline-soft px-5 py-3">
            <div className="flex justify-end">
              <button
                type="button"
                disabled={saving || loading}
                onClick={() => void save()}
                className="rounded-md bg-ink px-4 py-1.5 text-xs font-medium text-on-ink disabled:opacity-50"
              >
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <VulnDetailDialog
        open={Boolean(selectedVuln)}
        vulnerabilityId={(selectedVuln?.id || selectedVuln?.vulnerability_id) as string | undefined}
        initial={selectedVuln}
        onClose={() => setSelectedVuln(null)}
      />
    </div>
  );
}
