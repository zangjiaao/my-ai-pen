import type { RolePack } from "../roles/index.js";
import type { TaskEnvelope } from "../types.js";
import type { GoalStore } from "../stores/goal.js";

/**
 * Build system prompt from an explicit role pack + task envelope.
 */
export function buildSystemPrompt(
  task: TaskEnvelope,
  pack: RolePack,
  options?: { goals?: GoalStore },
): string {
  const tools = pack.toolNames.join(", ");
  const lines = [
    ...pack.missionLines,
    "",
    ...pack.workLines,
    "",
    `Role pack: ${pack.id} (${pack.label}).`,
    `Tools: ${tools}.`,
    `Booking mode: ${pack.bookingMode}. ${pack.settlementNote}`,
    "Stay in authorized scope.",
    "",
    `Target: ${JSON.stringify(task.target)}`,
    `Scope: ${JSON.stringify(task.scope)}`,
    `Instruction: ${task.instruction}`,
  ];
  if (options?.goals) {
    lines.push("", options.goals.formatForPrompt());
  }
  return lines.join("\n");
}
