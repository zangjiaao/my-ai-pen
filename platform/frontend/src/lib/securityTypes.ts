export type RelatedVulnerability = {
  id: string;
  title: string;
  severity: string;
  status: string;
  confidence: string;
  port?: string | null;
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
  strix_vulnerability_id?: string;
  user_id?: string | null;
  conversation_id?: string | null;
  node_id?: string | null;
  title: string;
  severity: string;
  cvss?: number | null;
  cvss_breakdown?: Record<string, unknown>;
  cve_id?: string | null;
  cwe?: string | null;
  asset_id?: string | null;
  port?: string | null;
  asset?: AssetSummary | null;
  affected_asset?: string;
  location?: string;
  target?: string;
  endpoint?: string | null;
  method?: string | null;
  confidence: string;
  status: string;
  status_label?: string;
  kind?: string;
  allowed_next_statuses?: string[];
  port?: string | null;
  description?: string | null;
  impact?: string | null;
  technical_analysis?: string | null;
  poc?: string | null;
  poc_description?: string | null;
  poc_script_code?: string | null;
  remediation?: string | null;
  remediation_steps?: string | null;
  agent_id?: string | null;
  agent_name?: string | null;
  timestamp?: string | null;
  evidence_ids?: string[];
  evidence?: SecurityEvidence[];
  status_timeline?: Array<Record<string, unknown>>;
  first_seen_at?: string | null;
  discovered_at?: string | null;
  updated_at?: string | null;
  /** Times re-confirmed after first booking (platform history.rediscovered). */
  rediscovery_count?: number | null;
  discovery_count?: number | null;
  multiple_discoveries?: boolean | null;
};

export function shortId(value?: string | null) {
  return value ? value.slice(0, 8) : "-";
}

export function asString(value: unknown, fallback = "-") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}
