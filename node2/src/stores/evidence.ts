import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvidenceStoreLike } from "../types.js";

type EvidenceIndexRow = {
  id: string;
  type: string;
  sourceTool: string;
  summary: string;
  path: string;
  createdAt: string;
};

export class EvidenceStore implements EvidenceStoreLike {
  private readonly rows = new Map<string, EvidenceIndexRow>();

  constructor(private readonly dir: string) {}

  async create(input: { type: string; sourceTool: string; summary: string; data: unknown }): Promise<{ id: string; path: string }> {
    await mkdir(this.dir, { recursive: true });
    const id = `ev_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const path = join(this.dir, `${id}.json`);
    const row: EvidenceIndexRow = {
      id,
      type: input.type,
      sourceTool: input.sourceTool,
      summary: input.summary,
      path,
      createdAt: new Date().toISOString(),
    };
    await writeFile(path, JSON.stringify({ ...row, data: input.data }, null, 2), "utf8");
    this.rows.set(id, row);
    return { id, path };
  }

  async read(id: string): Promise<unknown | undefined> {
    const row = this.rows.get(id);
    if (!row) return undefined;
    return JSON.parse(await readFile(row.path, "utf8")) as unknown;
  }

  async list(): Promise<EvidenceIndexRow[]> {
    return [...this.rows.values()];
  }
}
