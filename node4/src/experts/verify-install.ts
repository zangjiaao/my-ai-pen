/**
 * Small harness for verification captures (install/resolve). Not part of product CLI.
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRolePack, PENTEST_ROLE_PACK } from "../roles/index.js";
import { toolNamesForPack } from "../tools/index.js";
import {
  installExpert,
  uninstallExpert,
  listInstalledPackIds,
  effectiveInstalledPackIds,
  expertsCatalogRoot,
} from "./index.js";

const mode = process.argv[2] || "all";
const root = mkdtempSync(join(tmpdir(), "node4-exp-verify-"));
process.env.NODE4_EXPERTS_INSTALL = root;

try {
  if (mode === "resolve" || mode === "all") {
    console.log("empty effective", effectiveInstalledPackIds());
    const d = resolveRolePack({});
    console.log("default", d.pack.id, d.source);
    const blocked = resolveRolePack({ engagement: "ctf" });
    console.log("ctf before install", blocked.pack.id, "blocked=", blocked.blocked);
    installExpert("pentest");
    installExpert("ctf");
    const ctf = resolveRolePack({ engagement: "ctf" });
    console.log(
      "ctf after install",
      ctf.pack.id,
      ctf.source,
      "captcha",
      toolNamesForPack(ctf.pack).includes("captcha"),
    );
    console.log("pentest captcha?", toolNamesForPack(PENTEST_ROLE_PACK).includes("captcha"));
    console.log("distinct", ctf.pack.id !== PENTEST_ROLE_PACK.id);
    uninstallExpert("ctf");
    const after = resolveRolePack({ engagement: "ctf" });
    console.log("ctf after uninstall blocked", after.blocked, after.pack.id);
  }
  if (mode === "install" || mode === "all") {
    process.env.NODE4_EXPERTS_INSTALL = root;
    // clean reinstall path
    uninstallExpert("ctf");
    const a = installExpert("ctf");
    console.log(JSON.stringify(a));
    console.log("install has ctf", listInstalledPackIds().includes("ctf"));
    console.log("catalog still", existsSync(join(expertsCatalogRoot(), "ctf", "pack.json")));
    const b = uninstallExpert("ctf");
    console.log(JSON.stringify(b));
    console.log("after uninstall", listInstalledPackIds());
    console.log("catalog still after", existsSync(join(expertsCatalogRoot(), "ctf", "pack.json")));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
  delete process.env.NODE4_EXPERTS_INSTALL;
}
