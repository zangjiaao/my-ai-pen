import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/api";
import { asString, shortId, type SecurityAsset } from "../lib/securityTypes";

interface Props {
  open: boolean;
  assetId?: string | null;
  initial?: Partial<SecurityAsset> | null;
  onClose: () => void;
}

export default function AssetDetailDialog({ open, assetId, initial, onClose }: Props) {
  const [detail, setDetail] = useState<SecurityAsset | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const id = assetId || initial?.id || initial?.asset_id || null;

  useEffect(() => {
    if (!open) return;
    setError("");
    setDetail(normalizeInitial(initial));
    if (!id) return;
    setLoading(true);
    authFetch<SecurityAsset>(`/api/assets/${id}`)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load asset"))
      .finally(() => setLoading(false));
  }, [open, id, initial]);

  const asset = detail || normalizeInitial(initial);
  const properties = asset?.properties || {};
  const openPorts = useMemo(() => normalizePorts(asset?.open_ports || properties.open_ports), [asset?.open_ports, properties.open_ports]);
  const services = useMemo(() => normalizeServices(asset?.services || properties.services), [asset?.services, properties.services]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div className="max-h-[88vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-hairline-soft bg-canvas p-6 shadow-xl" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="break-words text-xl font-semibold">{asString(asset?.name || asset?.address, "Asset detail")}</h2>
            <p className="mt-1 break-all font-mono text-xs text-ink-muted">{asString(asset?.address)}</p>
            {loading && <p className="mt-1 text-xs text-ink-muted">Loading...</p>}
          </div>
          <button onClick={onClose} className="rounded-md border border-hairline px-3 py-1.5 text-xs hover:bg-surface-default">Close</button>
        </div>

        {error && <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        <div className="grid gap-3 md:grid-cols-4">
          <Info label="Type" value={asString(asset?.type || asset?.asset_type)} />
          <Info label="Source" value={asString(asset?.source)} />
          <Info label="Session" value={shortId(asset?.conversation_id)} />
          <Info label="Node" value={shortId(asset?.node_id)} />
          <Info label="Last Scan" value={asset?.updated_at?.slice(0, 19) || "-"} />
          <Info label="Created" value={asset?.created_at?.slice(0, 19) || "-"} />
        </div>

        <section className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase text-ink-secondary">Ports</h3>
          {openPorts.length ? (
            <div className="flex flex-wrap gap-2">
              {openPorts.map((port) => <span key={port} className="rounded-md border border-hairline bg-canvas-inset px-2.5 py-1 font-mono text-xs">{port}</span>)}
            </div>
          ) : <p className="text-sm text-ink-muted">No open ports recorded</p>}
        </section>

        <section className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase text-ink-secondary">Services</h3>
          {services.length ? (
            <div className="overflow-hidden rounded-md border border-hairline-soft">
              <table className="w-full table-fixed text-sm">
                <thead className="bg-surface-default text-left text-xs uppercase text-ink-secondary">
                  <tr><th className="px-3 py-2">Port</th><th className="px-3 py-2">Name</th><th className="px-3 py-2">Version</th></tr>
                </thead>
                <tbody>
                  {services.map((service, index) => (
                    <tr key={`${service.port}-${index}`} className="border-t border-hairline-soft">
                      <td className="px-3 py-2 font-mono text-xs">{asString(service.port)}</td>
                      <td className="px-3 py-2 break-words">{asString(service.name || service.service)}</td>
                      <td className="px-3 py-2 break-words text-ink-secondary">{asString(service.version || service.product)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="text-sm text-ink-muted">No service fingerprints recorded</p>}
        </section>


        <section className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase text-ink-secondary">Scan History</h3>
          <HistoryList value={properties.scan_history || properties.service_history || properties.port_history} fallback={asset?.updated_at ? [`${asset.updated_at}: ${asset.source || "agent"}`] : []} />
        </section>
        <section className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase text-ink-secondary">Related Vulnerabilities</h3>
          <div className="space-y-2">
            {asset?.related_vulnerabilities?.map((vuln) => (
              <div key={vuln.id} className="rounded-md border border-hairline-soft p-2">
                <div className="break-words text-sm font-medium">{vuln.title}</div>
                <div className="mt-1 flex flex-wrap gap-2 text-xs text-ink-muted"><span>{vuln.severity}</span><span>{vuln.status}</span><span>{vuln.confidence}</span></div>
              </div>
            ))}
            {!asset?.related_vulnerabilities?.length && <p className="text-sm text-ink-muted">No related vulnerabilities</p>}
          </div>
        </section>

        <section className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase text-ink-secondary">Raw Properties</h3>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-canvas-inset p-3 font-mono text-xs">{JSON.stringify(properties, null, 2)}</pre>
        </section>
      </div>
    </div>
  );
}

function normalizeInitial(initial?: Partial<SecurityAsset> | null): SecurityAsset | null {
  if (!initial) return null;
  return {
    id: String(initial.id || initial.asset_id || ""),
    asset_id: initial.asset_id,
    conversation_id: initial.conversation_id,
    node_id: initial.node_id,
    name: asString(initial.name || initial.address, "Unknown asset"),
    address: asString(initial.address),
    type: asString(initial.type || initial.asset_type, "host"),
    asset_type: initial.asset_type,
    tags: initial.tags || [],
    properties: initial.properties || {},
    open_ports: initial.open_ports,
    services: initial.services,
    source: initial.source,
    related_vulnerabilities: initial.related_vulnerabilities || [],
    created_at: initial.created_at,
    updated_at: initial.updated_at,
  };
}

function normalizePorts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item)).filter(Boolean))].sort((a, b) => Number(a) - Number(b));
}

function normalizeServices(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-canvas-inset p-2">
      <div className="text-xs text-ink-muted">{label}</div>
      <div className="mt-1 truncate font-mono text-xs">{value || "-"}</div>
    </div>
  );
}

function HistoryList({ value, fallback }: { value: unknown; fallback: string[] }) {
  const items = Array.isArray(value) ? value : fallback;
  if (!items.length) return <p className="text-sm text-ink-muted">No scan history recorded</p>;
  return (
    <div className="space-y-2">
      {items.slice(0, 10).map((item, index) => (
        <div key={index} className="rounded-md border border-hairline-soft p-2 text-xs text-ink-secondary">
          <pre className="whitespace-pre-wrap break-words font-mono [overflow-wrap:anywhere]">{typeof item === "string" ? item : JSON.stringify(item, null, 2)}</pre>
        </div>
      ))}
    </div>
  );
}