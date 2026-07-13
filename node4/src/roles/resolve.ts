import { getRunnablePack, isPackInstalled, PENTEST_ROLE_PACK } from "./packs.js";
import type { RolePack, RoleResolveInput } from "./types.js";

/**
 * Resolve role pack from **explicit structured fields only**.
 * Does NOT scan instruction free text for keywords (Agents.md intent rules).
 * Pack must be in the node's effective installed set (default: pentest only).
 */
export function resolveRolePack(input: RoleResolveInput): {
  pack: RolePack;
  source: "role" | "engagement" | "default";
  requested?: string;
  blocked?: boolean;
} {
  const role = typeof input.role === "string" ? input.role.trim() : "";
  const engagement = typeof input.engagement === "string" ? input.engagement.trim() : "";

  if (role) {
    const pack = getRunnablePack(role);
    if (pack) return { pack, source: "role", requested: role };
    // Explicit but not installed / unknown → conservative default if allowed
    if (!isPackInstalled(role)) {
      return {
        pack: PENTEST_ROLE_PACK,
        source: "default",
        requested: role,
        blocked: true,
      };
    }
    return { pack: PENTEST_ROLE_PACK, source: "default", requested: role };
  }
  if (engagement) {
    const pack = getRunnablePack(engagement);
    if (pack) return { pack, source: "engagement", requested: engagement };
    return {
      pack: PENTEST_ROLE_PACK,
      source: "default",
      requested: engagement,
      blocked: !isPackInstalled(engagement),
    };
  }
  // Default empty → pentest when offered (always effective when install empty)
  const def = getRunnablePack("pentest") || PENTEST_ROLE_PACK;
  return { pack: def, source: "default" };
}
