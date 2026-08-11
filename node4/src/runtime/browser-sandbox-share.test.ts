/**
 * Spec #427: Main + sub-agents share seat sandbox; browser exec serialized per seat.
 * Run: npx tsx src/runtime/browser-sandbox-share.test.ts
 */
import {
  agentBrowserSessionName,
  BrowserSandboxRuntime,
  BrowserSandboxSeatError,
  containerNameForSeat,
  formatBrowserSandboxSeatKey,
  resolveBrowserSandboxSeat,
  type BrowserSandboxDockerPort,
  type SandboxExecResult,
} from "./browser-sandbox.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function ok(): SandboxExecResult {
  return { exitCode: 0, stdout: "", stderr: "" };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- resolveBrowserSandboxSeat ---
{
  const s = resolveBrowserSandboxSeat({
    conversationId: "conv-1",
    expertId: "exp-9",
    taskId: "conv-1-task/sub/worker",
    parentTaskId: "conv-1-task",
  });
  assert(s.seatKey === "conv-1::exp-9", "seat ignores parent task id");
  assert(s.conversationId === "conv-1" && s.expertId === "exp-9", "fields");

  let missingExpert = false;
  try {
    resolveBrowserSandboxSeat({ conversationId: "c", taskId: "t" });
  } catch (e) {
    missingExpert = e instanceof BrowserSandboxSeatError;
  }
  assert(missingExpert, "missing expertId fail-closed");

  let missingConv = false;
  try {
    resolveBrowserSandboxSeat({ expertId: "e" });
  } catch (e) {
    missingConv = e instanceof BrowserSandboxSeatError;
  }
  assert(missingConv, "missing conversationId fail-closed");

  assert(
    agentBrowserSessionName(s.seatKey) === agentBrowserSessionName(s.seatKey),
    "stable session name",
  );
  assert(
    containerNameForSeat(s.seatKey) === containerNameForSeat(s.seatKey),
    "stable container name",
  );
  assert(
    containerNameForSeat(formatBrowserSandboxSeatKey("c", "a")) !==
      containerNameForSeat(formatBrowserSandboxSeatKey("c", "b")),
    "different experts different containers",
  );
}

const saved = { ...process.env };
try {
  process.env.PEN_SANDBOX_IMAGE = "pen-sandbox:test-427-share";
  delete process.env.NODE4_BROWSER_SANDBOX_IMAGE;

  const seat = resolveBrowserSandboxSeat({
    conversationId: "case-A",
    expertId: "pentest-1",
  });

  // --- main + sub resolve to one container create ---
  {
    const creates: string[] = [];
    const docker: BrowserSandboxDockerPort = {
      async rmForce() {
        return ok();
      },
      async runDetached(opts) {
        creates.push(opts.name);
        assert(
          opts.env.some((e) => e === `AGENT_BROWSER_SESSION=${agentBrowserSessionName(seat.seatKey)}`),
          "shared AGENT_BROWSER_SESSION for seat",
        );
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
    // Main burst
    await rt.ensure(seat);
    // Subagent on same seat (same conversationId+expertId)
    await rt.exec(seat, ["agent-browser", "open", "https://example.com"]);
    assert(creates.length === 1, "sub shares seat container");
  }

  // --- serialize concurrent execs per seat ---
  {
    let concurrent = 0;
    let maxConcurrent = 0;
    const docker: BrowserSandboxDockerPort = {
      async rmForce() {
        return ok();
      },
      async runDetached(opts) {
        return { exitCode: 0, stdout: opts.name, stderr: "" };
      },
      async exec() {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await delay(30);
        concurrent -= 1;
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
    await rt.ensure(seat);
    await Promise.all([
      rt.exec(seat, ["agent-browser", "a"]),
      rt.exec(seat, ["agent-browser", "b"]),
      rt.exec(seat, ["agent-browser", "c"]),
    ]);
    assert(maxConcurrent === 1, `serialized execs, maxConcurrent=${maxConcurrent}`);
  }

  console.log(JSON.stringify({ ok: true, cases: "seat-share-serialize" }, null, 2));
  console.log("RESULT: PASS — browser sandbox seat share (#427)");
} finally {
  for (const k of Object.keys(process.env)) {
    if (!(k in saved)) delete process.env[k];
  }
  Object.assign(process.env, saved);
}
