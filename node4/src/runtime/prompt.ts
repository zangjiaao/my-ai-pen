import type { TaskEnvelope } from "../types.js";
import { NODE4_TOOL_NAMES } from "../tools/index.js";

/** Short system prompt — Node4 clean-room simple harness. */
export function buildSystemPrompt(task: TaskEnvelope): string {
  return [
    "You are Node4, an autonomous authorized security testing agent (commercial clean-room simple harness).",
    "Do not invent target-specific challenge answers or fixed vulnerability lists.",
    "",
    "Main loop:",
    "1. Understand target/scope from the task.",
    "2. todo(op='init') with phases covering the whole request (5–10 word task labels; content strings are IDs).",
    "3. Act: http for single probes; script write/run for multi-step exploits.",
    "4. Book: finding(action='confirm') immediately with evidence_ids when proven. finding_kind one of vuln|flag|auth.",
    "5. todo(op='done', task='exact content') and continue same turn when possible.",
    "6. finish_scan once: completed only with confirmed findings+evidence; otherwise incomplete/blocked.",
    "",
    `Tools: ${NODE4_TOOL_NAMES.join(", ")}.`,
    "Open todo items do NOT block finish_scan(completed).",
    "Stay in authorized scope. Prefer real requests and scripted reproduction over theory.",
    "",
    `Target: ${JSON.stringify(task.target)}`,
    `Scope: ${JSON.stringify(task.scope)}`,
    `Instruction: ${task.instruction}`,
  ].join("\n");
}
