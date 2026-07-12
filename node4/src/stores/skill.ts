/**
 * Loadable methodology skills (CTF / pentest). Files under skills/<id>/SKILL.md.
 * List returns index only; load returns one body — never dump all into the system prompt.
 */

import { readdir, readFile, access } from "node:fs/promises";
import { join } from "node:path";

export type SkillIndexEntry = {
  id: string;
  name: string;
  description: string;
  path: string;
};

export type SkillBody = SkillIndexEntry & {
  body: string;
};

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseSkillMarkdown(raw: string, id: string, path: string): SkillBody {
  const m = FRONTMATTER_RE.exec(raw);
  let name = id;
  let description = "";
  let body = raw.trim();
  if (m) {
    const fm = m[1] || "";
    body = (m[2] || "").trim();
    for (const line of fm.split(/\r?\n/)) {
      const kv = /^(\w+):\s*(.*)$/.exec(line.trim());
      if (!kv) continue;
      const key = kv[1]!;
      const val = kv[2]!.trim().replace(/^["']|["']$/g, "");
      if (key === "name") name = val || name;
      if (key === "description") description = val;
    }
  }
  return { id, name, description, path, body };
}

/** Reject skill bodies that embed fixed challenge answer keys. */
export function skillContainsAnswerKey(body: string): boolean {
  // Concrete flag{...} tokens are not allowed in methodology skills.
  return /flag\{[a-zA-Z0-9_\-]{4,}\}/.test(body);
}

export class SkillStore {
  constructor(private readonly skillsRoot: string) {}

  async list(filterIds?: readonly string[]): Promise<SkillIndexEntry[]> {
    let dirs: string[] = [];
    try {
      const entries = await readdir(this.skillsRoot, { withFileTypes: true });
      dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
    const allow = filterIds?.length ? new Set(filterIds.map((x) => x.toLowerCase())) : null;
    const out: SkillIndexEntry[] = [];
    for (const id of dirs.sort()) {
      if (allow && !allow.has(id.toLowerCase())) continue;
      const path = join(this.skillsRoot, id, "SKILL.md");
      try {
        await access(path);
        const raw = await readFile(path, "utf8");
        const parsed = parseSkillMarkdown(raw, id, path);
        if (skillContainsAnswerKey(parsed.body)) {
          // Skip poisoned skills rather than serving answer keys.
          continue;
        }
        out.push({
          id: parsed.id,
          name: parsed.name,
          description: parsed.description,
          path: parsed.path,
        });
      } catch {
        // skip
      }
    }
    return out;
  }

  async load(id: string): Promise<SkillBody | { error: string }> {
    const safe = String(id || "")
      .trim()
      .replace(/[^a-zA-Z0-9._-]/g, "");
    if (!safe || safe !== String(id || "").trim()) {
      return { error: "invalid skill id" };
    }
    const path = join(this.skillsRoot, safe, "SKILL.md");
    try {
      const raw = await readFile(path, "utf8");
      const parsed = parseSkillMarkdown(raw, safe, path);
      if (skillContainsAnswerKey(parsed.body)) {
        return { error: "skill rejected: contains fixed flag answer key" };
      }
      return parsed;
    } catch {
      return { error: `skill not found: ${safe}` };
    }
  }
}
