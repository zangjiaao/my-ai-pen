/**
 * Run: npx tsx src/runtime/pen-tools-path.test.ts
 */
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildShellEnv, resolvePenToolsBinDir, isPenToolsPathEnabled } from "./pen-tools-path.js";
import { node4Root } from "../config.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const saved = { ...process.env };

try {
  // Repo checkout should resolve real sandbox/pen-tools/bin
  delete process.env.NODE4_PEN_TOOLS_BIN;
  delete process.env.PEN_TOOLS_BIN;
  process.env.NODE4_PEN_TOOLS = "1";
  const repoBin = resolvePenToolsBinDir();
  assert(repoBin, "resolvePenToolsBinDir finds repo sandbox/pen-tools/bin");
  assert(repoBin!.includes("sandbox/pen-tools/bin"), `path=${repoBin}`);
  assert(repoBin!.endsWith("pen-tools/bin") || repoBin!.endsWith("pen-tools/bin/"), `ends with pen-tools/bin: ${repoBin}`);

  const env = buildShellEnv({ PATH: "/usr/bin", HOME: "/tmp" });
  assert(env.PATH?.startsWith(repoBin! + ":") || env.PATH === repoBin, `PATH prepended: ${env.PATH}`);
  assert(env.PEN_TOOLS_IMAGE === "pen-tools:dev", "default PEN_TOOLS_IMAGE");

  // Disable
  process.env.NODE4_PEN_TOOLS = "0";
  assert(resolvePenToolsBinDir() === null, "disabled returns null");
  assert(isPenToolsPathEnabled() === false, "disabled flag");
  const envOff = buildShellEnv({ PATH: "/usr/bin" });
  assert(envOff.PATH === "/usr/bin", "PATH unchanged when disabled");

  // Explicit bin
  process.env.NODE4_PEN_TOOLS = "1";
  const fake = mkdtempSync(join(tmpdir(), "pen-tools-bin-"));
  writeFileSync(join(fake, "nuclei"), "#!/bin/sh\necho fake\n");
  chmodSync(join(fake, "nuclei"), 0o755);
  process.env.NODE4_PEN_TOOLS_BIN = fake;
  assert(resolvePenToolsBinDir() === fake, "explicit bin wins");
  const envFake = buildShellEnv({ PATH: "/bin" });
  assert(envFake.PATH?.startsWith(fake + ":"), "explicit prepend");
  rmSync(fake, { recursive: true, force: true });

  // Preserve existing PEN_TOOLS_IMAGE
  delete process.env.NODE4_PEN_TOOLS_BIN;
  process.env.PEN_TOOLS_IMAGE = "pen-tools:9.9.9";
  const envImg = buildShellEnv({ PATH: "/bin", PEN_TOOLS_IMAGE: "pen-tools:9.9.9" });
  assert(envImg.PEN_TOOLS_IMAGE === "pen-tools:9.9.9", "preserve image");

  console.log(
    JSON.stringify(
      {
        ok: true,
        repoBin,
        node4Root: node4Root(),
      },
      null,
      2,
    ),
  );
  console.log("RESULT: PASS — pen-tools-path");
} finally {
  for (const k of Object.keys(process.env)) {
    if (!(k in saved)) delete process.env[k];
  }
  Object.assign(process.env, saved);
}
