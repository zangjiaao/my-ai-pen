/**
 * Process facts store + index inject (A2/A5) on a temp task dir.
 */
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatProcessFactIndexInjection,
  ProcessFactStore,
} from "./process-fact.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const root = await mkdtemp(join(tmpdir(), "node4-facts-"));
const factsDir = join(root, "facts");
const store = new ProcessFactStore(factsDir);

try {
  const badKey = await store.upsert({
    fact_key: "../escape",
    summary: "x",
    body: "y",
  });
  assert("error" in badKey, "path escape key rejected");

  const up = await store.upsert({
    fact_key: "target/primary_url",
    summary: "Primary app at http://127.0.0.1:9/ — health 200",
    body: "curl -sI http://127.0.0.1:9/health → 200; Server: lab\nFailed probe: /admin 404",
    category: "target",
  });
  assert(!("error" in up), `upsert: ${JSON.stringify(up)}`);
  if (!("error" in up)) {
    assert(up.fact_key === "target/primary_url", "key preserved");
  }

  // No "asset" file inventing hosts — only facts JSON
  await access(join(factsDir, "target__primary_url.json"));

  const listed = await store.list();
  assert(listed.length === 1 && listed[0].fact_key === "target/primary_url", "list index");
  assert(!("body" in listed[0]), "index has no body field");

  const got = await store.get("target/primary_url");
  assert(!("error" in got), "get ok");
  if (!("error" in got)) {
    assert(got.body.includes("Failed probe"), "full body retrievable");
  }

  const inject = formatProcessFactIndexInjection(listed);
  assert(inject.includes("Process facts index"), "inject header");
  assert(inject.includes("target/primary_url"), "inject key");
  assert(!inject.includes("Failed probe"), "inject does not include body detail");
  assert(inject.includes("Do not invent"), "anti-hallucination guidance");
  assert(inject.includes("user-created only"), "asset ownership note");

  // Second fact + finding separation is conceptual; store stays facts only
  await store.upsert({
    fact_key: "auth/session",
    summary: "Login cookie PHPSESSID observed after POST /login",
    body: "Set-Cookie: PHPSESSID=abc; path=/\nReuse with session tool actor=user",
  });
  assert((await store.list()).length === 2, "two facts");

  console.log("process-fact.test.ts: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
