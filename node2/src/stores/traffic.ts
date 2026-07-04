import type { CapturedTraffic, TrafficStoreLike } from "../types.js";

export class TrafficStore implements TrafficStoreLike {
  private readonly rows = new Map<string, CapturedTraffic>();
  private latestSnapshot?: Record<string, unknown>;

  add(input: CapturedTraffic): string {
    const id = input.id || `tr_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    this.rows.set(id, { ...input, id, receivedAt: input.receivedAt || new Date().toISOString() });
    return id;
  }

  list(filter: { urlContains?: string; method?: string; limit?: number } = {}): CapturedTraffic[] {
    const limit = Math.max(1, Math.min(filter.limit || 50, 500));
    return [...this.rows.values()]
      .filter((row) => {
        if (filter.urlContains && !row.url.includes(filter.urlContains)) return false;
        if (filter.method && row.method.toUpperCase() !== filter.method.toUpperCase()) return false;
        return true;
      })
      .slice(-limit)
      .reverse();
  }

  get(id: string): CapturedTraffic | undefined {
    return this.rows.get(id);
  }

  endpoints(): Array<{ endpoint: string; method: string; params: string[]; count: number }> {
    const grouped = new Map<string, { endpoint: string; method: string; params: Set<string>; count: number }>();
    for (const row of this.rows.values()) {
      const url = new URL(row.url);
      const key = `${row.method.toUpperCase()} ${url.pathname}`;
      const entry = grouped.get(key) || { endpoint: url.pathname, method: row.method.toUpperCase(), params: new Set<string>(), count: 0 };
      for (const param of url.searchParams.keys()) entry.params.add(param);
      entry.count += 1;
      grouped.set(key, entry);
    }
    return [...grouped.values()].map((entry) => ({
      endpoint: entry.endpoint,
      method: entry.method,
      params: [...entry.params].sort(),
      count: entry.count,
    }));
  }

  snapshot(): Record<string, unknown> | undefined {
    return this.latestSnapshot;
  }

  setSnapshot(snapshot: Record<string, unknown>): void {
    this.latestSnapshot = { ...snapshot, receivedAt: new Date().toISOString() };
  }
}
