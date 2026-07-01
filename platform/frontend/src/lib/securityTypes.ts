export type RelatedVulnerability = {
  id: string;
  title: string;
  severity: string;
  status: string;
  confidence: string;
};

export type SecurityAsset = {
  id: string;
  asset_id?: string;
  user_id?: string | null;
  conversation_id?: string | null;
  node_id?: string | null;
  name: string;
  address: string;
  type: string;
  asset_type?: string;
  tags?: string[];
  properties?: Record<string, unknown>;
  open_ports?: Array<number | string>;
  services?: Array<Record<string, unknown>>;
  source?: string;
  related_vulnerabilities?: RelatedVulnerability[];
  created_at?: string | null;
  updated_at?: string | null;
};

export type AssetSummary = {
  id: string;
  name: string;
  address: string;
  type: string;
};

export type SecurityEvidence = {
  id: string;
  evidence_id: string;
  type: string;
  conversation_id?: string | null;
  node_id?: string | null;
  source_tool?: string | null;
  tool_run_id?: string | null;
  raw_ref?: string | null;
  summary?: string | null;
  hash?: string | null;
  properties?: Record<string, unknown>;
  created_at?: string | null;
};

export type SecurityVulnerability = {
  id: string;
  vulnerability_id?: string;
  user_id?: string | null;
  conversation_id?: string | null;
  node_id?: string | null;
  title: string;
  severity: string;
  cvss?: number | null;
  cve_id?: string | null;
  asset_id?: string | null;
  asset?: AssetSummary | null;
  affected_asset?: string;
  location?: string;
  confidence: string;
  status: string;
  description?: string | null;
  poc?: string | null;
  remediation?: string | null;
  evidence_ids?: string[];
  evidence?: SecurityEvidence[];
  status_timeline?: Array<Record<string, unknown>>;
  discovered_at?: string | null;
  updated_at?: string | null;
};

export function shortId(value?: string | null) {
  return value ? value.slice(0, 8) : "-";
}

export function asString(value: unknown, fallback = "-") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}
