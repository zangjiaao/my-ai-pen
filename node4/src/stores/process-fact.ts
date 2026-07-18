/**
 * Process-cognition facts (CyberStrike A2/A5 adapted) — separate from finding booking.
 *
 * Stored under taskDir/facts/<safe_key>.json. Never creates platform host assets
 * (IP/domain rows remain user-created only per PRD).
 *
 * Index inject = key + summary only; full body via get / read tool.
 */

import { mkdir, readdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

export type ProcessFact = {
  fact_key: string;
  summary: string;
  body: string;
  category?: string;
  updated_at: string;
};

export type ProcessFactIndexEntry = {
  fact_key: string;
  summary: string;
  category?: string;
  updated_at: string;
};

const KEY_SAFE = /^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,120}$/;
const MAX_SUMMARY = 400;
const MAX_BODY = 50_000;
const MAX_INDEX_INJECT = 40;

function safeKey(raw: string): string | null {
  const k = String(raw || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/");
  if (!KEY_SAFE.test(k)) return null;
  if (k.includes("..")) return null;
  return k;
}

function fileNameForKey(key: string): string {
  return `${key.replace(/\//g, "__")}.json`;
}

export class ProcessFactStore {
  constructor(private readonly factsDir: string) {}

  async ensureDir(): Promise<void> {
    await mkdir(this.factsDir, { recursive: true });
  }

  async upsert(input: {
    fact_key: string;
    summary: string;
    body: string;
    category?: string;
  }): Promise<ProcessFact | { error: string }> {
    const key = safeKey(input.fact_key);
    if (!key) {
      return {
        error:
          "invalid fact_key (use category/slug like target/primary_url, auth/session-cookie; alphanumerics _ . / -)",
      };
    }
    const summary = String(input.summary || "")
      .trim()
      .slice(0, MAX_SUMMARY);
    if (summary.length < 2) return { error: "summary required (what + where + how verified)" };
    const body = String(input.body || "")
      .trim()
      .slice(0, MAX_BODY);
    if (body.length < 2) return { error: "body required (repro context; not invent from summary alone later)" };

    await this.ensureDir();
    const fact: ProcessFact = {
      fact_key: key,
      summary,
      body,
      category: input.category != null ? String(input.category).trim().slice(0, 64) || undefined : undefined,
      updated_at: new Date().toISOString(),
    };
    const path = join(this.factsDir, fileNameForKey(key));
    await writeFile(path, JSON.stringify(fact, null, 2), "utf8");
    return fact;
  }

  async get(fact_key: string): Promise<ProcessFact | { error: string }> {
    const key = safeKey(fact_key);
    if (!key) return { error: "invalid fact_key" };
    try {
      const raw = await readFile(join(this.factsDir, fileNameForKey(key)), "utf8");
      const parsed = JSON.parse(raw) as ProcessFact;
      if (!parsed?.fact_key) return { error: "corrupt fact file" };
      return parsed;
    } catch {
      return { error: `fact not found: ${key}` };
    }
  }

  async list(): Promise<ProcessFactIndexEntry[]> {
    await this.ensureDir();
    let names: string[] = [];
    try {
      names = await readdir(this.factsDir);
    } catch {
      return [];
    }
    const out: ProcessFactIndexEntry[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(this.factsDir, name), "utf8");
        const f = JSON.parse(raw) as ProcessFact;
        if (!f?.fact_key) continue;
        out.push({
          fact_key: f.fact_key,
          summary: String(f.summary || "").slice(0, MAX_SUMMARY),
          category: f.category,
          updated_at: f.updated_at || "",
        });
      } catch {
        // skip corrupt
      }
    }
    out.sort((a, b) => String(a.fact_key).localeCompare(String(b.fact_key)));
    return out;
  }

  /** Test helper — remove one fact. */
  async delete(fact_key: string): Promise<boolean> {
    const key = safeKey(fact_key);
    if (!key) return false;
    try {
      await unlink(join(this.factsDir, fileNameForKey(key)));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Short index for system/prompt inject. Never includes full bodies.
 * Instructs agent to call fact(get) rather than invent detail from summaries.
 */
export function formatProcessFactIndexInjection(
  entries: ProcessFactIndexEntry[] | undefined | null,
): string {
  if (!entries?.length) return "";
  const slice = entries.slice(0, MAX_INDEX_INJECT);
  const lines = [
    "## Process facts index (task workspace — not findings)",
    "Short summaries only. **Do not invent detail from a summary.** Call `fact(op=get, fact_key=...)` or `read` the body under `facts/` when you need repro steps, ports, auth state, or failed probes.",
    "Process facts ≠ product vulns: book confirmed issues with `finding(confirm)` + grounded proof. Host IP/domain asset rows are **user-created only** — facts must not create assets.",
    "Write-as-you-go: when you **confirm** a new cognition, upsert a fact immediately (do not wait for session end).",
  ];
  for (const e of slice) {
    const cat = e.category ? ` [${e.category}]` : "";
    lines.push(`- \`${e.fact_key}\`${cat}: ${e.summary}`);
  }
  if (entries.length > MAX_INDEX_INJECT) {
    lines.push(`…(+${entries.length - MAX_INDEX_INJECT} more — fact(op=list))`);
  }
  return lines.join("\n");
}
