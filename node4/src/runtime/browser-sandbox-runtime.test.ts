/**
 * Spec #331: BrowserSandboxRuntime ensure / reuse / dispose with injectable Docker port.
 * Run: npx tsx src/runtime/browser-sandbox-runtime.test.ts
 */
import {
  BrowserSandboxImageError,
  BrowserSandboxRuntime,
  type BrowserSandboxDockerPort,
  type SandboxExecResult,
} from "./browser-sandbox.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function ok(): SandboxExecResult {
  return { exitCode: 0, stdout: "", stderr: "" };
}

function makeFakeDocker() {
  const creates: string[] = [];
  const rms: string[] = [];
  const execs: Array<{ name: string; argv: string[] }> = [];
  const running = new Set<string>();
  const imagesUsed: string[] = [];

  const docker: BrowserSandboxDockerPort = {
    async rmForce(name: string) {
      rms.push(name);
      running.delete(name);
      return ok();
    },
    async runDetached(opts) {
      creates.push(opts.name);
      imagesUsed.push(opts.image);
      running.add(opts.name);
      return { exitCode: 0, stdout: opts.name, stderr: "" };
    },
    async exec(name, argv) {
      execs.push({ name, argv });
      if (!running.has(name)) {
        return { exitCode: 1, stdout: "", stderr: "container not running" };
      }
      return { exitCode: 0, stdout: "ok", stderr: "", via: "sandbox" };
    },
  };

  return { docker, creates, rms, execs, running, imagesUsed };
}

const saved = { ...process.env };
try {
  process.env.PEN_SANDBOX_IMAGE = "pen-sandbox:test-331";
  delete process.env.NODE4_BROWSER_SANDBOX_IMAGE;
  delete process.env.NODE2_BROWSER_SANDBOX_IMAGE;
  delete process.env.PEN_TOOLS_IMAGE;

  // --- ensure once, second ensure reuses (no second create) ---
  {
    const fake = makeFakeDocker();
    const rt = new BrowserSandboxRuntime({ docker: fake.docker });
    const a = await rt.ensure("parent-task-1");
    const b = await rt.ensure("parent-task-1");
    assert(a.containerName === b.containerName, "same container name on reuse");
    assert(a.parentTaskId === "parent-task-1", "keyed by parent task id");
    assert(fake.creates.length === 1, `one create expected, got ${fake.creates.length}`);
    assert(fake.imagesUsed[0] === "pen-sandbox:test-331", "uses explicit image");
  }

  // --- exec reuses without second create ---
  {
    const fake = makeFakeDocker();
    const rt = new BrowserSandboxRuntime({ docker: fake.docker });
    await rt.ensure("parent-A");
    const r1 = await rt.exec("parent-A", ["agent-browser", "snapshot"]);
    const r2 = await rt.exec("parent-A", ["agent-browser", "snapshot"]);
    assert(r1.exitCode === 0 && r2.exitCode === 0, "exec ok");
    assert(fake.creates.length === 1, "exec does not create second container");
    assert(fake.execs.length === 2, "two execs");
    assert(fake.execs.every((e) => e.name === fake.creates[0]), "exec targets ensured container");
  }

  // --- dispose removes; later ensure creates fresh ---
  {
    const fake = makeFakeDocker();
    const rt = new BrowserSandboxRuntime({ docker: fake.docker });
    const first = await rt.ensure("parent-B");
    await rt.dispose("parent-B");
    assert(fake.rms.includes(first.containerName), "dispose rm's container");
    assert(!fake.running.has(first.containerName), "container gone from fake");
    const second = await rt.ensure("parent-B");
    assert(fake.creates.length === 2, "fresh create after dispose");
    assert(second.containerName === first.containerName, "stable name for same parent id");
  }

  // --- no cross-task reuse after dispose of one ---
  {
    const fake = makeFakeDocker();
    const rt = new BrowserSandboxRuntime({ docker: fake.docker });
    const t1 = await rt.ensure("task-one");
    const t2 = await rt.ensure("task-two");
    assert(t1.containerName !== t2.containerName, "distinct containers per parent");
    assert(fake.creates.length === 2, "two creates for two parents");
    await rt.dispose("task-one");
    assert(!fake.running.has(t1.containerName), "task-one disposed");
    assert(fake.running.has(t2.containerName), "task-two still running");
    await rt.ensure("task-two");
    assert(fake.creates.length === 2, "task-two still reused after sibling dispose");
  }

  // --- dispose is idempotent when no session ---
  {
    const fake = makeFakeDocker();
    const rt = new BrowserSandboxRuntime({ docker: fake.docker });
    await rt.dispose("never-created");
    // may still force-rm by name; must not throw
    assert(true, "dispose empty ok");
  }

  // --- image unavailable fails ensure ---
  {
    const fake = makeFakeDocker();
    const rt = new BrowserSandboxRuntime({
      docker: fake.docker,
      resolveImage: () => {
        throw new BrowserSandboxImageError("missing pin");
      },
    });
    let threw: unknown;
    try {
      await rt.ensure("parent-C");
    } catch (e) {
      threw = e;
    }
    assert(threw instanceof BrowserSandboxImageError, "ensure fails without image");
    assert(fake.creates.length === 0, "no create when image missing");
  }

  // --- create failure does not leave session for reuse ---
  {
    let attempts = 0;
    const docker: BrowserSandboxDockerPort = {
      async rmForce() {
        return ok();
      },
      async runDetached() {
        attempts += 1;
        return { exitCode: 1, stdout: "", stderr: "boom" };
      },
      async exec() {
        return ok();
      },
    };
    const rt = new BrowserSandboxRuntime({
      docker,
      resolveImage: () => "pen-sandbox:fail",
    });
    let failed = false;
    try {
      await rt.ensure("parent-fail");
    } catch {
      failed = true;
    }
    assert(failed, "ensure throws on docker create failure");
    // second ensure should try create again (no sticky failed session)
    try {
      await rt.ensure("parent-fail");
    } catch {
      /* expected */
    }
    assert(attempts === 2, "failed ensure does not block retry create");
  }

  console.log(JSON.stringify({ ok: true, cases: "ensure/reuse/dispose/fake-docker" }, null, 2));
  console.log("RESULT: PASS — BrowserSandboxRuntime (#331)");
} finally {
  for (const k of Object.keys(process.env)) {
    if (!(k in saved)) delete process.env[k];
  }
  Object.assign(process.env, saved);
}
