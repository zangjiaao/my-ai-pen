import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { EvidenceStoreLike } from "../types.js";

export class EvidenceStore implements EvidenceStoreLike {
  constructor(private readonly dir: string) {}

  async create(input: { type: string; sourceTool: string; summary: string; data: unknown }): Promise<{ id: string; path: string }> {
    await mkdir(this.dir, { recursive: true });
    const id = `ev_${Date.now()}_${randomBytes(3).toString("hex")}`;
    const path = join(this.dir, `${id}.json`);
    await writeFile(
      path,
      JSON.stringify(
        {
          id,
          type: input.type,
          source_tool: input.sourceTool,
          summary: input.summary,
          data: input.data,
          created_at: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
    return { id, path };
  }

  async read(id: string): Promise<unknown | undefined> {
    try {
      return JSON.parse(await readFile(join(this.dir, `${id}.json`), "utf8"));
    } catch {
      return undefined;
    }
  }

  async list(): Promise<Array<{ id: string; summary: string }>> {
    try {
      const names = await readdir(this.dir);
      const out: Array<{ id: string; summary: string }> = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const raw = JSON.parse(await readFile(join(this.dir, name), "utf8"));
        out.push({ id: String(raw.id || name), summary: String(raw.summary || "") });
      }
      return out;
    } catch {
      return [];
    }
  }
}
