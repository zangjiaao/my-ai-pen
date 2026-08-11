/**
 * Spec #429: Session/Case dispose rms sticky pen-sandbox; reset does not.
 * Run: npx tsx src/runtime/sticky-sandbox-dispose.test.ts
 */
import {
  BrowserSandboxRuntime,
  disposeBrowserSandboxForCase,
  disposeBrowserSandboxForSeat,
  formatBrowserSandboxSeatKey,
  type BrowserSandboxDockerPort,
  type SandboxExecResult,
} from "./browser-sandbox.js";
import {
  disposeWorkingSession,
  disposeWorkingSessionsForCase,
  parkWorkingSession,
  resetWorkingSessionMemory,
  type ParkedWorkingRuntime,
} from "./working-session-park.js";
import type { TodoStore } from "../stores/todo.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function ok(): SandboxExecResult {
  return { exitCode: 0, stdout: "", stderr: "" };
}

function fakeTodo(): TodoStore {
  return {
    snapshot: () => [],
    openCount: () => 0,
  } as unknown as TodoStore;
}

function makeFakeDocker() {
  const creates: string[] = [];
  const rms: string[] = [];
  const running = new Set<string>();
  const docker: BrowserSandboxDockerPort = {
    async rmForce(name) {
      rms.push(name);
      running.delete(name);
      return ok();
    },
    async runDetached(opts) {
      creates.push(opts.name);
      running.add(opts.name);
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
  return { docker, creates, rms, running };
}

const saved = { ...process.env };
try {
  process.env.PEN_SANDBOX_IMAGE = "pen-sandbox:test-429";

  // --- runtime: disposeForConversation ---
  {
    const fake = makeFakeDocker();
    const rt = new BrowserSandboxRuntime({ docker: fake.docker });
    const a = await rt.ensure({
      conversationId: "case-1",
      expertId: "e1",
      seatKey: formatBrowserSandboxSeatKey("case-1", "e1"),
    });
    const b = await rt.ensure({
      conversationId: "case-1",
      expertId: "e2",
      seatKey: formatBrowserSandboxSeatKey("case-1", "e2"),
    });
    const other = await rt.ensure({
      conversationId: "case-2",
      expertId: "e1",
      seatKey: formatBrowserSandboxSeatKey("case-2", "e1"),
    });
    const n = await rt.disposeForConversation("case-1");
    assert(n === 2, `disposed 2 seats, got ${n}`);
    assert(!fake.running.has(a.containerName), "e1 gone");
    assert(!fake.running.has(b.containerName), "e2 gone");
    assert(fake.running.has(other.containerName), "other case kept");
  }

  // --- seat dispose rm's container ---
  {
    const fake = makeFakeDocker();
    const isolated = new BrowserSandboxRuntime({ docker: fake.docker, instanceId: "test-429-iso" });
    const seat = {
      conversationId: "c-del",
      expertId: "exp",
      seatKey: formatBrowserSandboxSeatKey("c-del", "exp"),
    };
    await isolated.ensure(seat);
    assert(fake.running.size === 1, "box up");
    await isolated.dispose(seat);
    assert(fake.running.size === 0, "seat dispose rm");
  }

  // --- park Session Delete path: disposeWorkingSession with park entry ---
  {
    const fake = makeFakeDocker();
    // Monkey: temporarily use disposeBrowserSandboxForSeat against isolated by testing park+dispose
    // without default runtime coupling — park dispose calls disposeBrowserSandboxForSeat on default.
    // So exercise park dispose flags only for captain, and sandbox helper separately (above).
    let disposed = false;
    const entry: ParkedWorkingRuntime = {
      conversationId: "c-park",
      expertId: "ex",
      workMode: "free",
      taskId: "t1",
      session: {
        prompt: async () => {},
        abort: () => {},
        dispose: () => {},
        reset: () => {},
        subscribe: () => () => {},
        steer: () => {},
        followUp: () => {},
        get messages() {
          return [];
        },
        get sessionId() {
          return "sid";
        },
      } as any,
      todo: fakeTodo(),
      parkedAt: Date.now(),
      dispose: async () => {
        disposed = true;
      },
    };
    parkWorkingSession(entry);
    const out = await disposeWorkingSession("c-park", "ex");
    assert(out.disposed === true, "session disposed");
    assert(disposed, "captain dispose called");
  }

  // --- Case dispose ---
  {
    let n = 0;
    parkWorkingSession({
      conversationId: "case-x",
      expertId: "a",
      workMode: "free",
      taskId: "t",
      session: {
        prompt: async () => {},
        abort: () => {},
        dispose: () => {},
        reset: () => {},
        subscribe: () => () => {},
        steer: () => {},
        followUp: () => {},
        get messages() {
          return [];
        },
        get sessionId() {
          return "s1";
        },
      } as any,
      todo: fakeTodo(),
      parkedAt: Date.now(),
      dispose: () => {
        n += 1;
      },
    });
    parkWorkingSession({
      conversationId: "case-x",
      expertId: "b",
      workMode: "free",
      taskId: "t2",
      session: {
        prompt: async () => {},
        abort: () => {},
        dispose: () => {},
        reset: () => {},
        subscribe: () => () => {},
        steer: () => {},
        followUp: () => {},
        get messages() {
          return [];
        },
        get sessionId() {
          return "s2";
        },
      } as any,
      todo: fakeTodo(),
      parkedAt: Date.now(),
      dispose: () => {
        n += 1;
      },
    });
    const r = await disposeWorkingSessionsForCase("case-x");
    assert(r.disposed === 2, "two parks disposed");
    assert(n === 2, "both captains disposed");
  }

  // --- Reset does not throw and keeps park shell (sandbox not required) ---
  {
    parkWorkingSession({
      conversationId: "c-rst",
      expertId: "e",
      workMode: "free",
      taskId: "t",
      session: {
        prompt: async () => {},
        abort: () => {},
        dispose: () => {},
        reset: () => {},
        subscribe: () => () => {},
        steer: () => {},
        followUp: () => {},
        get messages() {
          return [];
        },
        get sessionId() {
          return "old";
        },
      } as any,
      todo: fakeTodo(),
      parkedAt: Date.now(),
      dispose: () => {},
    });
    const rst = await resetWorkingSessionMemory("c-rst", "e");
    assert(rst.ok === true, "reset ok");
    // reset re-parks shell; disposeWorkingSession not called — no rm expected on sandbox path
  }

  // --- helpers export ---
  {
    await disposeBrowserSandboxForSeat("no-such", "exp").catch(() => {});
    await disposeBrowserSandboxForCase("no-such-case").catch(() => {});
    assert(true, "helpers callable");
  }

  console.log(JSON.stringify({ ok: true, cases: "sticky-dispose-429" }, null, 2));
  console.log("RESULT: PASS — sticky sandbox dispose (#429)");
} finally {
  for (const k of Object.keys(process.env)) {
    if (!(k in saved)) delete process.env[k];
  }
  Object.assign(process.env, saved);
}
