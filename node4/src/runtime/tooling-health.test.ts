/**
 * Run: npx tsx src/runtime/tooling-health.test.ts
 * Drives real probeToolingHealth / recordToolingHealthAtTaskStart (injectable deps for degraded path).
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatToolingHealthReport,
  probeToolingHealth,
  recordToolingHealthAtTaskStart,
  shouldEmitToolingHealth,
  type ToolingHealthDeps,
  type ToolingHealthReport,
} from "./tooling-health.js";
import type { PlatformSink, TaskEnvelope } from "../types.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const saved = { ...process.env };

function baseDeps(overrides: Partial<ToolingHealthDeps> = {}): ToolingHealthDeps {
  return {
    resolveImage: () => "pen-sandbox:test",
    imageExists: () => false,
    isShellInContainer: () => false,
    isPathEnabled: () => true,
    resolveBinDir: () => null,
    checkHostTool: () => ({ present: false, path: null }),
    checkContainerTools: () => ({}),
    now: () => "2026-07-18T00:00:00.000Z",
    ...overrides,
  };
}

try {
  // --- shouldEmitToolingHealth ---
  assert(
    shouldEmitToolingHealth({ chatOnly: true, toolNames: ["shell", "todo"] }) === false,
    "chat-only skips health",
  );
  assert(
    shouldEmitToolingHealth({ chatOnly: false, toolNames: ["todo", "read"] }) === false,
    "no shell skips health",
  );
  assert(
    shouldEmitToolingHealth({ chatOnly: false, toolNames: ["todo", "shell"] }) === true,
    "execution + shell emits health",
  );

  // --- Degraded: no image, no host tools ---
  const degraded = probeToolingHealth({
    deps: baseDeps(),
    checkContainerBinaries: true,
  });
  assert(degraded.gating === false, "gating always false");
  assert(degraded.degraded === true, "degraded when nuclei missing");
  assert(degraded.sandbox.image === "pen-sandbox:test", "image from deps");
  assert(degraded.sandbox.imagePresent === false, "image missing");
  assert(degraded.sandbox.shellMode === "host", "host shell mode");
  const nucleiDeg = degraded.tools.find((t) => t.name === "nuclei");
  assert(nucleiDeg && nucleiDeg.present === false, "nuclei missing on degraded");
  assert(nucleiDeg!.via === "none", "nuclei via none");
  assert(/nuclei=missing/.test(degraded.summary), `summary mentions nuclei missing: ${degraded.summary}`);
  assert(/non-gating/.test(degraded.summary), "summary marks non-gating");
  const textDeg = formatToolingHealthReport(degraded);
  assert(/observability only/i.test(textDeg), "format header");
  assert(/nuclei:.*MISSING/i.test(textDeg), "format lists nuclei missing");
  assert(/gating:.*false/i.test(textDeg), "format shows gating false");

  // --- Present: host shim + container image ---
  const fakeBin = mkdtempSync(join(tmpdir(), "tooling-health-bin-"));
  writeFileSync(join(fakeBin, "nuclei"), "#!/bin/sh\necho nuclei\n");
  chmodSync(join(fakeBin, "nuclei"), 0o755);
  writeFileSync(join(fakeBin, "nmap"), "#!/bin/sh\necho nmap\n");
  chmodSync(join(fakeBin, "nmap"), 0o755);

  const present = probeToolingHealth({
    deps: baseDeps({
      resolveImage: () => "pen-sandbox:dev",
      imageExists: (img) => img === "pen-sandbox:dev",
      isShellInContainer: () => true,
      resolveBinDir: () => fakeBin,
      checkHostTool: (name) => {
        if (name === "nuclei" || name === "nmap") {
          return { present: true, path: join(fakeBin, name), detail: "test" };
        }
        return { present: false, path: null };
      },
      checkContainerTools: (_image, names) => {
        const m: Record<string, boolean> = {};
        for (const n of names) m[n] = n === "nuclei" || n === "sqlmap" || n === "ffuf";
        return m;
      },
    }),
    checkContainerBinaries: true,
  });
  assert(present.degraded === false, "not degraded when nuclei present");
  assert(present.sandbox.imagePresent === true, "image present");
  assert(present.sandbox.shellInContainer === true, "shell in container");
  assert(present.sandbox.shellMode === "container", "container shell mode");
  assert(present.hostShim.binDir === fakeBin, "binDir reported");
  const nucleiOk = present.tools.find((t) => t.name === "nuclei")!;
  assert(nucleiOk.present === true, "nuclei present");
  assert(nucleiOk.via === "both" || nucleiOk.via === "host" || nucleiOk.via === "container", `nuclei via=${nucleiOk.via}`);
  const sqlmap = present.tools.find((t) => t.name === "sqlmap")!;
  assert(sqlmap.present === true && sqlmap.via === "container", "sqlmap via container only");
  assert(/nuclei=ok/.test(present.summary), `summary nuclei ok: ${present.summary}`);

  // --- Probe never throws when deps throw ---
  let threw = false;
  let safe: ToolingHealthReport | undefined;
  try {
    safe = probeToolingHealth({
      deps: baseDeps({
        resolveImage: () => {
          throw new Error("boom-image");
        },
        imageExists: () => {
          throw new Error("boom-exists");
        },
        isShellInContainer: () => {
          throw new Error("boom-shell");
        },
        resolveBinDir: () => {
          throw new Error("boom-bin");
        },
        checkHostTool: () => {
          throw new Error("boom-host");
        },
        checkContainerTools: () => {
          throw new Error("boom-ctr");
        },
      }),
    });
  } catch {
    threw = true;
  }
  assert(!threw && safe, "probe does not throw when deps fail");
  assert(safe!.gating === false, "still non-gating after deps fail");
  assert(safe!.degraded === true, "degraded after deps fail");

  // --- recordToolingHealthAtTaskStart: writes artifact + status; platform throw OK ---
  const taskDir = mkdtempSync(join(tmpdir(), "tooling-health-task-"));
  mkdirSync(taskDir, { recursive: true });
  const sent: unknown[] = [];
  const platform: PlatformSink = {
    async send(msg) {
      sent.push(msg);
      // simulate flaky platform after first fields recorded
      if (sent.length > 1) throw new Error("platform down");
    },
  };
  const task: TaskEnvelope = {
    taskId: "t-health-1",
    conversationId: "c-health-1",
    instruction: "scan",
    target: { value: "http://127.0.0.1" },
    scope: { allow: ["http://127.0.0.1"] },
  };

  const recorded = await recordToolingHealthAtTaskStart({
    taskDir,
    platform,
    task,
    probe: () =>
      probeToolingHealth({
        deps: baseDeps({
          imageExists: () => false,
          checkHostTool: () => ({ present: false }),
        }),
      }),
  });
  assert(recorded !== null, "record returns report");
  assert(recorded!.degraded === true, "recorded degraded");
  const artifact = JSON.parse(readFileSync(join(taskDir, "tooling-health.json"), "utf8"));
  assert(artifact.gating === false, "artifact gating false");
  assert(artifact.degraded === true, "artifact degraded");
  assert(Array.isArray(artifact.tools), "artifact tools array");
  assert(sent.length >= 1, "status_update sent");
  const st = sent[0] as { type?: string; message?: string; tooling_health?: { gating?: boolean } };
  assert(st.type === "status_update", "status_update type");
  assert(/tooling-health/i.test(String(st.message || "")), "status message");
  assert(st.tooling_health?.gating === false, "status payload non-gating");

  // Platform that always throws on send — still writes file, returns report
  const taskDir2 = mkdtempSync(join(tmpdir(), "tooling-health-task2-"));
  const boomPlatform: PlatformSink = {
    async send() {
      throw new Error("always fail");
    },
  };
  const r2 = await recordToolingHealthAtTaskStart({
    taskDir: taskDir2,
    platform: boomPlatform,
    task,
    probe: () =>
      probeToolingHealth({
        deps: baseDeps({
          imageExists: () => true,
          isShellInContainer: () => true,
          resolveBinDir: () => fakeBin,
          checkContainerTools: () => ({ nuclei: true, nmap: true, sqlmap: true, ffuf: true, "redis-cli": true }),
        }),
      }),
  });
  assert(r2 !== null && r2.degraded === false, "healthy path despite platform throw");
  assert(
    JSON.parse(readFileSync(join(taskDir2, "tooling-health.json"), "utf8")).degraded === false,
    "healthy artifact",
  );

  // probe that throws — record returns null, does not rethrow
  let recordThrew = false;
  let r3: ToolingHealthReport | null = null;
  try {
    r3 = await recordToolingHealthAtTaskStart({
      taskDir: taskDir2,
      platform,
      task,
      probe: () => {
        throw new Error("probe explode");
      },
    });
  } catch {
    recordThrew = true;
  }
  assert(!recordThrew && r3 === null, "record swallows probe throw");

  // --- Live probe against real resolvers (environment-dependent, non-failing) ---
  const live = probeToolingHealth({ checkContainerBinaries: false });
  assert(live.gating === false, "live probe non-gating");
  assert(typeof live.sandbox.image === "string" && live.sandbox.image.length > 0, "live image string");
  assert(live.tools.some((t) => t.name === "nuclei"), "live includes nuclei row");
  assert(typeof live.summary === "string" && live.summary.includes("tooling-health"), "live summary");

  console.log(
    JSON.stringify(
      {
        ok: true,
        degraded: { nuclei: nucleiDeg, summary: degraded.summary },
        present: {
          shellMode: present.sandbox.shellMode,
          nuclei: nucleiOk,
          sqlmap,
          summary: present.summary,
        },
        live: {
          image: live.sandbox.image,
          imagePresent: live.sandbox.imagePresent,
          shellMode: live.sandbox.shellMode,
          binDir: live.hostShim.binDir,
          degraded: live.degraded,
          tools: live.tools.map((t) => ({ name: t.name, present: t.present, via: t.via })),
        },
      },
      null,
      2,
    ),
  );
  console.log("RESULT: PASS — tooling-health");
} finally {
  try {
    // cleanup temp dirs best-effort
  } catch {
    /* ignore */
  }
  for (const k of Object.keys(process.env)) {
    if (!(k in saved)) delete process.env[k];
  }
  Object.assign(process.env, saved);
}
