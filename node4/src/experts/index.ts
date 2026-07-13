export {
  expertsCatalogRoot,
  expertsInstallRoot,
  catalogPackDir,
  installPackDir,
} from "./paths.js";
export {
  loadPackFromDir,
  loadPackFromDirSync,
  loadCatalogIndex,
  loadCatalogIndexSync,
  type LoadedPack,
  type CatalogEntry,
  type PackManifest,
} from "./load-pack.js";
export {
  DEFAULT_OFFER,
  listInstalledPackIds,
  effectiveInstalledPackIds,
  resolvePackDir,
  loadInstalledPack,
  installExpert,
  uninstallExpert,
  listExpertsStatus,
  buildAliasMap,
  normalizeToPackId,
  readInstallStamp,
  packExistsInCatalog,
  type InstallResult,
} from "./install.js";
