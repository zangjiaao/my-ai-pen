import type { CoverageStatus, CoverageStoreLike } from "../types.js";

type CoverageRow = {
  endpoint: string;
  param: string;
  vulnClass: string;
  status: CoverageStatus;
  count: number;
  notes?: string;
  firstSeen: string;
  lastSeen: string;
};

export class CoverageStore implements CoverageStoreLike {
  private readonly rows = new Map<string, CoverageRow>();

  async mark(input: {
    endpoint: string;
    param: string;
    vulnClass: string;
    status: CoverageStatus;
    notes?: string;
  }): Promise<Record<string, unknown>> {
    const key = this.key(input.endpoint, input.param, input.vulnClass);
    const now = new Date().toISOString();
    const existing = this.rows.get(key);
    const status = mergeStatus(existing?.status, input.status);
    const row: CoverageRow = existing
      ? { ...existing, status, notes: input.notes || existing.notes, count: existing.count + 1, lastSeen: now }
      : {
          endpoint: input.endpoint,
          param: input.param,
          vulnClass: input.vulnClass,
          status,
          notes: input.notes,
          count: 1,
          firstSeen: now,
          lastSeen: now,
        };
    this.rows.set(key, row);
    return row;
  }

  async list(filter: { endpoint?: string; param?: string; vulnClass?: string } = {}): Promise<Record<string, unknown>[]> {
    return this.listSync(filter);
  }

  listSync(filter: { endpoint?: string; param?: string; vulnClass?: string } = {}): Record<string, unknown>[] {
    return [...this.rows.values()].filter((row) => {
      if (filter.endpoint && !row.endpoint.includes(filter.endpoint)) return false;
      if (filter.param && row.param !== filter.param) return false;
      if (filter.vulnClass && row.vulnClass !== filter.vulnClass) return false;
      return true;
    });
  }

  async untested(candidates: Array<{ endpoint: string; param: string }>, vulnClasses: string[]): Promise<Record<string, unknown>[]> {
    const out: Array<{ endpoint: string; param: string; vulnClass: string }> = [];
    for (const candidate of candidates) {
      for (const vulnClass of vulnClasses) {
        if (!this.rows.has(this.key(candidate.endpoint, candidate.param, vulnClass))) {
          out.push({ endpoint: candidate.endpoint, param: candidate.param, vulnClass });
        }
      }
    }
    return out;
  }

  async summary(): Promise<Record<string, unknown>> {
    const byStatus: Record<string, number> = {};
    const byClass: Record<string, number> = {};
    for (const row of this.rows.values()) {
      byStatus[row.status] = (byStatus[row.status] || 0) + 1;
      byClass[row.vulnClass] = (byClass[row.vulnClass] || 0) + 1;
    }
    return { total: this.rows.size, byStatus, byClass };
  }

  private key(endpoint: string, param: string, vulnClass: string): string {
    return `${endpoint}\u0000${param}\u0000${vulnClass}`.toLowerCase();
  }
}

function mergeStatus(existing: CoverageStatus | undefined, next: CoverageStatus): CoverageStatus {
  if (!existing) return next;
  const rank: Record<CoverageStatus, number> = {
    observed: 0,
    tried: 1,
    skipped: 2,
    blocked: 3,
    failed: 4,
    passed: 4,
  };
  return rank[next] >= rank[existing] ? next : existing;
}
