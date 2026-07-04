import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { emitToolEvidence, isInScope, jsonResult } from "./common.js";

const SCANNERS: Record<string, { command: string; build: (p: Record<string, unknown>) => string[]; timeoutMs: number }> = {
  nmap: { command: "nmap", timeoutMs: 10 * 60_000, build: (p) => compact(["-sV", String(p.target || ""), ...(asArray(p.args))]) },
  httpx: { command: "httpx", timeoutMs: 5 * 60_000, build: (p) => compact(["-silent", "-json", "-u", String(p.target || ""), ...(asArray(p.args))]) },
  katana: { command: "katana", timeoutMs: 8 * 60_000, build: (p) => compact(["-silent", "-jsonl", "-u", String(p.target || ""), ...(asArray(p.args))]) },
  ffuf: { command: "ffuf", timeoutMs: 10 * 60_000, build: (p) => compact(["-u", String(p.url || p.target || ""), "-w", String(p.wordlist || ""), "-json", ...(asArray(p.args))]) },
  nuclei: { command: "nuclei", timeoutMs: 12 * 60_000, build: (p) => compact(["-jsonl", "-u", String(p.target || ""), ...(asArray(p.args))]) },
  sqlmap: { command: "sqlmap", timeoutMs: 15 * 60_000, build: (p) => compact(["-u", String(p.url || p.target || ""), "--batch", ...(asArray(p.args))]) },
  dalfox: { command: "dalfox", timeoutMs: 10 * 60_000, build: (p) => compact(["url", String(p.url || p.target || ""), "--output", "stdout", ...(asArray(p.args))]) },
  arjun: { command: "arjun", timeoutMs: 8 * 60_000, build: (p) => compact(["-u", String(p.url || p.target || ""), "-oJ", "-", ...(asArray(p.args))]) },
  wafw00f: { command: "wafw00f", timeoutMs: 3 * 60_000, build: (p) => compact([String(p.target || ""), ...(asArray(p.args))]) },
  nikto: { command: "nikto", timeoutMs: 12 * 60_000, build: (p) => compact(["-h", String(p.target || ""), ...(asArray(p.args))]) },
};

export function createScanTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "scan",
    label: "Scan",
    description: "Run an allowed professional scanner with structured arguments. Supported scanners: nmap, httpx, katana, ffuf, nuclei, sqlmap, dalfox, arjun, wafw00f, nikto.",
    promptSnippet: "Run allowed professional security scanners",
    promptGuidelines: [
      "Use scan for broad or specialized probing instead of inventing request loops manually.",
      "Use scanner output as candidates until verified with http/browser/poc and evidence.",
    ],
    parameters: Type.Object({
      scanner: Type.String(),
      target: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
      wordlist: Type.Optional(Type.String()),
      args: Type.Optional(Type.Array(Type.String())),
      timeout_seconds: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId: string, params: any) {
      const spec = SCANNERS[params.scanner];
      if (!spec) throw new Error(`unsupported scanner: ${params.scanner}`);
      const target = String(params.url || params.target || "");
      if (!target) throw new Error("target or url is required");
      if (!isInScope(runtime, target)) throw new Error(`out of scope: ${target}`);
      const argv = spec.build(params);
      const result = await runProcess(spec.command, argv, Math.min((params.timeout_seconds || spec.timeoutMs / 1000) * 1000, spec.timeoutMs));
      const evidenceId = await emitToolEvidence(runtime, "scan", `${params.scanner} ${target}`, { scanner: params.scanner, argv, ...result });
      return jsonResult({ evidence_id: evidenceId, scanner: params.scanner, argv, ...result }, { evidenceId });
    },
  };
}

function runProcess(command: string, argv: string[], timeoutMs: number): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { shell: false, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8").slice(0, 128 * 1024),
        stderr: Buffer.concat(stderr).toString("utf8").slice(0, 32 * 1024),
      });
    });
  });
}

function asArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function compact(values: string[]): string[] {
  return values.filter((value) => value.length > 0);
}
