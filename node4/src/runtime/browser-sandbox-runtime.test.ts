/**
 * Spec #331 / #427: BrowserSandboxRuntime seat-keyed ensure / reuse / dispose.
 * Run: npx tsx src/runtime/browser-sandbox-runtime.test.ts
 */
import {
  BrowserSandboxImageError,
  BrowserSandboxRuntime,
  formatBrowserSandboxSeatKey,
  type BrowserSandboxDockerPort,
  type SandboxExecResult,
} from "./browser-sandbox.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function ok(): SandboxExecResult {
  return { exitCode: 0, stdout: "", stderr: "" };
}

function seat(conv: string, expert: string) {
  return {
    conversationId: conv,
    expertId: expert,
    seatKey: formatBrowserSandboxSeatKey(conv, expert),
  };
}

function makeFakeDocker() {
  const creates: string[] = [];
  const rms: string[] = [];
  const execs: Array<{ name: string; argv: string[] }> = [];
  const running = new Set<string>();
  const known = new Set<string>();
  const imagesUsed: string[] = [];
  const startedAtMs = new Map<string, number>();
  let clock = 1_000_000;

  const docker: BrowserSandboxDockerPort = {
    async rmForce(name: string) {
      rms.push(name);
      running.delete(name);
      known.delete(name);
      startedAtMs.delete(name);
      return ok();
    },
    async runDetached(opts) {
      creates.push(opts.name);
      imagesUsed.push(opts.image);
      running.add(opts.name);
      known.add(opts.name);
      startedAtMs.set(opts.name, clock);
      void opts.volumes;
      return { exitCode: 0, stdout: opts.name, stderr: "" };
    },
    async exec(name, argv) {
      execs.push({ name, argv });
      if (!running.has(name)) {
        return { exitCode: 1, stdout: "", stderr: "container not running" };
      }
      return { exitCode: 0, stdout: "ok", stderr: "", via: "sandbox" };
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
      if (!known.has(name)) {
        return { exitCode: 1, stdout: "", stderr: "no such container" };
      }
      running.add(name);
      startedAtMs.set(name, clock);
      return ok();
    },
    async inspectState(name) {
      if (running.has(name)) return "running";
      if (known.has(name)) return "stopped";
      return "missing";
    },
    async inspectStartedAtMs(name) {
      return startedAtMs.get(name) ?? null;
    },
  } satisfies BrowserSandboxDockerPort;

  return { docker, creates, rms, execs, running, known, imagesUsed, startedAtMs, setClock: (n: number) => { clock = n; } };
}

