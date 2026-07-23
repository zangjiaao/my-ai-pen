import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";

/**
 * List/load methodology skills. Default list is scoped to pack.skillIds when set.
 */
export function createSkillTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "skill",
    label: "Skill",
    description: [
      "Load methodology skills (CTF/pentest playbooks).",
      "Ops: list | load.",
      "list returns id/name/description only (no full bodies).",
      "load returns one skill body — call when you need that methodology; do not load everything.",
      "Skills never contain target answer keys.",
    ].join(" "),
    parameters: Type.Object({
      op: Type.String(),
      id: Type.Optional(Type.String()),
    }),
    async execute(_id: string, params: any) {
      const skills = runtime.skills;
      if (!skills) return textResult("error: skill store not available");
      const op = String(params.op || "list").trim().toLowerCase();
      if (op === "list") {
        const filter = runtime.skillIds?.length ? runtime.skillIds : undefined;
        const entries = await skills.list(filter);
        return jsonResult({
          ok: true,
          op: "list",
          count: entries.length,
          skills: entries.map((e) => ({
            id: e.id,
            name: e.name,
            description: e.description,
          })),
          guidance: "Load one skill with skill(op=load, id=...) when attacking that class of problem.",
        });
      }
      if (op === "load") {
        const id = String(params.id || "").trim();
        if (!id) return textResult("error: id required for load");
        const result = await skills.load(id);
        if ("error" in result) return textResult(`error: ${result.error}`);
        return jsonResult({
          ok: true,
          op: "load",
          id: result.id,
          name: result.name,
          description: result.description,
          body: result.body,
        });
      }
      return textResult("error: op must be list|load");
    },
  };
}
