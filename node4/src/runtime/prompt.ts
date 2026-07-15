import type { RolePack } from "../roles/index.js";
import type { TaskEnvelope } from "../types.js";
import type { GoalStore } from "../stores/goal.js";
import { formatRoeInjection, resolveEngagementRoe } from "./engagement-roe.js";

/**
 * Build system prompt from an explicit role pack + task envelope.
 */
export function buildSystemPrompt(
  task: TaskEnvelope,
  pack: RolePack,
  options?: { goals?: GoalStore },
): string {
  const tools = pack.toolNames.join(", ");
  const roe = resolveEngagementRoe({
    engagementTemplate: task.engagementTemplate,
    engagement: task.engagement || task.role,
    allowPostex: task.allowPostex,
  });
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
    const gated = roe.allowPostex
      ? pack.skillIds
      : pack.skillIds.filter((id) => !/postex|lateral/i.test(id));
    lines.push(
      `Skills available (load on demand via skill tool): ${gated.join(", ")}.`,
      "Call skill(op=list) then skill(op=load, id=...) for methodology — do not assume full skill text is already in context.",
    );
    if (!roe.allowPostex) {
      lines.push(
        "Post-ex/lateral skills are withheld for this engagement (allow_postex=false).",
      );
    }
  }
  if (pack.recipeDir) {
    const root = (pack as { packRoot?: string }).packRoot;
    const recipePath = root ? `${root}/${pack.recipeDir}` : `experts/<pack>/${pack.recipeDir}`;
    lines.push(
      `Recipes (non-answer templates): ${recipePath} — copy into task scripts/ or follow session examples.`,
    );
  }
  lines.push(
    "Stay in authorized scope.",
    "",
    formatRoeInjection(roe),
    "",
    `Target: ${JSON.stringify(task.target)}`,
    `Scope: ${JSON.stringify(task.scope)}`,
    task.accounts !== undefined ? `Accounts: ${JSON.stringify(task.accounts)}` : "",
    `Instruction: ${task.instruction}`,
  );
  if (options?.goals) {
    lines.push("", options.goals.formatForPrompt());
  }
  return lines.filter((l) => l !== "").join("\n");
}
