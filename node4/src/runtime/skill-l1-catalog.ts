/**
 * Wave 2 progressive skill disclosure — host L1 catalog (Spec #274).
 * Host injects id/name/description; Agent must skill(load) for L2 body.
 * Orthogonal to hypothesis_work_mode.
 */

import type { SkillIndexEntry, SkillStore } from "../stores/skill.js";

export type SkillL1Entry = {
  id: string;
  name: string;
  description: string;
};

/** Map SkillStore list → L1-only fields (never bodies). */
export function toSkillL1Entries(entries: SkillIndexEntry[]): SkillL1Entry[] {
  return entries.map((e) => ({
    id: e.id,
    name: e.name,
    description: e.description,
  }));
}

/**
 * Host auto L1 catalog injection when skill is on the tool surface.
 * Does not include skill bodies.
 */
export function formatSkillL1CatalogInjection(
  entries: SkillL1Entry[] | undefined | null,
  options?: { max?: number },
): string {
  if (!entries?.length) return "";
  const max = options?.max ?? 80;
  const slice = entries.slice(0, max);
  const lines = slice.map(
    (e) => `- id=${e.id} name=${e.name} — ${String(e.description || "").slice(0, 200)}`,
  );
  return [
    "<skill-l1-catalog>",
    "Host L1 catalog (id/name/description only). Load one body with skill(op=load, id=…) when needed — do not bulk-load all bodies.",
    `count=${slice.length}`,
    ...lines,
    "</skill-l1-catalog>",
  ].join("\n");
}

/** True when L1 text contains no full SKILL body markers / huge dumps. */
export function skillL1InjectionHasNoBodies(injection: string): boolean {
  if (!injection) return true;
  // Bodies typically include markdown headings after frontmatter; L1 must not paste handbook sections.
  if (/^#{1,3}\s+How to/m.test(injection)) return false;
  if (injection.length > 12000) return false;
  if (/<\/skill-l1-catalog>[\s\S]{500,}/.test(injection)) return false;
  return injection.includes("<skill-l1-catalog>");
}

export async function loadSkillL1Catalog(
  skills: SkillStore | undefined | null,
  skillIds?: readonly string[],
): Promise<SkillL1Entry[]> {
  if (!skills) return [];
  const filter = skillIds?.length ? skillIds : undefined;
  const listed = await skills.list(filter);
  return toSkillL1Entries(listed);
}
