import { getRolePackById, PENTEST_ROLE_PACK } from "./packs.js";
import type { RolePack, RoleResolveInput } from "./types.js";

/**
 * Resolve role pack from **explicit structured fields only**.
 * Does NOT scan instruction free text for keywords (Agents.md intent rules).
 */
export function resolveRolePack(input: RoleResolveInput): {
  pack: RolePack;
  source: "role" | "engagement" | "default";
  requested?: string;
} {
  const role = typeof input.role === "string" ? input.role.trim() : "";
  const engagement = typeof input.engagement === "string" ? input.engagement.trim() : "";

  if (role) {
    const pack = getRolePackById(role);
    if (pack) return { pack, source: "role", requested: role };
    // Unknown explicit role → conservative default, surface requested id in notes.
    return { pack: PENTEST_ROLE_PACK, source: "default", requested: role };
  }
  if (engagement) {
    const pack = getRolePackById(engagement);
    if (pack) return { pack, source: "engagement", requested: engagement };
    return { pack: PENTEST_ROLE_PACK, source: "default", requested: engagement };
  }
  return { pack: PENTEST_ROLE_PACK, source: "default" };
}
