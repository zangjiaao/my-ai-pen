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
    console.log("default", d.pack.id, d.source, "blocked", d.blocked);
    const blocked = resolveRolePack({ engagement: "ctf" });
    console.log("ctf before install", blocked.pack.id, "blocked=", blocked.blocked);
    // Honest install-only-ctf (auto-seeds pentest)
    const onlyCtf = installExpert("ctf");
    console.log("install-only-ctf installed", onlyCtf.installed.join(","));
    const blank = resolveRolePack({});
    console.log("blank after install-only-ctf", blank.pack.id, "blocked", blank.blocked);
    const engPentest = resolveRolePack({ engagement: "pentest" });
    console.log("engagement=pentest after install-only-ctf", engPentest.pack.id, "blocked", engPentest.blocked);
    const ctf = resolveRolePack({ engagement: "ctf" });
    console.log(
      "ctf after install",
      ctf.pack.id,
      ctf.source,
      "captcha",
      toolNamesForPack(ctf.pack).includes("captcha"),
      "blocked",
      ctf.blocked,
    );
    console.log("pentest captcha?", toolNamesForPack(PENTEST_ROLE_PACK).includes("captcha"));
    console.log("distinct", ctf.pack.id !== PENTEST_ROLE_PACK.id);
    uninstallExpert("pentest");
    const blankNoP = resolveRolePack({});
    console.log("blank after uninstall pentest", blankNoP.blocked, blankNoP.pack.id);
    const after = resolveRolePack({ engagement: "ctf" });
    console.log("ctf still after pentest uninstall", after.pack.id, "blocked", after.blocked);
    uninstallExpert("ctf");
    const ctfGone = resolveRolePack({ engagement: "ctf" });
    console.log("ctf after full uninstall blocked", ctfGone.blocked, ctfGone.pack.id);
  }
  if (mode === "install" || mode === "all") {
    process.env.NODE4_EXPERTS_INSTALL = root;
    uninstallExpert("ctf");
    uninstallExpert("pentest");
    const a = installExpert("ctf");
    console.log(JSON.stringify(a));
    console.log("install has ctf", listInstalledPackIds().includes("ctf"));
    console.log("install auto-seeded pentest", listInstalledPackIds().includes("pentest"));
    console.log("catalog still", existsSync(join(expertsCatalogRoot(), "ctf", "pack.json")));
    const b = uninstallExpert("ctf");
    console.log(JSON.stringify(b));
    console.log("after uninstall ctf", listInstalledPackIds());
    console.log("catalog still after", existsSync(join(expertsCatalogRoot(), "ctf", "pack.json")));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
  delete process.env.NODE4_EXPERTS_INSTALL;
}
