export type { BookingMode, RolePack, RoleResolveInput } from "./types.js";
export {
  PENTEST_ROLE_PACK,
  CTF_ROLE_PACK,
  CONSULT_STUB_ROLE_PACK,
  registerRolePack,
  clearExtraRolePacks,
  listRolePackIds,
  getRolePackById,
  getRunnablePack,
  isPackInstalled,
  skillsRootForPack,
} from "./packs.js";
export { BARE_RUNTIME_ID, BARE_RUNTIME_PACK } from "./bare.js";
export { resolveRolePack } from "./resolve.js";
