/**
 * Sessionized HTTP: cookie jar + multi-step requests + short history.
 * Audit-driven: CTF runs spent hundreds of shell turns on curl -b/-c chains.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { emitEvidence, isInScope, jsonResult, resolveTargetUrl, textResult } from "./common.js";

type JarMap = Record<string, string>;
type HistoryRow = {
  method: string;
  url: string;
  status: number;
  set_cookie_keys: string[];
  body_preview: string;
  at: string;
};

export function createSessionTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "session",
    label: "Session HTTP",
    description: [
      "Sessionized in-scope HTTP with a durable cookie jar and request history.",
      "Ops: request | chain | jar_get | jar_set | jar_clear | history.",
      "Use chain for multi-step login/exploit flows instead of hand-rolled curl -b/-c shell loops.",
      "Still prefer shell for scanners (sqlmap/ffuf) and non-HTTP work.",
    ].join(" "),
    parameters: Type.Object({
      op: Type.String(),
      method: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
      headers: Type.Optional(Type.Record(Type.String(), Type.String())),
      body: Type.Optional(Type.String()),
      timeout_seconds: Type.Optional(Type.Number()),
      /** chain: ordered steps [{method?, url, headers?, body?}] */
      steps: Type.Optional(
        Type.Array(
          Type.Object({
            method: Type.Optional(Type.String()),
            url: Type.String(),
            headers: Type.Optional(Type.Record(Type.String(), Type.String())),
            body: Type.Optional(Type.String()),
          }),
        ),
      ),
      /** jar_set: cookie name/value map to merge */
      cookies: Type.Optional(Type.Record(Type.String(), Type.String())),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: any) {
      const op = String(params.op || "request").trim().toLowerCase();
      const dir = join(runtime.taskDir, "session");
      await mkdir(dir, { recursive: true });
      const jarPath = join(dir, "cookies.json");
      const histPath = join(dir, "history.jsonl");

      if (op === "jar_get") {
        const jar = await loadJar(jarPath);
        return jsonResult({ ok: true, op, cookies: jar, cookie_header: formatCookieHeader(jar) });
      }
      if (op === "jar_clear") {
        await writeFile(jarPath, "{}", "utf8");
        return jsonResult({ ok: true, op, cookies: {} });
      }
      if (op === "jar_set") {
        const jar = await loadJar(jarPath);
        const incoming = params.cookies && typeof params.cookies === "object" ? params.cookies : {};
        for (const [k, v] of Object.entries(incoming)) {
          if (k) jar[String(k)] = String(v);
        }
        await saveJar(jarPath, jar);
        return jsonResult({ ok: true, op, cookies: jar });
      }
      if (op === "history") {
        const limit = Math.min(Math.max(Number(params.limit || 20), 1), 100);
        const rows = await loadHistory(histPath, limit);
        return jsonResult({ ok: true, op, count: rows.length, rows });
      }

      if (op === "chain") {
        const steps = Array.isArray(params.steps) ? params.steps : [];
        if (!steps.length) return textResult("error: chain requires steps[]");
        if (steps.length > 12) return textResult("error: chain max 12 steps");
        const results: unknown[] = [];
        let jar = await loadJar(jarPath);
        for (const step of steps) {
          const one = await doRequest(runtime, {
            method: String(step.method || "GET"),
            url: String(step.url || ""),
            headers: step.headers,
            body: step.body != null ? String(step.body) : undefined,
            timeout_seconds: params.timeout_seconds,
            jar,
          });
          if (!one.ok) {
            return jsonResult({ ok: false, op, error: one.error, completed: results, jar });
          }
          jar = one.jar;
          results.push({
            status: one.status,
            url: one.url,
            set_cookie_keys: one.set_cookie_keys,
            body_preview: one.body_preview,
            evidence_id: one.evidence_id,
          });
          await appendHistory(histPath, {
            method: one.method,
            url: one.url,
            status: one.status!,
            set_cookie_keys: one.set_cookie_keys || [],
            body_preview: (one.body_preview || "").slice(0, 500),
            at: new Date().toISOString(),
          });
        }
        await saveJar(jarPath, jar);
        const evidenceId = await emitEvidence(runtime, "session", `session chain x${results.length}`, {
          steps: results,
          cookies: jar,
        });
        return jsonResult({
          ok: true,
          op,
          steps: results,
          cookies: jar,
          evidence_id: evidenceId,
        });
      }

      // default: request
      if (op !== "request") return textResult("error: op must be request|chain|jar_get|jar_set|jar_clear|history");
      let jar = await loadJar(jarPath);
      const one = await doRequest(runtime, {
        method: String(params.method || "GET"),
        url: String(params.url || ""),
        headers: params.headers,
        body: params.body != null ? String(params.body) : undefined,
        timeout_seconds: params.timeout_seconds,
        jar,
      });
      if (!one.ok) return textResult(`error: ${one.error}`);
      jar = one.jar;
      await saveJar(jarPath, jar);
      await appendHistory(histPath, {
        method: one.method,
        url: one.url,
        status: one.status!,
        set_cookie_keys: one.set_cookie_keys || [],
        body_preview: (one.body_preview || "").slice(0, 500),
        at: new Date().toISOString(),
      });
      return jsonResult({
        ok: true,
        op: "request",
        status: one.status,
        url: one.url,
        headers: one.headers,
        body: one.body_preview,
        truncated: one.truncated,
        set_cookie_keys: one.set_cookie_keys,
        cookies: jar,
        evidence_id: one.evidence_id,
      });
    },
  };
}

