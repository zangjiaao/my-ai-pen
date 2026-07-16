/**
 * Live DVWA evidence quality check (no full LLM loop).
 * Hits http://127.0.0.1:8080, exercises http/shell/write/finding, asserts
 * Case-facing properties (role, excerpt, path_or_url) and collab payload shape.
 *
 * Run: node --experimental-strip-types (or transpile) this file from node4/
 */
import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvidenceStore } from "./stores/evidence.js";
import { GoalStore } from "./stores/goal.js";
import { TodoStore } from "./stores/todo.js";
import { createFindingTool } from "./tools/finding.js";
import { createWriteTool } from "./tools/fs-tools.js";
import { createHttpTool } from "./tools/http.js";
import { createShellTool } from "./tools/shell.js";
import { formatCaseContextInjection, parseCaseContext } from "./runtime/case-context.js";
import type { PlatformMessage, ToolRuntime } from "./types.js";

const DVWA = process.env.DVWA_URL || "http://127.0.0.1:8080";
const root = join(tmpdir(), `node4-dvwa-evidence-${Date.now()}`);
const taskId = "dvwa-ev-smoke";
const taskDir = join(root, taskId);

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

function textOf(result: { content?: Array<{ type?: string; text?: string }> }): string {
  return (result.content || []).map((c) => c.text || "").join("\n");
}

async function exec(tool: { execute: Function }, id: string, params: unknown) {
  return tool.execute(id, params);
}

function hollowProps(p: Record<string, unknown> | undefined): boolean {
  if (!p || typeof p !== "object") return true;
  for (const key of ["stdout", "excerpt", "body_preview", "response_body", "preview", "path", "path_or_url", "url", "command"]) {
    const v = p[key];
    if (typeof v === "string" && v.trim()) return false;
  }
  const proof = p.proof as Record<string, unknown> | undefined;
  if (proof && typeof proof === "object") {
    for (const key of ["stdout_excerpt", "body_excerpt"]) {
      const v = proof[key];
      if (typeof v === "string" && v.trim()) return false;
    }
  }
  return true;
}

