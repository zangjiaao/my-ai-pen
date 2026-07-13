import { BARE_RUNTIME_ID, BARE_RUNTIME_PACK } from "./bare.js";
import { getRunnablePack, PENTEST_ROLE_PACK } from "./packs.js";
import type { RolePack, RoleResolveInput } from "./types.js";

/**
 * Resolve role pack from **explicit structured fields only**.
 * Does NOT scan instruction free text for keywords (Agents.md intent rules).
 *
 * - Blank engagement + no experts installed → **bare OMP runtime** (not pentest).
 * - Explicit engagement/role → must be installed; else blocked.
 * - Blank engagement + some experts installed → bare runtime still (opt-in experts via engagement).
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
    if (role.toLowerCase() === BARE_RUNTIME_ID) {
      return { pack: BARE_RUNTIME_PACK, source: "role", requested: role };
    }
    const pack = getRunnablePack(role);
    if (pack) return { pack, source: "role", requested: role };
    return {
      pack: PENTEST_ROLE_PACK,
      source: "default",
      requested: role,
      blocked: true,
    };
  }
  if (engagement) {
    if (engagement.toLowerCase() === BARE_RUNTIME_ID) {
      return { pack: BARE_RUNTIME_PACK, source: "engagement", requested: engagement };
    }
    const pack = getRunnablePack(engagement);
    if (pack) return { pack, source: "engagement", requested: engagement };
    return {
      pack: PENTEST_ROLE_PACK,
      source: "default",
      requested: engagement,
      blocked: true,
    };
  }
  // No structured engagement → bare OMP runtime (clean harness; experts are opt-in).
  return { pack: BARE_RUNTIME_PACK, source: "default" };
}
