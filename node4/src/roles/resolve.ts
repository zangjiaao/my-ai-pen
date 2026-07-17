import { BARE_RUNTIME_ID, BARE_RUNTIME_PACK } from "./bare.js";
import { DEFAULT_SEAT_ALIASES, DEFAULT_SEAT_ID, DEFAULT_SEAT_PACK } from "./default.js";
import { getRunnablePack, PENTEST_ROLE_PACK } from "./packs.js";
import type { RolePack, RoleResolveInput } from "./types.js";

function isDefaultSeatKey(raw: string): boolean {
  return DEFAULT_SEAT_ALIASES.has(raw.toLowerCase().trim());
}

/**
 * Resolve role pack from **explicit structured fields only**.
 * Does NOT scan instruction free text for keywords (Agents.md intent rules).
 *
 * - Blank engagement → **built-in default seat** (workspace assistant).
 * - default / consult / workspace → built-in default seat (always available).
 * - Explicit `runtime` → lab bare OMP pack.
 * - Other engagement/role → must be installed expert pack; else blocked.
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
    if (isDefaultSeatKey(role)) {
      return { pack: DEFAULT_SEAT_PACK, source: "role", requested: role };
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
    if (isDefaultSeatKey(engagement)) {
      return { pack: DEFAULT_SEAT_PACK, source: "engagement", requested: engagement };
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
  // No structured engagement → product default participant (workspace assistant).
  return { pack: DEFAULT_SEAT_PACK, source: "default", requested: DEFAULT_SEAT_ID };
}
