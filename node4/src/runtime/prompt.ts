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
  ];
  if (pack.skillIds?.length) {
    lines.push(
      `Skills available (load on demand via skill tool): ${pack.skillIds.join(", ")}.`,
      "Call skill(op=list) then skill(op=load, id=...) for methodology — do not assume full skill text is already in context.",
    );
  }
  if (pack.recipeDir) {
    lines.push(`Recipes (non-answer templates): ${pack.recipeDir}/ — copy into task scripts/ or follow session examples.`);
  }
  lines.push(
    "Stay in authorized scope.",
    "",
    `Target: ${JSON.stringify(task.target)}`,
    `Scope: ${JSON.stringify(task.scope)}`,
    `Instruction: ${task.instruction}`,
  );
  if (options?.goals) {
    lines.push("", options.goals.formatForPrompt());
  }
  return lines.join("\n");
}
