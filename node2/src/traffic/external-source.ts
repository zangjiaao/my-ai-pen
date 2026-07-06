import { createHash } from "node:crypto";
import type { CapturedTraffic, ExternalTrafficSourceLike } from "../types.js";

export class JsonTrafficSource implements ExternalTrafficSourceLike {
  readonly kind = "json-http";

  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
  ) {}

  async status(): Promise<Record<string, unknown>> {
    const statusUrl = new URL("status", normalizedBase(this.baseUrl));
    try {
      return {
        configured: true,
        kind: this.kind,
        baseUrl: this.baseUrl,
        reachable: true,
        upstream: await this.fetchJson(statusUrl),
      };
    } catch (error) {
      return {
        configured: true,
        kind: this.kind,
        baseUrl: this.baseUrl,
        reachable: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async list(filter: { urlContains?: string; method?: string; limit?: number } = {}): Promise<CapturedTraffic[]> {
    const url = new URL("traffic", normalizedBase(this.baseUrl));
    if (filter.urlContains) url.searchParams.set("url_contains", filter.urlContains);
    if (filter.method) url.searchParams.set("method", filter.method);
    if (filter.limit) url.searchParams.set("limit", String(filter.limit));
    const raw = await this.fetchJson(url);
    return extractRows(raw).map((row) => normalizeExternalRow(row, this.kind));
  }

  async get(id: string): Promise<CapturedTraffic | undefined> {
    const url = new URL(`traffic/${encodeURIComponent(id)}`, normalizedBase(this.baseUrl));
    const raw = await this.fetchJson(url);
    const row = extractRows(raw)[0] || raw;
    if (!row || typeof row !== "object") return undefined;
    return normalizeExternalRow(row as Record<string, unknown>, this.kind);
  }

  private async fetchJson(url: URL): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
  }
}

export function createExternalTrafficSource(input: { url?: string; token?: string }): ExternalTrafficSourceLike | undefined {
  if (!input.url) return undefined;
  return new JsonTrafficSource(input.url, input.token);
}

function normalizedBase(raw: string): string {
  return raw.endsWith("/") ? raw : `${raw}/`;
}

function extractRows(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw.filter(isRecord);
  if (!isRecord(raw)) return [];
  for (const key of ["traffic", "requests", "items", "rows", "data"]) {
    const value = raw[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [raw];
}

function normalizeExternalRow(row: Record<string, unknown>, sourceKind: string): CapturedTraffic {
  const externalId = stringValue(row.id) || stringValue(row.traffic_id) || stringValue(row.request_id) || fingerprint(row);
  const requestHeaders = recordOfString(row.requestHeaders) || recordOfString(row.request_headers) || recordOfString(row.headers) || {};
  const responseHeaders = recordOfString(row.responseHeaders) || recordOfString(row.response_headers) || {};
  const requestBody = stringValue(row.requestBody) ?? stringValue(row.request_body) ?? stringValue(row.body);
  const responseBody = stringValue(row.responseBody) ?? stringValue(row.response_body);
  const tags = arrayOfString(row.tags);
  return {
    id: `external_${safeId(externalId)}`,
    source: stringValue(row.source) || sourceKind,
    method: stringValue(row.method)?.toUpperCase() || "GET",
    url: stringValue(row.url) || "",
    status: numberValue(row.status) ?? numberValue(row.status_code),
    requestHeaders,
    requestBody,
    responseHeaders,
    responseBody,
    tags,
    parentTrafficId: stringValue(row.parentTrafficId) || stringValue(row.parent_traffic_id),
    receivedAt: stringValue(row.receivedAt) || stringValue(row.received_at) || stringValue(row.timestamp),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function recordOfString(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) out[key] = String(item ?? "");
  return out;
}

function arrayOfString(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => String(item)).filter(Boolean);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120);
}

function fingerprint(row: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(row)).digest("hex").slice(0, 24);
}
