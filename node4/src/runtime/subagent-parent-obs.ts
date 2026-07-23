/**
 * Child package / Hard stage → parent recentObservations for finding proof grounding.
 * Runtime-layer helper (not the subagent tool surface).
 */

import type { ToolRuntime } from "../types.js";
import { recordActObservation } from "../tools/common.js";
import {
  buildParentObservationBlob,
  type SubagentStructuredResult,
} from "./subagent-result.js";

/**
 * Record child package outputs as parent act observations for proof grounding.
 */
export function injectParentObservationsFromChild(
  runtime: ToolRuntime,
  input: {
    subagentId: string;
    nodeType?: string;
    artifactPath?: string;
    structured: SubagentStructuredResult;
    summary: string;
    rawData?: unknown;
  },
): void {
  const { structured } = input;
  const blob = buildParentObservationBlob(structured);
  const shellStdout =
    input.rawData && typeof input.rawData === "object"
      ? String((input.rawData as Record<string, unknown>).stdout || "").slice(0, 40_000)
      : "";
  const combined = [blob, shellStdout].filter(Boolean).join("\n\n").slice(0, 48_000) || input.summary;

  recordActObservation(
    runtime,
    "subagent",
    `subagent ${input.subagentId}${input.nodeType ? ` [${input.nodeType}]` : ""}: ${structured.summary.slice(0, 200)}`,
    {
      kind: "subagent_package",
      subagent_id: input.subagentId,
      node_type: input.nodeType,
      path: input.artifactPath,
      stdout: combined,
      body: combined,
      observation: combined.slice(0, 6000),
      candidates: structured.candidates,
      summary: structured.summary,
    },
    { role: "proof" },
  );

  let n = 0;
  for (const c of structured.candidates) {
    if (n >= 10) break;
    const excerpt = String(c.proof_excerpt || "").trim();
    if (excerpt.length < 16) continue;
    n += 1;
    const loc = c.location || "";
    const title = c.title || "candidate";
    const poc = c.poc_hint || "";
    const pack = [excerpt, title, loc ? `location=${loc}` : "", c.claim || "", poc ? `poc=${poc}` : ""]
      .filter(Boolean)
      .join("\n");
    // Include subagentId in summary so Hard Graph retry upsert can drop prior injects by stage key.
    recordActObservation(
      runtime,
      "subagent",
      `subagent ${input.subagentId} candidate: ${title}`.slice(0, 300),
      {
        kind: "subagent_candidate",
        subagent_id: input.subagentId,
        node_type: input.nodeType,
        title,
        location: loc,
        url: loc,
        stdout: pack,
        body: pack,
        proof: excerpt,
        observation: excerpt,
        poc_hint: poc,
      },
      { role: "proof" },
    );
  }
}