const saved = { ...process.env };
try {
  process.env.PEN_SANDBOX_IMAGE = "pen-sandbox:test-427";
  delete process.env.NODE4_BROWSER_SANDBOX_IMAGE;
  delete process.env.NODE2_BROWSER_SANDBOX_IMAGE;
  delete process.env.PEN_TOOLS_IMAGE;

  const s1 = seat("conv-1", "exp-1");

  // --- ensure once, second ensure reuses (no second create) ---
  {
    const fake = makeFakeDocker();
    const rt = new BrowserSandboxRuntime({ docker: fake.docker });
    const a = await rt.ensure(s1);
    const b = await rt.ensure(s1);
    assert(a.containerName === b.containerName, "same container name on reuse");
    assert(a.seatKey === s1.seatKey, "keyed by seat");
    assert(a.conversationId === "conv-1" && a.expertId === "exp-1", "seat fields");
    assert(fake.creates.length === 1, `one create expected, got ${fake.creates.length}`);
    assert(fake.imagesUsed[0] === "pen-sandbox:test-427", "uses explicit image");
  }

  // --- two sequential "bursts" same seatKey string reuse ---
  {
    const fake = makeFakeDocker();
    const rt = new BrowserSandboxRuntime({ docker: fake.docker });
    await rt.ensure(s1);
    // simulate task-end: release hold, do NOT dispose
    rt.releaseSeat(s1);
    await rt.ensure(s1);
    assert(fake.creates.length === 1, "sticky across burst without dispose");
  }

  // --- exec reuses without second create ---
  {
    const fake = makeFakeDocker();
    const rt = new BrowserSandboxRuntime({ docker: fake.docker });
    await rt.ensure(s1);
    const r1 = await rt.exec(s1, ["agent-browser", "snapshot"]);
    const r2 = await rt.exec(s1.seatKey, ["agent-browser", "snapshot"]);
    assert(r1.exitCode === 0 && r2.exitCode === 0, "exec ok");
    assert(fake.creates.length === 1, "exec does not create second container");
    assert(fake.execs.length === 2, "two execs");
    assert(fake.execs.every((e) => e.name === fake.creates[0]), "exec targets ensured container");
  }

  // --- dispose removes; later ensure creates fresh ---
  {
    const fake = makeFakeDocker();
    const rt = new BrowserSandboxRuntime({ docker: fake.docker });
    const first = await rt.ensure(s1);
    await rt.dispose(s1);
    assert(fake.rms.includes(first.containerName), "dispose rm's container");
    assert(!fake.running.has(first.containerName), "container gone from fake");
    const second = await rt.ensure(s1);
    assert(fake.creates.length === 2, "fresh create after dispose");
    assert(second.containerName === first.containerName, "stable name for same seat");
  }

  // --- multi-seat: two experts → two boxes ---
  {
    const fake = makeFakeDocker();
    const rt = new BrowserSandboxRuntime({ docker: fake.docker });
    const a = await rt.ensure(seat("case-x", "expert-a"));
    const b = await rt.ensure(seat("case-x", "expert-b"));
    assert(a.containerName !== b.containerName, "distinct containers per seat");
    assert(fake.creates.length === 2, "two creates for two seats");
    await rt.dispose(a.seatKey);
    assert(!fake.running.has(a.containerName), "seat a disposed");
    assert(fake.running.has(b.containerName), "seat b still running");
  }

  // --- fail closed: ensure string without :: throws ---
  {
    const fake = makeFakeDocker();
    const rt = new BrowserSandboxRuntime({ docker: fake.docker });
    let threw = false;
    try {
      await rt.ensure("bare-task-id");
    } catch {
      threw = true;
    }
    assert(threw, "bare key without seat shape fails");
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
      await rt.ensure(s1);
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
        return "missing";
      },
    };
    const rt = new BrowserSandboxRuntime({
      docker,
      resolveImage: () => "pen-sandbox:fail",
    });
    let failed = false;
    try {
      await rt.ensure(s1);
    } catch {
      failed = true;
    }
    assert(failed, "ensure throws on docker create failure");
    try {
      await rt.ensure(s1);
    } catch {
      /* expected */
    }
    assert(attempts === 2, "failed ensure does not block retry create");
  }

  // --- disposeAll clears every seat session ---
  {
    const fake = makeFakeDocker();
    const rt = new BrowserSandboxRuntime({ docker: fake.docker });
    await rt.ensure(seat("c1", "e1"));
    await rt.ensure(seat("c1", "e2"));
    assert(rt.activeSessionCount() === 2, "two sessions");
    await rt.disposeAll();
    assert(rt.activeSessionCount() === 0, "disposeAll cleared sessions");
    assert(fake.running.size === 0, "disposeAll removed containers");
  }

  // --- janitor does not reap process-local sticky session after hold release ---
  {
    const fake = makeFakeDocker();
    const rt = new BrowserSandboxRuntime({
      docker: fake.docker,
      now: () => 1_000_000_000_000,
    });
    const sess = await rt.ensure(s1);
    rt.holdSeat(s1);
    rt.releaseSeat(s1);
    // inject list result with expired lease for the live container
    fake.docker.listBrowserSandboxes = async () => [
      {
        name: sess.containerName,
        labels: {
          "myaipen.component": "browser-sandbox",
          "myaipen.seat_key": s1.seatKey,
          "myaipen.parent_task_id": s1.seatKey,
        },
        leaseUntilUnix: 1,
        leaseTrusted: true,
      },
    ];
    const r = await rt.reapExpired(Math.floor(Date.now() / 1000) + 999_999);
    assert(r.reaped.length === 0, "sticky in-map session not reaped");
    assert(fake.running.has(sess.containerName), "container still up");
  }

  // --- Spec #430: stop then ensure starts same container (no second create) ---
  {
    const fake = makeFakeDocker();
    const rt = new BrowserSandboxRuntime({ docker: fake.docker });
    const first = await rt.ensure(s1);
    assert(fake.creates.length === 1, "one create");
    await rt.stop(s1);
    assert(!fake.running.has(first.containerName), "stopped");
    assert(fake.known.has(first.containerName), "container still known");
    const second = await rt.ensure(s1);
    assert(second.containerName === first.containerName, "same name after start");
    assert(fake.creates.length === 1, "no recreate after stop/start");
    assert(fake.running.has(first.containerName), "running again");
  }

  // --- map says running but docker stopped → ensure restarts (no blind trust) ---
  {
    const fake = makeFakeDocker();
    const rt = new BrowserSandboxRuntime({ docker: fake.docker });
    const first = await rt.ensure(s1);
    // Simulate external stop while map still started=true
    fake.running.delete(first.containerName);
    const second = await rt.ensure(s1);
    assert(second.containerName === first.containerName, "same box");
    assert(fake.running.has(first.containerName), "restarted from stopped docker state");
    assert(fake.creates.length === 1, "no recreate");
  }

  // --- Case dispose scans label even when map empty ---
  {
    const fake = makeFakeDocker();
    const rt = new BrowserSandboxRuntime({ docker: fake.docker });
    const a = await rt.ensure(seat("case-lbl", "e1"));
    // Drop process map as if Node "restarted" but container still on host
    // (simulate by disposing map only — use internal path: stop then clear via dispose of other)
    // Ensure box exists with labels via listBrowserSandboxes
    fake.docker.listBrowserSandboxes = async () => [
      {
        name: a.containerName,
        labels: {
          "myaipen.component": "browser-sandbox",
          "myaipen.conversation_id": "case-lbl",
          "myaipen.expert_id": "e1",
          "myaipen.seat_key": formatBrowserSandboxSeatKey("case-lbl", "e1"),
        },
        leaseUntilUnix: 9999999999,
        leaseTrusted: true,
      },
    ];
    // Clear map without rm (simulate process memory loss): re-create runtime sharing docker
    const rt2 = new BrowserSandboxRuntime({ docker: fake.docker, instanceId: "restarted" });
    // container still known+running on fake host
    fake.known.add(a.containerName);
    fake.running.add(a.containerName);
    const n = await rt2.disposeForConversation("case-lbl");
    assert(n >= 1, `label scan disposed, got ${n}`);
    assert(!fake.running.has(a.containerName), "box rm'd via label scan");
  }

  // --- idle stop does not rm ---
  {
    const fake = makeFakeDocker();
    let now = 0;
    const rt = new BrowserSandboxRuntime({
      docker: fake.docker,
      now: () => now,
      leaseConfig: { idleStopMs: 100 },
    });
    await rt.ensure(s1);
    const createRms = fake.rms.length;
    now = 200;
    const stoppedKeys = await rt.stopIdleSeats(now);
    assert(stoppedKeys.includes(s1.seatKey), "idle stopped");
    assert(fake.rms.length === createRms, "idle stop never rm");
    assert(rt.activeSessionCount() === 1, "map kept after idle stop");
  }

  // --- idle stop reclaims host boxes after "process restart" (empty map) ---
  {
    const fake = makeFakeDocker();
    fake.setClock(1_000);
    const rt1 = new BrowserSandboxRuntime({
      docker: fake.docker,
      now: () => 1_000,
      leaseConfig: { idleStopMs: 100 },
    });
    const a = await rt1.ensure(seat("case-idle-restart", "e1"));
    // Simulate Node restart: new runtime, map empty; container still running on host.
    const rt2 = new BrowserSandboxRuntime({
      docker: fake.docker,
      instanceId: "restarted-idle",
      now: () => 1_000 + 500,
      leaseConfig: { idleStopMs: 100 },
    });
    fake.docker.listBrowserSandboxes = async () => [
      {
        name: a.containerName,
        labels: {
          "myaipen.component": "browser-sandbox",
          "myaipen.conversation_id": "case-idle-restart",
          "myaipen.expert_id": "e1",
          "myaipen.seat_key": formatBrowserSandboxSeatKey("case-idle-restart", "e1"),
        },
        leaseUntilUnix: 9999999999,
        leaseTrusted: true,
      },
    ];
    fake.known.add(a.containerName);
    fake.running.add(a.containerName);
    fake.startedAtMs.set(a.containerName, 1_000);
    const rmsBefore = fake.rms.length; // ensure may rmForce before create
    const stopped = await rt2.stopIdleSeats(1_000 + 500);
    assert(stopped.some((k) => k.includes("case-idle-restart")), `host idle stop, got ${stopped}`);
    assert(!fake.running.has(a.containerName), "docker stop orphan sticky box");
    assert(fake.rms.length === rmsBefore, "idle still never rm");
  }

  // --- host orphan with no clock (StartedAt missing) is skipped, not fail-open stop ---
  {
    const fake = makeFakeDocker();
    const name = "node4-browser-noclock";
    fake.known.add(name);
    fake.running.add(name);
    // deliberately no startedAtMs entry
    fake.docker.listBrowserSandboxes = async () => [
      {
        name,
        labels: {
          "myaipen.component": "browser-sandbox",
          "myaipen.conversation_id": "case-noclock",
          "myaipen.expert_id": "e1",
          "myaipen.seat_key": formatBrowserSandboxSeatKey("case-noclock", "e1"),
        },
        leaseUntilUnix: 9999999999,
        leaseTrusted: true,
      },
    ];
    const rt = new BrowserSandboxRuntime({
      docker: fake.docker,
      now: () => 1_000_000,
      leaseConfig: { idleStopMs: 100 },
    });
    // Force inspectStartedAtMs to return null (unknown age)
    fake.docker.inspectStartedAtMs = async () => null;
    const stopped = await rt.stopIdleSeats(1_000_000);
    assert(stopped.length === 0, `no-clock orphan must skip stop, got ${stopped}`);
    assert(fake.running.has(name), "no-clock orphan left running");
  }

  // --- getLeaseConfig re-reads env after construct (ESM / loadDotEnv order) ---
  {
    const prev = process.env.PEN_SANDBOX_IDLE_STOP_MS;
    delete process.env.PEN_SANDBOX_IDLE_STOP_MS;
    const rt = new BrowserSandboxRuntime({ docker: makeFakeDocker().docker });
    // Constructed with default 4h (no env).
    assert(
      rt.getLeaseConfig().idleStopMs === 4 * 60 * 60_000,
      "default 4h without env",
    );
    process.env.PEN_SANDBOX_IDLE_STOP_MS = "300000";
    assert(
      rt.getLeaseConfig().idleStopMs === 300_000,
      "re-reads .env after construct",
    );
    if (prev === undefined) delete process.env.PEN_SANDBOX_IDLE_STOP_MS;
    else process.env.PEN_SANDBOX_IDLE_STOP_MS = prev;
  }

  console.log(JSON.stringify({ ok: true, cases: "seat-key ensure/reuse/dispose/stop" }, null, 2));
  console.log("RESULT: PASS — BrowserSandboxRuntime (#427/#430)");
} finally {
  for (const k of Object.keys(process.env)) {
    if (!(k in saved)) delete process.env[k];
  }
  Object.assign(process.env, saved);
}
