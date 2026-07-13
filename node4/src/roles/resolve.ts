import { getRunnablePack, PENTEST_ROLE_PACK } from "./packs.js";
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
    // Explicit but not installed / unknown → blocked (do not run uninstalled packs)
    return {
      pack: PENTEST_ROLE_PACK,
      source: "default",
      requested: role,
      blocked: true,
    };
  }
  if (engagement) {
    const pack = getRunnablePack(engagement);
    if (pack) return { pack, source: "engagement", requested: engagement };
    return {
      pack: PENTEST_ROLE_PACK,
      source: "default",
      requested: engagement,
      blocked: true,
    };
  }
  // Blank engagement/role → default pentest only if pentest is in the effective installed set
  // (empty install root → virtual pentest; install-only ctf auto-seeds pentest; explicit uninstall of pentest blocks).
  const def = getRunnablePack("pentest");
  if (def) return { pack: def, source: "default" };
  return {
    pack: PENTEST_ROLE_PACK,
    source: "default",
    requested: "pentest",
    blocked: true,
  };
}
