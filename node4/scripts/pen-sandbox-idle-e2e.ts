/**
 * Lab-only smoke: idle stop after env load + real Docker.
 * Not product authority / CI gate. Short 45s idle so the lab check finishes quickly.
 * Run: npx tsx scripts/pen-sandbox-idle-e2e.ts  (from node4/)
 */
import { spawnSync } from "node:child_process";
import { loadDotEnv } from "../src/env.js";

loadDotEnv();
loadDotEnv("node2/.env");
loadDotEnv("node4/.env");

process.env.PEN_SANDBOX_IDLE_STOP_MS = "45000";

const { BrowserSandboxRuntime, formatBrowserSandboxSeatKey } = await import(
  "../src/runtime/browser-sandbox.js"
);

const idle = Number(process.env.PEN_SANDBOX_IDLE_STOP_MS);
console.log(`[e2e] PEN_SANDBOX_IDLE_STOP_MS=${idle}`);

const rt = new BrowserSandboxRuntime({});
const cfg = rt.getLeaseConfig();
console.log(`[e2e] getLeaseConfig.idleStopMs=${cfg.idleStopMs}`);
if (cfg.idleStopMs !== 45000) {
  console.error("FAIL: idleStopMs not 45000 after env set, got", cfg.idleStopMs);
  process.exit(2);
}

// Early construct then set env — production bug class.
delete process.env.PEN_SANDBOX_IDLE_STOP_MS;
const early = new BrowserSandboxRuntime({});
const before = early.getLeaseConfig().idleStopMs;
process.env.PEN_SANDBOX_IDLE_STOP_MS = "45000";
const after = early.getLeaseConfig().idleStopMs;
console.log(`[e2e] early-construct before=${before} after_env=${after}`);
if (after !== 45000) {
  console.error("FAIL: early construct does not re-read env");
  process.exit(2);
}

const conversationId = `e2e-idle-${Date.now()}`;
const expertId = "e2e-expert";
const seat = {
  conversationId,
  expertId,
  seatKey: formatBrowserSandboxSeatKey(conversationId, expertId),
};

console.log(`[e2e] ensure seat=${seat.seatKey}`);
const session = await rt.ensure(seat);
console.log(`[e2e] container=${session.containerName}`);

const statusOf = (name: string) => {
  const r = spawnSync("docker", ["inspect", "--format", "{{.State.Status}}", name], {
    encoding: "utf8",
  });
  return (r.stdout || "").trim() || "missing";
};

const st0 = statusOf(session.containerName);
console.log(`[e2e] status after ensure: ${st0}`);
if (st0 !== "running") {
  console.error("FAIL: container not running after ensure");
  process.exit(2);
}

const waitMs = 45000 + 25000;
const start = Date.now();
let stopped = false;
while (Date.now() - start < waitMs) {
  const keys = await rt.stopIdleSeats();
  const st = statusOf(session.containerName);
  console.log(
    `[e2e] t+${Math.round((Date.now() - start) / 1000)}s status=${st} stoppedKeys=${JSON.stringify(keys)}`,
  );
  if (st !== "running") {
    stopped = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 5000));
}

const finalSt = statusOf(session.containerName);
console.log(`[e2e] final status=${finalSt}`);

await rt.dispose(seat).catch(() => {});
const afterRm = statusOf(session.containerName);
console.log(`[e2e] after dispose status=${afterRm}`);

if (!stopped) {
  console.error("FAIL: container still running after idle window");
  process.exit(1);
}
console.log("PASS: idle stop e2e");
