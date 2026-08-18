/**
 * Spec #428: Session workspace path helpers.
 * Run: npx tsx src/runtime/session-workspace.test.ts
 */
import {
  mkdtempSync,
  existsSync,
  lstatSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendFileInsideRoot,
  ensureSessionWorkspace,
  prepareHostWritePath,
  resolveCaseDir,
  resolveExpertDir,
  resolvePiInstanceDir,
  resolveSessionWorkspaceDir,
} from "./session-workspace.js";
import {
  BrowserSandboxRuntime,
  formatBrowserSandboxSeatKey,
  type BrowserSandboxDockerPort,
  type SandboxExecResult,
} from "./browser-sandbox.js";
import { runShellInPenTools } from "./pen-tools-shell.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function ok(): SandboxExecResult {
  return { exitCode: 0, stdout: "", stderr: "" };
}

// --- path layout ---
{
  const p = resolveSessionWorkspaceDir("/tmp/ws", "conv-abc", "exp-1");
  assert(p.includes("case-conv-abc"), p);
  assert(p.includes("expert-exp-1"), p);
  assert(
    resolveSessionWorkspaceDir("/tmp/ws", "c", "a") !==
      resolveSessionWorkspaceDir("/tmp/ws", "c", "b"),
    "experts isolated",
  );
  const pi = resolvePiInstanceDir("/tmp/ws", "c1", "e1", "sid-9");
  assert(pi.startsWith(resolveExpertDir("/tmp/ws", "c1", "e1")), "pi under expert");
  assert(resolveExpertDir("/tmp/ws", "c1", "e1").startsWith(resolveCaseDir("/tmp/ws", "c1")), "expert under case");
  assert(pi.includes("pi-sid-9"), pi);
}

