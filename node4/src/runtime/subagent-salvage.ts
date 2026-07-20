/**
 * When a child stops without result.json, salvage evidence from workDir artifacts
 * so Main can still book or deadend instead of blindly re-dispatching.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeSubagentResult, type SubagentStructuredResult } from "./subagent-result.js";
import type { SubagentHandoffFields } from "./subagent-handoff.js";

const MAX_FILES = 24;
const MAX_FILE_CHARS = 12_000;

async function collectTextSnippets(workDir: string): Promise<string[]> {
  const snippets: string[] = [];
  const dirs = ["tool-output", "evidence", "facts"];
  for (const d of dirs) {
    const dir = join(workDir, d);
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names.slice(0, MAX_FILES)) {
      try {
        const raw = await readFile(join(dir, name), "utf8");
        const text = raw.slice(0, MAX_FILE_CHARS).trim();
        if (text.length >= 24) snippets.push(text);
      } catch {
        /* skip */
      }
    }
  }
  return snippets;
}

function pickProofExcerpt(snippet: string): string {
  // Prefer JSON stdout/body fields
  try {
    const o = JSON.parse(snippet) as Record<string, unknown>;
    for (const k of ["stdout", "body", "output", "response", "proof_excerpt", "text"]) {
      const v = o[k];
      if (typeof v === "string" && v.trim().length >= 24) return v.trim().slice(0, 4000);
    }
    const nested = o.data;
    if (nested && typeof nested === "object") {
      const d = nested as Record<string, unknown>;
      for (const k of ["stdout", "body", "output"]) {
        const v = d[k];
        if (typeof v === "string" && v.trim().length >= 24) return v.trim().slice(0, 4000);
      }
    }
  } catch {
    /* plain text */
  }
  return snippet.slice(0, 4000);
}

/**
 * Build a structured package from on-disk child artifacts when result.json is missing.
 */
export async function salvageSubagentResult(input: {
  workDir: string;
  handoff: SubagentHandoffFields;
  toolsUsed: number;
  aborted?: boolean;
  fallbackSummary?: string;
}): Promise<SubagentStructuredResult> {
  const snippets = await collectTextSnippets(input.workDir);
  const location = String(input.handoff.target || "").trim() || undefined;
  const candidates = [];
  for (const snip of snippets.slice(-6)) {
    const proof = pickProofExcerpt(snip);
    if (proof.length < 24) continue;
    candidates.push({
      title: `Salvaged evidence @ ${location || "target"}`.slice(0, 200),
      location,
      claim: `Child stopped without result.json; harness salvaged tool output for ${input.handoff.this_turn_goal}`.slice(
        0,
        500,
      ),
      proof_excerpt: proof,
      poc_hint: `Re-run request against ${location || "target"} and confirm response matches salvaged excerpt.`.slice(
        0,
        500,
      ),
    });
    if (candidates.length >= 3) break;
  }

  const summary =
    candidates.length > 0
      ? `subagent finished without result.json — salvaged ${candidates.length} candidate(s) from tool-output/facts (tools=${input.toolsUsed})`
      : input.fallbackSummary ||
        (input.toolsUsed > 0
          ? "subagent finished (no result.json — incomplete structure; no salvageable tool output)"
          : "subagent stopped without tools or result.json");

  return normalizeSubagentResult(
    {
      ok: candidates.length > 0 && !input.aborted,
      summary,
      candidates,
      surfaces: [],
      facts: [],
      deadends: candidates.length
        ? ["result_json_missing_salvaged"]
        : input.toolsUsed > 0
          ? ["missing_result_json"]
          : ["no_tools_no_result"],
      artifacts: [],
      notes: "Harness salvage — prefer explicit result.json next time.",
    },
    summary,
  );
}
