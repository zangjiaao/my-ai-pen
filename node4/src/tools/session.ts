/**
 * Sessionized HTTP: multi-actor cookie jars + multi-step requests + history.
 * Dual-identity: actor=user_a|user_b|browser|default — each has its own jar.
 */

import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolRuntime } from "../types.js";
import { recordActObservation, isInScope, jsonResult, resolveTargetUrl, textResult } from "./common.js";

type JarMap = Record<string, string>;
type HistoryRow = {
  actor: string;
  method: string;
  url: string;
  status: number;
  set_cookie_keys: string[];
  body_preview: string;
  at: string;
};

export function createSessionTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "session",
    label: "Session HTTP",
    description: [
      "Sessionized in-scope HTTP with durable per-actor cookie jars and history.",
      "Ops: request | chain | jar_get | jar_set | jar_clear | jar_copy | list_actors | compare | history.",
      "actor (default: default): separate jars for dual-identity tests (user_a vs user_b vs browser).",
      "jar_copy: copy cookies from one actor to another. compare: same request as two actors (status/length/body hash).",
      "Use chain for multi-step login/exploit. Prefer browser export_cookies into an actor after JS login.",
      "shell remains for scanners and non-HTTP work.",
    ].join(" "),
    parameters: Type.Object({
      op: Type.String(),
      actor: Type.Optional(Type.String()),
      /** jar_copy / compare: second actor */
      actor_b: Type.Optional(Type.String()),
      /** jar_copy: source actor (or use actor as source and actor_b as dest) */
      from_actor: Type.Optional(Type.String()),
      to_actor: Type.Optional(Type.String()),
      method: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
      headers: Type.Optional(Type.Record(Type.String(), Type.String())),
      body: Type.Optional(Type.String()),
      timeout_seconds: Type.Optional(Type.Number()),
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
      cookies: Type.Optional(Type.Record(Type.String(), Type.String())),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: any) {
      const op = String(params.op || "request").trim().toLowerCase();
      const actor = sanitizeActor(params.actor != null ? String(params.actor) : "default");
      const paths = actorPaths(runtime.taskDir, actor);
      await mkdir(paths.dir, { recursive: true });

      if (op === "list_actors") {
        const actors = await listActors(runtime.taskDir);
        return jsonResult({
          ok: true,
          op,
          actors,
          guidance: "Use actor=user_a|user_b|admin|browser for dual-identity / priv tests.",
        });
      }

      if (op === "jar_get") {
        const jar = await loadJar(paths.jar);
        return jsonResult({
          ok: true,
          op,
          actor,
          cookies: jar,
          cookie_header: formatCookieHeader(jar),
        });
      }
      if (op === "jar_clear") {
        await saveJar(paths.jar, {});
        return jsonResult({ ok: true, op, actor, cookies: {} });
      }
      if (op === "jar_set") {
        const jar = await loadJar(paths.jar);
        const incoming = params.cookies && typeof params.cookies === "object" ? params.cookies : {};
        for (const [k, v] of Object.entries(incoming)) {
          if (k) jar[String(k)] = String(v);
        }
        await saveJar(paths.jar, jar);
        return jsonResult({ ok: true, op, actor, cookies: jar });
      }
      if (op === "jar_copy") {
        const from = sanitizeActor(
          String(params.from_actor || params.actor || "default"),
        );
        const to = sanitizeActor(String(params.to_actor || params.actor_b || ""));
        if (!to || to === from) return textResult("error: jar_copy needs from_actor and to_actor (distinct)");
        const src = await loadJar(actorPaths(runtime.taskDir, from).jar);
        const destPaths = actorPaths(runtime.taskDir, to);
        await mkdir(destPaths.dir, { recursive: true });
        await saveJar(destPaths.jar, { ...src });
        return jsonResult({ ok: true, op, from_actor: from, to_actor: to, cookies: src });
      }
      if (op === "history") {
        const limit = Math.min(Math.max(Number(params.limit || 20), 1), 100);
        const rows = await loadHistory(paths.hist, limit);
        return jsonResult({ ok: true, op, actor, count: rows.length, rows });
      }

      if (op === "compare") {
        if (!params.url) return textResult("error: compare requires url");
        const actorB = sanitizeActor(String(params.actor_b || params.to_actor || "user_b"));
        if (actorB === actor) return textResult("error: compare needs two distinct actors (actor and actor_b)");
        const method = String(params.method || "GET");
        const body = params.body != null ? String(params.body) : undefined;
        const headers = params.headers;
        const timeout_seconds = params.timeout_seconds;
        const aPaths = actorPaths(runtime.taskDir, actor);
        const bPaths = actorPaths(runtime.taskDir, actorB);
        await mkdir(aPaths.dir, { recursive: true });
        await mkdir(bPaths.dir, { recursive: true });
        let jarA = await loadJar(aPaths.jar);
        let jarB = await loadJar(bPaths.jar);
        const ra = await doRequest(runtime, {
          method,
          url: String(params.url),
          headers,
          body,
          timeout_seconds,
          jar: jarA,
          actor,
        });
        const rb = await doRequest(runtime, {
          method,
          url: String(params.url),
          headers,
          body,
          timeout_seconds,
          jar: jarB,
          actor: actorB,
        });
        if (ra.ok) {
          jarA = ra.jar;
          await saveJar(aPaths.jar, jarA);
          await appendHistory(aPaths.hist, histRow(actor, ra));
        }
        if (rb.ok) {
          jarB = rb.jar;
          await saveJar(bPaths.jar, jarB);
          await appendHistory(bPaths.hist, histRow(actorB, rb));
        }
        recordActObservation(
          runtime,
          "session",
          `session compare ${actor} vs ${actorB} ${params.url}`,
          {
            actor_a: actor,
            actor_b: actorB,
            a: summarizeSide(ra),
            b: summarizeSide(rb),
          },
        );
        return jsonResult({
          ok: ra.ok && rb.ok,
          op: "compare",
          actor_a: actor,
          actor_b: actorB,
          a: summarizeSide(ra),
          b: summarizeSide(rb),
          same_status: ra.status === rb.status,
          same_length:
            (ra.body_preview?.length || 0) === (rb.body_preview?.length || 0),
          guidance:
            "Different status/body length often signals IDOR/vertical privilege issues — probe further and book with evidence.",
        });
      }

      if (op === "chain") {
        const steps = Array.isArray(params.steps) ? params.steps : [];
        if (!steps.length) return textResult("error: chain requires steps[]");
        if (steps.length > 12) return textResult("error: chain max 12 steps");
        const results: unknown[] = [];
        let jar = await loadJar(paths.jar);
        for (const step of steps) {
          const one = await doRequest(runtime, {
            method: String(step.method || "GET"),
            url: String(step.url || ""),
            headers: step.headers,
            body: step.body != null ? String(step.body) : undefined,
            timeout_seconds: params.timeout_seconds,
            jar,
            actor,
          });
          if (!one.ok) {
            return jsonResult({ ok: false, op, actor, error: one.error, completed: results, cookies: jar });
          }
          jar = one.jar;
          results.push({
            status: one.status,
            url: one.url,
            set_cookie_keys: one.set_cookie_keys,
            body_preview: one.body_preview,
          });
          await appendHistory(paths.hist, histRow(actor, one));
        }
        await saveJar(paths.jar, jar);
        recordActObservation(runtime, "session", `session chain actor=${actor} x${results.length}`, {
          actor,
          steps: results,
          cookies: jar,
        });
        return jsonResult({
          ok: true,
          op,
          actor,
          steps: results,
          cookies: jar,
        });
      }

      if (op !== "request") {
        return textResult(
          "error: op must be request|chain|jar_get|jar_set|jar_clear|jar_copy|list_actors|compare|history",
        );
      }
      let jar = await loadJar(paths.jar);
      const one = await doRequest(runtime, {
        method: String(params.method || "GET"),
        url: String(params.url || ""),
        headers: params.headers,
        body: params.body != null ? String(params.body) : undefined,
        timeout_seconds: params.timeout_seconds,
        jar,
        actor,
      });
      if (!one.ok) return textResult(`error: ${one.error}`);
      jar = one.jar;
      await saveJar(paths.jar, jar);
      await appendHistory(paths.hist, histRow(actor, one));
      return jsonResult({
        ok: true,
        op: "request",
        actor,
        status: one.status,
        url: one.url,
        headers: one.headers,
        body: one.body_preview,
        truncated: one.truncated,
        set_cookie_keys: one.set_cookie_keys,
        cookies: jar,
      });
    },
  };
}