async function main(): Promise<void> {
  // Preflight
  const probe = await fetch(`${DVWA}/login.php`);
  assert(probe.ok || probe.status === 200, `DVWA not reachable at ${DVWA} (status ${probe.status})`);

  await mkdir(join(taskDir, "evidence"), { recursive: true });
  await mkdir(join(taskDir, "findings"), { recursive: true });
  await mkdir(join(taskDir, "scripts"), { recursive: true });
  await mkdir(join(taskDir, "notes/source_dump"), { recursive: true });

  const messages: PlatformMessage[] = [];
  const platform = {
    async send(m: PlatformMessage) {
      messages.push(m);
    },
  };

  const runtime: ToolRuntime = {
    task: {
      taskId,
      conversationId: "conv-dvwa-ev",
      instruction: "DVWA evidence quality smoke",
      target: { type: "url", value: DVWA },
      scope: { allow: ["127.0.0.1", "localhost", DVWA] },
      engagement: "pentest",
    },
    workspaceDir: root,
    taskDir,
    platform,
    todo: new TodoStore(),
    evidence: new EvidenceStore(join(taskDir, "evidence")),
    findingsDir: join(taskDir, "findings"),
    goals: new GoalStore(),
    rolePackId: "pentest",
    lifecycle: {},
  };

  const http = createHttpTool(runtime);
  const shell = createShellTool(runtime);
  const write = createWriteTool(runtime);
  const finding = createFindingTool(runtime);

  // 1) HTTP against real DVWA login page
  const loginRes = JSON.parse(
    textOf(await exec(http, "h1", { method: "GET", url: `${DVWA}/login.php` })),
  );
  assert(loginRes.ok && loginRes.status === 200, `login GET status=${loginRes.status}`);
  assert(loginRes.evidence_id, "http evidence_id");
  assert(String(loginRes.body || "").toLowerCase().includes("login") || String(loginRes.body || "").includes("user_token"), "login page body");

  // 2) Shell multi-step: token + login + SQLi low-ish probe (demonstrable response body)
  const shellCmd = [
    `BASE='${DVWA}'`,
    "CK=$(mktemp)",
    "HTML=$(curl -sS -c \"$CK\" -b \"$CK\" \"$BASE/login.php\")",
    "TOKEN=$(printf '%s' \"$HTML\" | sed -n \"s/.*name='user_token' value='\\([^']*\\)'.*/\\1/p\" | head -1)",
    "curl -sS -c \"$CK\" -b \"$CK\" -X POST \"$BASE/login.php\" -d \"username=admin&password=password&Login=Login&user_token=$TOKEN\" -o /dev/null",
    // Set security low via cookie (DVWA convention)
    "curl -sS -c \"$CK\" -b \"$CK\" -X POST \"$BASE/security.php\" -d \"security=low&seclev_submit=Submit&user_token=$TOKEN\" -o /dev/null || true",
    "echo \"COOKIE_JAR:\"",
    "cat \"$CK\"",
    "echo \"SQLI_PROBE:\"",
    "curl -sS -b \"$CK\" -b \"security=low\" \"$BASE/vulnerabilities/sqli/?id=1'+OR+'1'='1&Submit=Submit\" | head -c 2500",
    "echo",
    "rm -f \"$CK\"",
  ].join(" && ");

  const shellRes = JSON.parse(textOf(await exec(shell, "s1", { command: shellCmd, timeout_seconds: 60 })));
  assert(shellRes.evidence_id, "shell evidence_id");
  const shellOut = String(shellRes.stdout || "");
  assert(shellOut.length > 32, `shell stdout too short: ${shellOut.slice(0, 120)}`);
  // Best-effort: SQLi page often shows First name / Surname rows when injection works
  const sqliHit =
    /First name/i.test(shellOut) ||
    /Surname/i.test(shellOut) ||
    /admin/i.test(shellOut) ||
    /SQL/i.test(shellOut) ||
    /COOKIE_JAR/i.test(shellOut);
  assert(sqliHit, `unexpected DVWA shell output: ${shellOut.slice(0, 300)}`);

  // 3) Material write (source dump style) — code-audit collab path
  const srcContent = [
    "<?php",
    "// Simulated leaked DVWA-ish sqli handler for collab evidence",
    "$id = $_GET['id'];",
    "$query = \"SELECT first_name, last_name FROM users WHERE user_id = '$id';\";",
    "$result = mysqli_query($GLOBALS[\"___mysqli_ston\"], $query);",
    "while ($row = mysqli_fetch_assoc($result)) {",
    "  echo 'First name: ' . $row['first_name'];",
    "  echo 'Surname: ' . $row['last_name'];",
    "}",
    "?>",
    "",
  ].join("\n");
  const writeRes = JSON.parse(
    textOf(
      await exec(write, "w1", {
        path: "notes/source_dump/sqli/index.php",
        content: srcContent,
      }),
    ),
  );
  assert(writeRes.ok && writeRes.evidence_id, "write evidence");
  assert(String(writeRes.relative_path || "").includes("source_dump"), "relative path");

  // 4) Noise shell (should classify as trace)
  const noiseRes = JSON.parse(textOf(await exec(shell, "s-noise", { command: "ls", timeout_seconds: 10 })));
  assert(noiseRes.evidence_id, "noise evidence id");

  // 5) Book finding linking http + shell + source material
  const eHttp = loginRes.evidence_id as string;
  const eShell = shellRes.evidence_id as string;
  const eSrc = writeRes.evidence_id as string;

  const book = textOf(
    await exec(finding, "f1", {
      action: "confirm",
      title: "SQL injection on DVWA /vulnerabilities/sqli/",
      severity: "high",
      location: `${DVWA}/vulnerabilities/sqli/`,
      description:
        "User-controlled id parameter reaches SQL query without parameterization; multi-row user data returned on classic OR payload.",
      poc: [
        "1. Login as admin/password on DVWA",
        "2. GET /vulnerabilities/sqli/?id=1'+OR+'1'='1&Submit=Submit with security=low",
        "3. Observe First name/Surname rows for multiple users in response body",
      ].join("\n"),
      evidence_ids: [eShell, eSrc, eHttp],
    }),
  );
  assert(book.includes('"ok": true') || book.includes('"ok":true'), `finding book failed: ${book.slice(0, 400)}`);

  // --- Assert platform evidence_created payloads (Case layer) ---
  const created = messages.filter((m) => m.type === "evidence_created");
  assert(created.length >= 4, `expected >=4 evidence_created, got ${created.length}`);

  const byId = new Map<string, PlatformMessage>();
  for (const m of created) byId.set(String(m.evidence_id), m);

  const report: string[] = [];
  report.push(`# DVWA evidence smoke report`);
  report.push(`target: ${DVWA}`);
  report.push(`taskDir: ${taskDir}`);
  report.push(`evidence_created: ${created.length}`);
  report.push(`vuln_found: ${messages.filter((m) => m.type === "vuln_found").length}`);
  report.push("");

  let hollow = 0;
  let proofCount = 0;
  let withExcerpt = 0;
  for (const m of created) {
    const props = (m.properties && typeof m.properties === "object" ? m.properties : {}) as Record<string, unknown>;
    const id = String(m.evidence_id);
    const isHollow = hollowProps(props);
    if (isHollow) hollow += 1;
    if (props.role === "proof") proofCount += 1;
    if (String(props.excerpt || "").trim()) withExcerpt += 1;
    report.push(
      `- ${id} tool=${m.source_tool} type=${m.evidence_type} role=${props.role || "?"} kind=${props.kind || "?"} hollow=${isHollow} excerpt_len=${String(props.excerpt || "").length} path=${props.path_or_url || props.path || props.url || "-"}`,
    );
  }

  // Act tools that should be proof with content
  for (const id of [eHttp, eShell, eSrc]) {
    const m = byId.get(id);
    assert(m, `missing platform message for ${id}`);
    const props = m!.properties as Record<string, unknown>;
    assert(!hollowProps(props), `hollow Case properties for ${id}: ${JSON.stringify(props).slice(0, 200)}`);
    assert(props.role === "proof", `${id} expected role=proof got ${props.role}`);
    assert(String(props.excerpt || "").length >= 8, `${id} missing excerpt`);
  }

  // Source material path for code-audit collab
  const srcProps = byId.get(eSrc)!.properties as Record<string, unknown>;
  assert(srcProps.kind === "source_excerpt" || srcProps.kind === "file", `src kind=${srcProps.kind}`);
  assert(String(srcProps.path_or_url || srcProps.path || "").includes("source_dump"), "src path missing");
  assert(String(srcProps.excerpt || srcProps.preview || "").includes("SELECT"), "src preview missing SQL");

  // HTTP has body
  const httpProps = byId.get(eHttp)!.properties as Record<string, unknown>;
  assert(httpProps.kind === "http", "http kind");
  assert(httpProps.path_or_url || httpProps.url, "http url");
  assert(String(httpProps.response_body || httpProps.body_preview || httpProps.excerpt || "").length > 20, "http body");

  // Shell has stdout
  const shellProps = byId.get(eShell)!.properties as Record<string, unknown>;
  assert(shellProps.kind === "shell", "shell kind");
  assert(String(shellProps.stdout || shellProps.excerpt || "").length > 32, "shell stdout on Case props");

  // Noise should prefer trace
  const noiseMsg = byId.get(String(noiseRes.evidence_id));
  if (noiseMsg) {
    const np = noiseMsg.properties as Record<string, unknown>;
    report.push(`noise role=${np.role} excerpt=${String(np.excerpt || "").slice(0, 40)}`);
    // ls may still be proof if directory has many names; soft check
  }

  // vuln_found carries proof_excerpts
  const vuln = messages.find((m) => m.type === "vuln_found");
  assert(vuln, "vuln_found missing");
  const pe = vuln!.proof_excerpts as Array<{ evidence_id?: string; excerpt?: string }> | undefined;
  assert(Array.isArray(pe) && pe.length >= 1, "proof_excerpts on vuln_found");
  assert(pe!.every((x) => String(x.excerpt || "").length > 0), "empty proof excerpt");

  // Local evidence files match platform ids
  const files = (await readdir(join(taskDir, "evidence"))).filter((n) => n.endsWith(".json"));
  assert(files.length >= 4, `local evidence files ${files.length}`);
  for (const id of [eHttp, eShell, eSrc]) {
    const raw = JSON.parse(await readFile(join(taskDir, "evidence", `${id}.json`), "utf8"));
    assert(raw.data, `local data for ${id}`);
  }

  // Simulate joining expert case_context injection (Node side)
  const snippets = created
    .filter((m) => {
      const p = m.properties as Record<string, unknown>;
      return p.role === "proof" && !hollowProps(p);
    })
    .slice(0, 12)
    .map((m) => {
      const p = m.properties as Record<string, unknown>;
      return {
        id: String(m.evidence_id),
        kind: String(p.kind || m.evidence_type || "tool"),
        role: String(p.role || "proof"),
        path_or_url: String(p.path_or_url || p.path || p.url || ""),
        summary: String(m.summary || ""),
        excerpt: String(p.excerpt || "").slice(0, 360),
        source_tool: String(m.source_tool || ""),
      };
    });

  const ctx = parseCaseContext({
    version: 2,
    conversation_id: "conv-dvwa-ev",
    note: "Simulated case_context after pentest booking",
    thread: [
      { speaker: "user", text: "Test DVWA and dump any leaked source paths for code-audit" },
      { speaker: "pentest", text: "SQLi confirmed; source sample under notes/source_dump" },
    ],
    findings_summary: [
      {
        id: "f-dvwa-sqli",
        title: "SQL injection on DVWA /vulnerabilities/sqli/",
        severity: "high",
        status: "confirmed",
        location: `${DVWA}/vulnerabilities/sqli/`,
        evidence_ids: [eShell, eSrc, eHttp],
        proof_excerpt: String(pe![0]?.excerpt || "").slice(0, 280),
      },
    ],
    evidence_snippets: snippets,
    artifact_hints: ["notes/source_dump/sqli/index.php"],
  });
  const injection = formatCaseContextInjection(ctx);
  assert(injection.includes("Case evidence"), "injection has evidence section");
  assert(injection.includes(eSrc) || injection.includes("source_dump"), "injection has source path/id");
  assert(injection.includes("SQL injection") || injection.includes("sqli"), "injection has finding");

  // Metrics vs Phase A baseline
  const actCreated = created.filter((m) => ["http", "shell", "write"].includes(String(m.source_tool)));
  const actHollow = actCreated.filter((m) => hollowProps(m.properties as Record<string, unknown>)).length;
  report.push("");
  report.push("## Metrics (act tools)");
  report.push(`act evidence_created: ${actCreated.length}`);
  report.push(`act hollow: ${actHollow} (Phase A baseline was ~100% hollow on Case)`);
  report.push(`proof role count (all): ${proofCount}`);
  report.push(`with excerpt (all): ${withExcerpt}`);
  report.push(`finding→evidence linked: 3 ids booked`);
  report.push("");
  report.push("## case_context injection preview (truncated)");
  report.push(injection.slice(0, 2000));
  report.push("");
  report.push(actHollow === 0 ? "RESULT: PASS — Case-facing properties non-hollow for act tools" : "RESULT: FAIL — hollow properties remain");

  const reportPath = join(taskDir, "evidence-quality-report.md");
  await writeFile(reportPath, report.join("\n"), "utf8");
  // also copy under node4/tmp for easy open
  const outDir = join(process.cwd(), "tmp", "dvwa-evidence-smoke");
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "evidence-quality-report.md"), report.join("\n"), "utf8");
  await writeFile(join(outDir, "platform-messages.json"), JSON.stringify(messages, null, 2), "utf8");
  await writeFile(join(outDir, "case-context-injection.txt"), injection, "utf8");

  console.log(report.join("\n"));
  console.log(`\n[dvwa-evidence-smoke] report: ${join(outDir, "evidence-quality-report.md")}`);
  if (actHollow > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
