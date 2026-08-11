/**
 * Spec #334 / #427: labels, lease heartbeat, janitor reaping (fake Docker) — seat-keyed.
 * Run: npx tsx src/runtime/browser-sandbox-lease.test.ts
 */
import {
  BrowserSandboxRuntime,
  formatBrowserSandboxSeatKey,
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

function seat(conv: string, expert: string) {
  const seatKey = formatBrowserSandboxSeatKey(conv, expert);
  return { conversationId: conv, expertId: expert, seatKey };
}

// --- pure label / reap rules ---
{
  const labels = buildBrowserSandboxLabels({
    nodeId: "node-a",
    instanceId: "inst-1",
    conversationId: "conv-1",
    expertId: "exp-1",
    seatKey: "conv-1::exp-1",
    leaseUntilUnix: 1_700_000_100,
  });
  assert(isProductBrowserSandboxLabels(labels), "product labels");
  assert(labels[BROWSER_SANDBOX_LABEL.component] === BROWSER_SANDBOX_COMPONENT, "component");
  assert(labels[BROWSER_SANDBOX_LABEL.nodeId] === "node-a", "node");
  assert(labels[BROWSER_SANDBOX_LABEL.instanceId] === "inst-1", "instance");
  assert(labels[BROWSER_SANDBOX_LABEL.conversationId] === "conv-1", "conversation");
  assert(labels[BROWSER_SANDBOX_LABEL.expertId] === "exp-1", "expert");
  assert(labels[BROWSER_SANDBOX_LABEL.seatKey] === "conv-1::exp-1", "seat");
  assert(labels[BROWSER_SANDBOX_LABEL.parentTaskId] === "conv-1::exp-1", "legacy parent=seatKey");
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
}

const saved = { ...process.env };
try {
  process.env.PEN_SANDBOX_IMAGE = "pen-sandbox:test-334";

  const lab = seat("lab-conv", "lab-exp");

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
    await rt.ensure(lab);
    assert(lastLabels, "labels set");
    assert(lastLabels![BROWSER_SANDBOX_LABEL.component] === BROWSER_SANDBOX_COMPONENT, "component label");
    assert(lastLabels![BROWSER_SANDBOX_LABEL.nodeId] === "worker-1", "node label");
    assert(lastLabels![BROWSER_SANDBOX_LABEL.instanceId] === "boot-uuid-abc", "instance label");
    assert(lastLabels![BROWSER_SANDBOX_LABEL.conversationId] === lab.conversationId, "conv label");
    assert(lastLabels![BROWSER_SANDBOX_LABEL.expertId] === lab.expertId, "expert label");
    assert(lastLabels![BROWSER_SANDBOX_LABEL.seatKey] === lab.seatKey, "seat label");
    assert(lastLabels![BROWSER_SANDBOX_LABEL.leaseUntil], "lease label");
    assert(rt.getInstanceId() === "boot-uuid-abc", "instance id accessor");
  }

  // --- heartbeat renews lease for held and sticky sessions ---
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
    const s = seat("h", "e1");
    rt.holdSeat(s);
    await rt.ensure(s);
    assert(leases.length >= 1, "create writes lease");
    const first = leases[leases.length - 1];
    now += 60_000;
    const n = await rt.renewLeasesForHeldTasks();
    assert(n === 1, "renewed held session");
    assert(leases[leases.length - 1] > first, "lease extended");
    // Spec #427: after release, sticky session still in map → still renews
    rt.releaseSeat(s);
    const before = leases.length;
    await rt.renewLeasesForHeldTasks();
    assert(leases.length === before + 1, "sticky session still renews after hold release");
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
          conversationId: "c",
          expertId: "old",
          seatKey: "c::old",
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
          conversationId: "c",
          expertId: "live",
          seatKey: "c::live",
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
          conversationId: "c",
          expertId: "stale",
          seatKey: "c::stale",
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

  // --- held seat is never reaped even if lease looks expired ---
  {
    const rms: string[] = [];
    const s = seat("held-c", "held-e");
    let containerName = "";
    const docker: BrowserSandboxDockerPort = {
      async rmForce(name) {
        rms.push(name);
        return ok();
      },
      async runDetached(opts) {
        containerName = opts.name;
        return { exitCode: 0, stdout: opts.name, stderr: "" };
      },
      async exec() {
        return ok();
      },
      async listBrowserSandboxes() {
        return [
          {
            name: containerName || "node4-browser-held",
            labels: buildBrowserSandboxLabels({
              nodeId: "me",
              instanceId: "inst",
              conversationId: s.conversationId,
              expertId: s.expertId,
              seatKey: s.seatKey,
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
    rt.holdSeat(s);
    await rt.ensure(s);
    const rmsBeforeReap = rms.length;
    const result = await rt.reapExpired(999);
    assert(result.reaped.length === 0, "held seat not reaped");
    assert(rms.length === rmsBeforeReap, "reap did not rm held container");
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

  console.log(JSON.stringify({ ok: true, cases: "lease-seat-labels" }, null, 2));
  console.log("RESULT: PASS — browser sandbox lease (#427)");
} finally {
  for (const k of Object.keys(process.env)) {
    if (!(k in saved)) delete process.env[k];
  }
  Object.assign(process.env, saved);
}
