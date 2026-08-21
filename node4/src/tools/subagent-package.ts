/**
 * Subagent package schema + resolve (extracted so subagent tool stays under 1k lines).
 * Spec #139 dual-use fields are first-class on the agent-visible schema.
 */

import { Type } from "typebox";

export type ResolvedPackage = {
  target: string;
  scope: string;
  already_done: string;
  this_turn_goal: string;
  success_criteria: string;
  assignment?: string;
  skill_id?: string;
  node_type?: string;
  goal_id?: string;
  plan_node_id?: string;
  command?: string;
  timeout_seconds: number;
  resume_agent_id?: string;
  /** Spec #139 NC-Prior: re-verify packages name prior Store ids. */
  prior_finding_ids?: string[];
  package_kind?: string;
  class_key?: string;
  title?: string;
};

/** Shared package fields (flat + batch item) — Spec #139 dual-use surface. */
export const packagePriorFields = {
  prior_finding_ids: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Spec #139 re-verify: Finding Store prior id(s). Required when package_kind=re-verify; this-run fresh proof still required.",
    }),
  ),
  package_kind: Type.Optional(
    Type.String({
      description:
        "discovery (default) | re-verify. re-verify may hit prior paths; discovery host-hard-fails pathKey∩class collision.",
    }),
  ),
  class_key: Type.Optional(
    Type.String({
      description: "Attack class id for pathKey∩class avoid matching (e.g. sqli, xss, rce).",
    }),
  ),
  title: Type.Optional(
    Type.String({
      description: "Optional finding title stem for avoid matching when class_key omitted.",
    }),
  ),
};

export const packageItemSchema = Type.Object({
  target: Type.Optional(
    Type.String({
      description: "Package target. Omit to inherit top-level target (same as scope/already_done).",
    }),
  ),
  scope: Type.Optional(Type.String()),
  already_done: Type.Optional(Type.String()),
  this_turn_goal: Type.String(),
  success_criteria: Type.String(),
  assignment: Type.Optional(Type.String()),
  skill_id: Type.Optional(Type.String()),
  node_type: Type.Optional(Type.String()),
  goal_id: Type.Optional(Type.String()),
  plan_node_id: Type.Optional(
    Type.String({
      description:
        "Hard Graph L2 todo node_id to attach the Worker chip (preferred over title/goal fuzzy match).",
    }),
  ),
  todo_node_id: Type.Optional(Type.String({ description: "Alias of plan_node_id" })),
  command: Type.Optional(Type.String()),
  timeout_seconds: Type.Optional(Type.Number()),
  resume_agent_id: Type.Optional(
    Type.String({
      description:
        "Warm follow-up: prior agent_id. Same path required; orthogonal targets must omit (cold spawn).",
    }),
  ),
  ...packagePriorFields,
});

export function resolvePackageInput(
  top: Record<string, unknown>,
  item: Record<string, unknown> | null,
  index: number,
): { pkg: ResolvedPackage } | { error: string } {
  const src = item ?? top;
  const context = String(top.context || "").trim();
  const defaultScope = String(top.scope || "").trim();
  const defaultDone = String(top.already_done || "").trim();
  const defaultTimeout = Math.min(Math.max(Number(top.timeout_seconds || 120), 1), 300);

  const target = String(src.target ?? top.target ?? "").trim();
  const scope = String(src.scope ?? defaultScope).trim();
  let already_done = String(src.already_done ?? defaultDone).trim();
  if (context) {
    already_done = already_done
      ? `## Shared context\n${context}\n\n## Already done\n${already_done}`
      : `## Shared context\n${context}`;
  }
  const this_turn_goal = String(src.this_turn_goal ?? (item ? "" : top.this_turn_goal) ?? "").trim();
  const success_criteria = String(
    src.success_criteria ?? (item ? "" : top.success_criteria) ?? "",
  ).trim();

  if (!target || !scope || !already_done || !this_turn_goal || !success_criteria) {
    const mode = item ? `packages[${index}]` : "flat subagent";
    return {
      error:
        `error: ${mode} incomplete handoff — need target, scope, already_done, this_turn_goal, success_criteria ` +
        `(batch may inherit target/scope/already_done from top-level; context fills shared background).`,
    };
  }

  const timeout_seconds = Math.min(
    Math.max(Number(src.timeout_seconds ?? defaultTimeout), 1),
    300,
  );

  return {
    pkg: {
      target,
      scope,
      already_done,
      this_turn_goal,
      success_criteria,
      assignment: src.assignment != null ? String(src.assignment) : undefined,
      skill_id: src.skill_id != null ? String(src.skill_id).trim() : undefined,
      node_type:
        src.node_type != null
          ? String(src.node_type).trim()
          : item
            ? undefined
            : top.node_type != null
              ? String(top.node_type).trim()
              : undefined,
      goal_id: src.goal_id != null ? String(src.goal_id).trim() : undefined,
      plan_node_id: (() => {
        const raw =
          src.plan_node_id ??
          src.todo_node_id ??
          (!item ? top.plan_node_id ?? top.todo_node_id : undefined);
        return raw != null ? String(raw).trim() || undefined : undefined;
      })(),
      command: src.command != null ? String(src.command).trim() : undefined,
      resume_agent_id:
        src.resume_agent_id != null
          ? String(src.resume_agent_id).trim()
          : !item && top.resume_agent_id != null
            ? String(top.resume_agent_id).trim()
            : undefined,
      timeout_seconds,
      prior_finding_ids: (() => {
        const raw =
          src.prior_finding_ids ??
          src.prior_store_ids ??
          (!item ? top.prior_finding_ids : undefined);
        if (Array.isArray(raw)) return raw.map((x) => String(x || "").trim()).filter(Boolean);
        if (typeof raw === "string" && raw.trim()) {
          return raw
            .split(/[\s,]+/)
            .map((x) => x.trim())
            .filter(Boolean);
        }
        return undefined;
      })(),
      package_kind:
        src.package_kind != null
          ? String(src.package_kind).trim()
          : !item && top.package_kind != null
            ? String(top.package_kind).trim()
            : undefined,
      class_key: src.class_key != null ? String(src.class_key).trim() : undefined,
      title: src.title != null ? String(src.title).trim() : undefined,
    },
  };
}
