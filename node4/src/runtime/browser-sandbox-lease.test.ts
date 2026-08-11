/**
 * Spec #334: labels, lease heartbeat, janitor reaping (fake Docker).
 * Run: npx tsx src/runtime/browser-sandbox-lease.test.ts
 */
import {
  BrowserSandboxRuntime,
  type BrowserSandboxDockerPort,
  type BrowserSandboxListItem,
  type SandboxExecResult,
} from "./browser-sandbox.js";
import {
  BROWSER_SANDBOX_COMPONENT,
  BROWSER_SANDBOX_LABEL,
  buildBrowserSandboxLabels,
  isProductBrowserSandboxLabels,
  shouldReapBrowserSandbox,
} from "./browser-sandbox-labels.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function ok(): SandboxExecResult {
  return { exitCode: 0, stdout: "", stderr: "" };
}

// --- pure label / reap rules ---
{
  const labels = buildBrowserSandboxLabels({
    nodeId: "node-a",
    instanceId: "inst-1",
    parentTaskId: "task-1",
    leaseUntilUnix: 1_700_000_100,
  });
  assert(isProductBrowserSandboxLabels(labels), "product labels");
  assert(labels[BROWSER_SANDBOX_LABEL.component] === BROWSER_SANDBOX_COMPONENT, "component");
  assert(labels[BROWSER_SANDBOX_LABEL.nodeId] === "node-a", "node");
  assert(labels[BROWSER_SANDBOX_LABEL.instanceId] === "inst-1", "instance");
  assert(labels[BROWSER_SANDBOX_LABEL.parentTaskId] === "task-1", "parent");
  assert(
    !shouldReapBrowserSandbox({ labels, leaseUntilUnix: 1_700_000_100, nowUnix: 1_700_000_050 }),
    "non-expired not reaped",
  );
  assert(
    shouldReapBrowserSandbox({ labels, leaseUntilUnix: 1_700_000_100, nowUnix: 1_700_000_200 }),
    "expired reaped",
  );
  assert(
    !shouldReapBrowserSandbox({
      labels,
      leaseUntilUnix: 1_700_000_100,
      nowUnix: 1_700_000_200,
      leaseTrusted: false,
    }),
    "untrusted lease never reaped (stale-label guard)",
  );
  assert(
    !shouldReapBrowserSandbox({
      labels: { foo: "bar" },
      leaseUntilUnix: 1,
      nowUnix: 999,
    }),
    "unlabeled ignored",
  );
  assert(
    !shouldReapBrowserSandbox({
      labels: { [BROWSER_SANDBOX_LABEL.component]: "other" },
      leaseUntilUnix: 1,
      nowUnix: 999,
    }),
    "non-product ignored",
  );
}

