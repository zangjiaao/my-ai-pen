import type { CapturedTraffic, TrafficStoreLike } from "../types.js";

export class TrafficStore implements TrafficStoreLike {
  private readonly rows = new Map<string, CapturedTraffic>();
  private latestSnapshot?: Record<string, unknown>;

  add(input: CapturedTraffic): string {
    const id = input.id || `tr_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const normalized = normalizeTraffic({ ...input, id, receivedAt: input.receivedAt || new Date().toISOString() });
    this.rows.set(id, normalized);
    return id;
  }

  list(filter: { urlContains?: string; method?: string; limit?: number; replayableOnly?: boolean } = {}): CapturedTraffic[] {
    const limit = Math.max(1, Math.min(filter.limit || 50, 500));
    return [...this.rows.values()]
      .filter((row) => {
        if (filter.urlContains && !row.url.includes(filter.urlContains)) return false;
        if (filter.method && row.method.toUpperCase() !== filter.method.toUpperCase()) return false;
        if (filter.replayableOnly && !isReplayable(row)) return false;
        return true;
      })
      .slice(-limit)
      .reverse();
  }

  get(id: string): CapturedTraffic | undefined {
    return this.rows.get(id);
  }

  endpoints(): Array<{ endpoint: string; method: string; params: string[]; count: number; trafficIds: string[] }> {
    const grouped = new Map<string, { endpoint: string; method: string; params: Set<string>; count: number; trafficIds: string[] }>();
    for (const row of this.rows.values()) {
      const url = new URL(row.url);
      const key = `${row.method.toUpperCase()} ${url.pathname}`;
      const entry = grouped.get(key) || { endpoint: url.pathname, method: row.method.toUpperCase(), params: new Set<string>(), count: 0, trafficIds: [] };
      for (const param of url.searchParams.keys()) entry.params.add(param);
      for (const param of bodyParamNames(row.requestBody || "", row.requestHeaders || {})) entry.params.add(param);
      entry.count += 1;
      if (row.id) entry.trafficIds.push(row.id);
      grouped.set(key, entry);
    }
    return [...grouped.values()].map((entry) => ({
      endpoint: entry.endpoint,
      method: entry.method,
      params: [...entry.params].sort(),
      count: entry.count,
      trafficIds: entry.trafficIds.slice(-10),
    }));
  }

  candidates(limit = 20): CapturedTraffic[] {
    return [...this.rows.values()]
      .filter(isReplayable)
      .map((row) => ({ row, score: candidateScore(row) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(limit, 100)))
      .map((item) => item.row);
  }

  snapshot(): Record<string, unknown> | undefined {
    return this.latestSnapshot;
  }

  setSnapshot(snapshot: Record<string, unknown>): void {
    this.latestSnapshot = { ...snapshot, receivedAt: new Date().toISOString() };
  }
}

function normalizeTraffic(row: CapturedTraffic): CapturedTraffic {
  const method = (row.method || "GET").toUpperCase();
  return {
    ...row,
    method,
    requestHeaders: lowerHeaders(row.requestHeaders || {}),
    responseHeaders: lowerHeaders(row.responseHeaders || {}),
    tags: [...new Set([...(row.tags || []), ...inferTags({ ...row, method })])],
  };
}

function lowerHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers || {})) out[key.toLowerCase()] = String(value);
  return out;
}

function inferTags(row: CapturedTraffic): string[] {
  const tags = new Set<string>();
  const url = new URL(row.url);
  const params = [...url.searchParams.keys(), ...bodyParamNames(row.requestBody || "", row.requestHeaders || {})];
  if (params.length) tags.add("parameterized");
  if (!["GET", "HEAD", "OPTIONS"].includes(row.method.toUpperCase())) tags.add("state-changing");
  if (row.requestHeaders?.cookie || row.requestHeaders?.authorization) tags.add("authenticated-context");
  if (looksLikeForm(row)) tags.add("form");
  if (url.pathname.toLowerCase().includes("upload") || /multipart\/form-data/i.test(row.requestHeaders?.["content-type"] || "")) tags.add("upload");
  if (url.pathname.toLowerCase().includes("api") || /application\/json/i.test(row.requestHeaders?.["content-type"] || "")) tags.add("api");
  return [...tags];
}

function candidateScore(row: CapturedTraffic): number {
  const tags = new Set(row.tags || []);
  let score = 0;
  if (tags.has("parameterized")) score += 50;
  if (tags.has("state-changing")) score += 25;
  if (tags.has("authenticated-context")) score += 20;
  if (tags.has("form")) score += 15;
  if (tags.has("upload")) score += 20;
  if (tags.has("api")) score += 10;
  if ((row.status || 0) >= 200 && (row.status || 0) < 500) score += 5;
  return score;
}

function isReplayable(row: CapturedTraffic): boolean {
  if (!row.url || !/^https?:\/\//i.test(row.url)) return false;
  if (row.method.toUpperCase() !== "GET" && row.requestBody === undefined) return false;
  return candidateScore(row) > 0;
}

function bodyParamNames(body: string, headers: Record<string, string>): string[] {
  if (!body) return [];
  const contentType = headers["content-type"] || headers["Content-Type"] || "";
  const params = new Set<string>();
  if (/application\/x-www-form-urlencoded/i.test(contentType) || body.includes("=")) {
    try {
      for (const key of new URLSearchParams(body).keys()) {
        if (key) params.add(key);
      }
    } catch {
      // Ignore malformed bodies.
    }
  }
  if (/application\/json/i.test(contentType)) {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const key of Object.keys(parsed)) params.add(key);
      }
    } catch {
      // Ignore malformed JSON.
    }
  }
  if (/multipart\/form-data/i.test(contentType) || /Content-Disposition:\s*form-data/i.test(body)) {
    for (const match of body.matchAll(/Content-Disposition:\s*form-data;[^\n\r]*\bname=["']([^"'\r\n]+)["']/gi)) {
      params.add(match[1]);
    }
  }
  return [...params];
}

function looksLikeForm(row: CapturedTraffic): boolean {
  const body = `${row.requestBody || ""}\n${row.responseBody || ""}`;
  return /<form\b|application\/x-www-form-urlencoded|multipart\/form-data|Content-Disposition:\s*form-data/i.test(body);
}
