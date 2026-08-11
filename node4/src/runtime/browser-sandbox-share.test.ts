/**
 * Spec #332: sub-agents share parent sandbox + session; browser exec serialized per parent.
 * Run: npx tsx src/runtime/browser-sandbox-share.test.ts
 */
import {
  agentBrowserSessionName,
  BrowserSandboxRuntime,
  containerNameForParentTask,
  resolveBrowserSandboxParentTaskId,
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

// --- resolveBrowserSandboxParentTaskId ---
{
  assert(
    resolveBrowserSandboxParentTaskId({ taskId: "parent-1" }) === "parent-1",
    "root task id is parent key",
  );
  assert(
    resolveBrowserSandboxParentTaskId({
      taskId: "parent-1/sub/agent-a",
      parentTaskId: "parent-1",
    }) === "parent-1",
    "explicit parentTaskId wins",
  );
  assert(
    resolveBrowserSandboxParentTaskId({ taskId: "parent-1/sub/agent-a" }) === "parent-1",
    "strip /sub/ when parentTaskId missing",
  );
  assert(
    resolveBrowserSandboxParentTaskId({
      taskId: "parent-1/sub/a/sub/b",
      parentTaskId: "root",
    }) === "root",
    "nested still uses structured parent",
  );
  assert(
    agentBrowserSessionName("parent-1") === "node4-parent-1",
    "shared session name from parent",
  );
  assert(
    containerNameForParentTask("parent-1") === containerNameForParentTask("parent-1"),
    "stable container name",
  );
  assert(
    containerNameForParentTask("parent-1") !==
      containerNameForParentTask("parent-1/sub/agent-a"),
    "raw sub id would differ — must not use sub id as key",
  );
}

const saved = { ...process.env };
try {
  process.env.PEN_SANDBOX_IMAGE = "pen-sandbox:test-332";
  delete process.env.NODE4_BROWSER_SANDBOX_IMAGE;

  // --- parent + sub key resolve to one container create ---
  {
    const creates: string[] = [];
    const docker: BrowserSandboxDockerPort = {
      async rmForce() {
        return ok();
      },
      async runDetached(opts) {
        creates.push(opts.name);
        assert(
          opts.env.some((e) => e === `AGENT_BROWSER_SESSION=${agentBrowserSessionName("parent-A")}`),
          "shared AGENT_BROWSER_SESSION from parent",
        );
        return { exitCode: 0, stdout: opts.name, stderr: "" };
      },
      async exec() {
        return ok();
      },
    };
    const rt = new BrowserSandboxRuntime({ docker });
    const parentKey = resolveBrowserSandboxParentTaskId({ taskId: "parent-A" });
    const subKey = resolveBrowserSandboxParentTaskId({
      taskId: "parent-A/sub/w1",
      parentTaskId: "parent-A",
    });
    assert(parentKey === subKey, "parent and sub resolve same key");
    await rt.ensure(parentKey);
    await rt.exec(subKey, ["agent-browser", "snapshot"]);
    await rt.exec(
      resolveBrowserSandboxParentTaskId({ taskId: "parent-A/sub/w2" }),
      ["agent-browser", "snapshot"],
    );
    assert(creates.length === 1, `one box for parent+subs, got ${creates.length}`);
    assert(creates[0] === containerNameForParentTask("parent-A"), "parent-scoped name");
  }

  // --- concurrent exec for same parent is serialized (no interleave) ---
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
        await delay(40);
        concurrent -= 1;
        return ok();
      },
    };
    const rt = new BrowserSandboxRuntime({ docker });
    await rt.ensure("parent-serial");
    await Promise.all([
      rt.exec("parent-serial", ["agent-browser", "a"]),
      rt.exec("parent-serial", ["agent-browser", "b"]),
      rt.exec("parent-serial", ["agent-browser", "c"]),
    ]);
    assert(maxConcurrent === 1, `same-parent exec serialized, maxConcurrent=${maxConcurrent}`);
  }

  // --- different parents may run browser exec concurrently ---
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
        await delay(40);
        concurrent -= 1;
        return ok();
      },
    };
    const rt = new BrowserSandboxRuntime({ docker });
    await Promise.all([rt.ensure("p-x"), rt.ensure("p-y")]);
    await Promise.all([
      rt.exec("p-x", ["agent-browser", "x"]),
      rt.exec("p-y", ["agent-browser", "y"]),
    ]);
    assert(maxConcurrent >= 2, `cross-parent not serialized, maxConcurrent=${maxConcurrent}`);
  }

  console.log(JSON.stringify({ ok: true, cases: "share+serialize" }, null, 2));
  console.log("RESULT: PASS — browser sandbox share (#332)");
} finally {
  for (const k of Object.keys(process.env)) {
    if (!(k in saved)) delete process.env[k];
  }
  Object.assign(process.env, saved);
}