const saved = { ...process.env };
try {
  process.env.PEN_SANDBOX_IMAGE = "pen-sandbox:test-334";

  // --- ensure attaches ownership labels ---
  {
    let lastLabels: Record<string, string> | undefined;
    const docker: BrowserSandboxDockerPort = {
      async rmForce() {
        return ok();
      },
      async runDetached(opts) {
        lastLabels = opts.labels;
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
    };
    const rt = new BrowserSandboxRuntime({
      docker,
      nodeId: "worker-1",
      instanceId: "boot-uuid-abc",
      now: () => 1_700_000_000_000,
      leaseConfig: { leaseMs: 600_000 },
    });
    await rt.ensure("parent-lab");
    assert(lastLabels, "labels set");
    assert(lastLabels![BROWSER_SANDBOX_LABEL.component] === BROWSER_SANDBOX_COMPONENT, "component label");
    assert(lastLabels![BROWSER_SANDBOX_LABEL.nodeId] === "worker-1", "node label");
    assert(lastLabels![BROWSER_SANDBOX_LABEL.instanceId] === "boot-uuid-abc", "instance label");
    assert(lastLabels![BROWSER_SANDBOX_LABEL.parentTaskId] === "parent-lab", "parent label");
    assert(lastLabels![BROWSER_SANDBOX_LABEL.leaseUntil], "lease label");
    assert(rt.getInstanceId() === "boot-uuid-abc", "instance id accessor");
  }

  // --- heartbeat renews lease while held ---
  {
    const leases: number[] = [];
    const docker: BrowserSandboxDockerPort = {
      async rmForce() {
        return ok();
      },
      async runDetached(opts) {
        return { exitCode: 0, stdout: opts.name, stderr: "" };
      },
      async exec() {
        return ok();
      },
      async listBrowserSandboxes() {
        return [];
      },
      async writeLease(_name, leaseUntilUnix) {
        leases.push(leaseUntilUnix);
        return ok();
      },
    };
    let now = 1_000_000_000_000;
    const rt = new BrowserSandboxRuntime({
      docker,
      now: () => now,
      leaseConfig: { leaseMs: 600_000, heartbeatMs: 60_000 },
    });
    rt.holdParentTask("held-1");
    await rt.ensure("held-1");
    assert(leases.length >= 1, "create writes lease");
    const first = leases[leases.length - 1];
    now += 60_000;
    const n = await rt.renewLeasesForHeldTasks();
    assert(n === 1, "renewed held session");
    assert(leases[leases.length - 1] > first, "lease extended");
    // not held → no renew
    rt.releaseParentTask("held-1");
    const before = leases.length;
    await rt.renewLeasesForHeldTasks();
    assert(leases.length === before, "no renew when not held");
  }

  // --- janitor reaps expired product only; keeps non-expired foreign ---
  {
    const rms: string[] = [];
    const items: BrowserSandboxListItem[] = [
      {
        name: "node4-browser-expired",
        labels: buildBrowserSandboxLabels({
          nodeId: "other-node",
          instanceId: "other-inst",
          parentTaskId: "t-old",
          leaseUntilUnix: 100,
        }),
        leaseUntilUnix: 100,
        leaseTrusted: true,
      },
      {
        name: "node4-browser-live",
        labels: buildBrowserSandboxLabels({
          nodeId: "other-node",
          instanceId: "other-inst",
          parentTaskId: "t-live",
          leaseUntilUnix: 9_999_999_999,
        }),
        leaseUntilUnix: 9_999_999_999,
        leaseTrusted: true,
      },
      {
        name: "node4-browser-untrusted",
        labels: buildBrowserSandboxLabels({
          nodeId: "other-node",
          instanceId: "other-inst",
          parentTaskId: "t-stale-label",
          leaseUntilUnix: 100,
        }),
        leaseUntilUnix: 100,
        leaseTrusted: false,
      },
      {
        name: "unrelated",
        labels: { app: "postgres" },
        leaseUntilUnix: 1,
        leaseTrusted: true,
      },
    ];
    const docker: BrowserSandboxDockerPort = {
      async rmForce(name) {
        rms.push(name);
        return ok();
      },
      async runDetached(opts) {
        return { exitCode: 0, stdout: opts.name, stderr: "" };
      },
      async exec() {
        return ok();
      },
      async listBrowserSandboxes() {
        return items;
      },
      async writeLease() {
        return ok();
      },
    };
    const rt = new BrowserSandboxRuntime({ docker, now: () => 200_000 });
    const result = await rt.reapExpired(200);
    assert(result.reaped.includes("node4-browser-expired"), "expired reaped");
    assert(!result.reaped.includes("node4-browser-live"), "live foreign kept");
    assert(!result.reaped.includes("node4-browser-untrusted"), "untrusted lease kept");
    assert(!result.reaped.includes("unrelated"), "unlabeled ignored");
    assert(rms.length === 1 && rms[0] === "node4-browser-expired", "only one rm");
  }

  // --- held parent is never reaped by this process even if lease looks expired ---
  {
    const rms: string[] = [];
    const docker: BrowserSandboxDockerPort = {
      async rmForce(name) {
        rms.push(name);
        return ok();
      },
      async runDetached(opts) {
        return { exitCode: 0, stdout: opts.name, stderr: "" };
      },
      async exec() {
        return ok();
      },
      async listBrowserSandboxes() {
        return [
          {
            name: "node4-browser-held",
            labels: buildBrowserSandboxLabels({
              nodeId: "me",
              instanceId: "inst",
              parentTaskId: "held-parent",
              leaseUntilUnix: 1,
            }),
            leaseUntilUnix: 1,
            leaseTrusted: true,
          },
        ];
      },
      async writeLease() {
        return ok();
      },
    };
    const rt = new BrowserSandboxRuntime({ docker, now: () => 999_000 });
    rt.holdParentTask("held-parent");
    await rt.ensure("held-parent");
    const result = await rt.reapExpired(999);
    assert(!result.reaped.includes("node4-browser-held"), "held parent not reaped");
    assert(!rms.includes("node4-browser-held"), "no rm of held");
  }

  // --- instance id is unique per runtime when not shared ---
  {
    const docker: BrowserSandboxDockerPort = {
      async rmForce() {
        return ok();
      },
      async runDetached(opts) {
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
    };
    const a = new BrowserSandboxRuntime({ docker, instanceId: "uuid-a" });
    const b = new BrowserSandboxRuntime({ docker, instanceId: "uuid-b" });
    assert(a.getInstanceId() !== b.getInstanceId(), "distinct instance ids");
  }

  console.log(JSON.stringify({ ok: true, cases: "labels-lease-janitor" }, null, 2));
  console.log("RESULT: PASS — browser sandbox lease (#334)");
} finally {
  for (const k of Object.keys(process.env)) {
    if (!(k in saved)) delete process.env[k];
  }
  Object.assign(process.env, saved);
}