function sanitizeActor(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_").slice(0, 48);
  return s || "default";
}

function actorPaths(taskDir: string, actor: string): { dir: string; jar: string; hist: string } {
  // Keep default jar at session/cookies.json for backward compatibility.
  if (actor === "default") {
    const dir = join(taskDir, "session");
    return {
      dir,
      jar: join(dir, "cookies.json"),
      hist: join(dir, "history.jsonl"),
    };
  }
  const dir = join(taskDir, "session", "actors", actor);
  return {
    dir,
    jar: join(dir, "cookies.json"),
    hist: join(dir, "history.jsonl"),
  };
}

async function listActors(taskDir: string): Promise<string[]> {
  const names = new Set<string>(["default"]);
  try {
    await readFile(join(taskDir, "session", "cookies.json"), "utf8");
  } catch {
    /* default may be empty */
  }
  try {
    const entries = await readdir(join(taskDir, "session", "actors"), { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) names.add(e.name);
    }
  } catch {
    /* no actors yet */
  }
  return [...names].sort();
}

function histRow(
  actor: string,
  one: {
    method: string;
    url: string;
    status?: number;
    set_cookie_keys?: string[];
    body_preview?: string;
  },
): HistoryRow {
  return {
    actor,
    method: one.method,
    url: one.url,
    status: one.status || 0,
    set_cookie_keys: one.set_cookie_keys || [],
    body_preview: (one.body_preview || "").slice(0, 500),
    at: new Date().toISOString(),
  };
}

function summarizeSide(one: {
  ok: boolean;
  error?: string;
  status?: number;
  url?: string;
  body_preview?: string;
  set_cookie_keys?: string[];
}) {
  const body = one.body_preview || "";
  return {
    ok: one.ok,
    error: one.error,
    status: one.status,
    url: one.url,
    body_length: body.length,
    body_preview: body.slice(0, 400),
    set_cookie_keys: one.set_cookie_keys,
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
    actor: string;
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
}> {
  let url: string;
  try {
    url = resolveTargetUrl(runtime, input.url);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      method: input.method,
      url: input.url,
      jar: input.jar,
    };
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
    recordActObservation(
      runtime,
      "session",
      `${input.actor} ${method} ${url} → ${res.status}`,
      {
        actor: input.actor,
        method,
        url,
        status: res.status,
        headers: resHeaders,
        body_preview,
        set_cookie_keys: setKeys,
      },
    );
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