async function doRequest(
  runtime: ToolRuntime,
  input: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
    timeout_seconds?: number;
    jar: JarMap;
  },
): Promise<{
  ok: boolean;
  error?: string;
  method: string;
  url: string;
  status?: number;
  headers?: Record<string, string>;
  body_preview?: string;
  truncated?: boolean;
  set_cookie_keys?: string[];
  jar: JarMap;
  evidence_id?: string;
}> {
  let url: string;
  try {
    url = resolveTargetUrl(runtime, input.url);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), method: input.method, url: input.url, jar: input.jar };
  }
  if (!isInScope(runtime, url)) {
    return { ok: false, error: `out of scope: ${url}`, method: input.method, url, jar: input.jar };
  }
  const method = input.method.toUpperCase() || "GET";
  const timeoutMs = Math.min(Math.max(Number(input.timeout_seconds || 30) * 1000, 1000), 120_000);
  const headers: Record<string, string> = { ...(input.headers || {}) };
  const cookieHeader = formatCookieHeader(input.jar);
  if (cookieHeader && !headers.Cookie && !headers.cookie) headers.Cookie = cookieHeader;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: input.body != null ? input.body : undefined,
      signal: controller.signal,
      redirect: "manual",
    });
    const text = await res.text();
    const body_preview = text.slice(0, 8000);
    const resHeaders = Object.fromEntries(res.headers.entries());
    const jar = { ...input.jar };
    const setKeys = mergeSetCookie(jar, res.headers);
    const evidence_id = await emitEvidence(runtime, "session", `${method} ${url} → ${res.status}`, {
      method,
      url,
      status: res.status,
      headers: resHeaders,
      body_preview,
      set_cookie_keys: setKeys,
    });
    return {
      ok: true,
      method,
      url,
      status: res.status,
      headers: resHeaders,
      body_preview,
      truncated: text.length > body_preview.length,
      set_cookie_keys: setKeys,
      jar,
      evidence_id,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      method,
      url,
      jar: input.jar,
    };
  } finally {
    clearTimeout(timer);
  }
}

function formatCookieHeader(jar: JarMap): string {
  return Object.entries(jar)
    .filter(([k, v]) => k && v != null)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function mergeSetCookie(jar: JarMap, headers: Headers): string[] {
  const keys: string[] = [];
  const rawList =
    typeof (headers as any).getSetCookie === "function"
      ? ((headers as any).getSetCookie() as string[])
      : (() => {
          const single = headers.get("set-cookie");
          return single ? [single] : [];
        })();
  for (const raw of rawList) {
    const pair = String(raw).split(";")[0] || "";
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    jar[name] = value;
    keys.push(name);
  }
  return keys;
}

async function loadJar(path: string): Promise<JarMap> {
  try {
    const raw = await readFile(path, "utf8");
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== "object" || Array.isArray(o)) return {};
    const jar: JarMap = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      jar[String(k)] = String(v);
    }
    return jar;
  } catch {
    return {};
  }
}

async function saveJar(path: string, jar: JarMap): Promise<void> {
  await writeFile(path, JSON.stringify(jar, null, 2), "utf8");
}

async function appendHistory(path: string, row: HistoryRow): Promise<void> {
  await writeFile(path, `${JSON.stringify(row)}\n`, { encoding: "utf8", flag: "a" });
}

async function loadHistory(path: string, limit: number): Promise<HistoryRow[]> {
  try {
    const text = await readFile(path, "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    const slice = lines.slice(-limit);
    return slice.map((l) => JSON.parse(l) as HistoryRow);
  } catch {
    return [];
  }
}
