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
export { resolveRolePack } from "./resolve.js";