// --- ensure creates subdirs ---
{
  const root = mkdtempSync(join(tmpdir(), "sess-ws-"));
  try {
    const dir = resolveSessionWorkspaceDir(root, "c1", "e1");
    const abs = await ensureSessionWorkspace(dir);
    for (const sub of ["scripts", "notes", "credentials", "exports", "session"]) {
      assert(existsSync(join(abs, sub)), `subdir ${sub}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const saved = { ...process.env };
try {
  process.env.PEN_SANDBOX_IMAGE = "pen-sandbox:test-428";

  // --- ensure mounts session workspace volume ---
  {
    const volumesSeen: string[][] = [];
    const docker: BrowserSandboxDockerPort = {
      async rmForce() {
        return ok();
      },
      async runDetached(opts) {
        volumesSeen.push(opts.volumes || []);
        return { exitCode: 0, stdout: opts.name, stderr: "" };
      },
      async exec() {
        return ok();
      },
      async listBrowserSandboxes() {
        return [];
      },
      async writeLease() {
        return ok();
      },
    async stop() {
      return ok();
    },
    async start() {
      return ok();
    },
    async inspectState() {
      return "missing" as const;
    },
    };
    const rt = new BrowserSandboxRuntime({ docker });
    const seat = {
      conversationId: "c-vol",
      expertId: "e-vol",
      seatKey: formatBrowserSandboxSeatKey("c-vol", "e-vol"),
    };
    const ws = mkdtempSync(join(tmpdir(), "ws-vol-"));
    try {
      await ensureSessionWorkspace(ws);
      await rt.ensure(seat, { workspaceHostPath: ws });
      assert(volumesSeen.length === 1, "one create");
      assert(
        volumesSeen[0].some((v) => v.includes(`${ws}:/workspace:rw`)),
        `workspace mount expected, got ${JSON.stringify(volumesSeen[0])}`,
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }

  // --- sticky shell exec (not ephemeral) with fake runtime ---
  {
    const execs: string[][] = [];
    let creates = 0;
    const running = new Set<string>();
    const docker: BrowserSandboxDockerPort = {
      async rmForce(name) {
        running.delete(name);
        return ok();
      },
      async runDetached(opts) {
        creates += 1;
        running.add(opts.name);
        return { exitCode: 0, stdout: opts.name, stderr: "" };
      },
      async exec(_name, argv) {
        execs.push(argv);
        return { exitCode: 0, stdout: "sticky-ok\n", stderr: "", via: "sandbox" };
      },
      async listBrowserSandboxes() {
        return [];
      },
      async writeLease() {
        return ok();
      },
      async stop(name) {
        running.delete(name);
        return ok();
      },
      async start(name) {
        running.add(name);
        return ok();
      },
      async inspectState(name) {
        return running.has(name) ? "running" : "missing";
      },
    };
    // Install as default by constructing and replacing is hard; call runtime path via runShellInPenTools
    // uses getDefaultBrowserSandboxRuntime — so patch by running against injected path:
    // Test ensure+exec on isolated runtime instead of process default.
    const rt = new BrowserSandboxRuntime({ docker });
    const seat = {
      conversationId: "c-sh",
      expertId: "e-sh",
      seatKey: formatBrowserSandboxSeatKey("c-sh", "e-sh"),
    };
    const ws = mkdtempSync(join(tmpdir(), "ws-sh-"));
    try {
      await ensureSessionWorkspace(ws);
      writeFileSync(join(ws, "marker.txt"), "host-file\n");
      await rt.ensure(seat, { workspaceHostPath: ws });
      const r = await rt.exec(seat, ["bash", "-lc", "cd /workspace && echo sticky-ok"], 5_000, {
        workspaceHostPath: ws,
      });
      assert(creates === 1, "one sticky create");
      assert(r.stdout.includes("sticky-ok"), "exec ok");
      assert(execs.length === 1, "one exec");
      // host file still present after "container" life
      assert(readFileSync(join(ws, "marker.txt"), "utf8").includes("host-file"), "host SoT");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }

  // --- sticky shell fail-closed: never silent ephemeral when seat is set ---
  process.env.NODE4_SHELL_IN_PEN_TOOLS = "1";
  {
    const dir = mkdtempSync(join(tmpdir(), "sticky-fail-"));
    try {
      writeFileSync(join(dir, "x.txt"), "x\n");
      const seat = {
        conversationId: "c-fail",
        expertId: "e-fail",
        seatKey: formatBrowserSandboxSeatKey("c-fail", "e-fail"),
      };
      // No working sticky ensure (default docker may fail) → sticky-failed, not ephemeral
      const r = await runShellInPenTools("echo hi", dir, 3_000, undefined, {
        seat,
        workspaceHostPath: dir,
      });
      assert(
        r.via === "sticky-exec" || r.via === "sticky-failed",
        `must not ephemeral with seat, via=${r.via}`,
      );
      assert(r.via !== "ephemeral-run", "no silent ephemeral twin");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // --- host I/O refuses symlink escape under the sandbox mount ---
  {
    const root = mkdtempSync(join(tmpdir(), "host-io-"));
    const outside = mkdtempSync(join(tmpdir(), "host-io-out-"));
    try {
      const leaf = join(root, "events.jsonl");
      writeFileSync(join(outside, "target"), "secret\n");
      symlinkSync(join(outside, "target"), leaf);
      await prepareHostWritePath(leaf, root);
      assert(!existsSync(leaf) || !lstatSync(leaf).isSymbolicLink(), "leaf symlink removed");
      await appendFileInsideRoot(leaf, root, "ok\n");
      assert(readFileSync(leaf, "utf8") === "ok\n", "wrote regular file");
      assert(readFileSync(join(outside, "target"), "utf8") === "secret\n", "outside unchanged");

      let blocked = false;
      try {
        await prepareHostWritePath(join(outside, "nope"), root);
      } catch {
        blocked = true;
      }
      assert(blocked, "write outside root blocked");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }

  console.log(JSON.stringify({ ok: true, cases: "session-workspace-428" }, null, 2));
  console.log("RESULT: PASS — session workspace (#428)");
} finally {
  for (const k of Object.keys(process.env)) {
    if (!(k in saved)) delete process.env[k];
  }
  Object.assign(process.env, saved);
}
