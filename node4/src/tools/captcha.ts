/**
 * Captcha assist — fetch image with session actor cookies, optional OCR.
 * Does not solve challenges for the agent; removes environment friction.
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolRuntime } from "../types.js";
import { recordActObservation, isInScope, jsonResult, resolveTargetUrl, textResult } from "./common.js";

type JarMap = Record<string, string>;

export function createCaptchaTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "captcha",
    label: "Captcha",
    description: [
      "Assist captcha workflows without restricting the agent.",
      "Ops: fetch | ocr | info.",
      "fetch: download captcha image URL using a session actor cookie jar; saves under task captcha/.",
      "ocr: best-effort tesseract OCR if installed (may be wrong — verify in browser).",
      "Prefer: browser open captcha page → screenshot → captcha ocr, or fetch image URL with actor jar.",
      "For multi-identity: use different session actors (user_a / user_b / browser).",
    ].join(" "),
    parameters: Type.Object({
      op: Type.String(),
      url: Type.Optional(Type.String()),
      actor: Type.Optional(Type.String()),
      image_path: Type.Optional(Type.String()),
      /** Optional tesseract PSM (page segmentation mode), default 7 (single line). */
      psm: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: any) {
      const op = String(params.op || "info").trim().toLowerCase();
      const captchaDir = join(runtime.taskDir, "captcha");
      await mkdir(captchaDir, { recursive: true });

      if (op === "info") {
        const hasTess = await commandExists("tesseract");
        return jsonResult({
          ok: true,
          op: "info",
          tesseract_available: hasTess,
          guidance: hasTess
            ? "captcha(op=ocr, image_path=...) available. Always verify OCR against browser screenshot."
            : "tesseract not installed — use browser screenshot + manual/vision reasoning, or install tesseract-ocr.",
          actors_hint: "session(op=list_actors) then session(..., actor=user_a|user_b) for dual-identity tests",
        });
      }

      if (op === "fetch") {
        if (!params.url) return textResult("error: url required for fetch");
        let url: string;
        try {
          url = resolveTargetUrl(runtime, String(params.url));
        } catch (e) {
          return textResult(`error: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (!isInScope(runtime, url)) return textResult(`error: out of scope: ${url}`);
        const actor = sanitizeActor(params.actor != null ? String(params.actor) : "default");
        const jar = await loadActorJar(runtime.taskDir, actor);
        const headers: Record<string, string> = {};
        const cookie = formatCookieHeader(jar);
        if (cookie) headers.Cookie = cookie;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        try {
          const res = await fetch(url, { headers, signal: controller.signal, redirect: "follow" });
          const buf = Buffer.from(await res.arrayBuffer());
          const ct = res.headers.get("content-type") || "application/octet-stream";
          const ext = ct.includes("png")
            ? "png"
            : ct.includes("jpeg") || ct.includes("jpg")
              ? "jpg"
              : ct.includes("gif")
                ? "gif"
                : ct.includes("webp")
                  ? "webp"
                  : "bin";
          const image_path = join(captchaDir, `captcha_${actor}_${Date.now()}.${ext}`);
          await writeFile(image_path, buf);
          recordActObservation(runtime, "captcha", `captcha fetch ${url}`, {
            url,
            actor,
            status: res.status,
            content_type: ct,
            image_path,
            bytes: buf.length,
          });
          return jsonResult({
            ok: res.ok,
            op: "fetch",
            url,
            actor,
            status: res.status,
            content_type: ct,
            image_path,
            bytes: buf.length,
            next: "captcha(op=ocr, image_path=...) if tesseract available, or browser screenshot + reason",
          });
        } catch (e) {
          return textResult(`error: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          clearTimeout(timer);
        }
      }

      if (op === "ocr") {
        const image_path = String(params.image_path || "").trim();
        if (!image_path) return textResult("error: image_path required");
        // stay under taskDir when relative
        const full = image_path.startsWith("/")
          ? image_path
          : join(runtime.taskDir, image_path);
        try {
          await readFile(full);
        } catch {
          return textResult(`error: cannot read image_path: ${full}`);
        }
        if (!(await commandExists("tesseract"))) {
          return jsonResult({
            ok: false,
            op: "ocr",
            image_path: full,
            error: "tesseract not installed",
            guidance: "Install tesseract-ocr, or solve via browser UI / alternative captcha endpoints you discover.",
          });
        }
        const psm = Math.min(Math.max(Number(params.psm ?? 7), 0), 13);
        const ocr = await runTesseract(full, psm);
        recordActObservation(runtime, "captcha", `captcha ocr ${full}`, {
          image_path: full,
          text: ocr.text,
          raw: ocr.raw.slice(0, 2000),
        });
        return jsonResult({
          ok: true,
          op: "ocr",
          image_path: full,
          text: ocr.text,
          warning: "OCR is best-effort and often wrong on distorted captchas — verify before submit.",
        });
      }

      return textResult("error: op must be info|fetch|ocr");
    },
  };
}

function sanitizeActor(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_").slice(0, 48);
  return s || "default";
}

function formatCookieHeader(jar: JarMap): string {
  return Object.entries(jar)
    .filter(([k, v]) => k && v != null)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

async function loadActorJar(taskDir: string, actor: string): Promise<JarMap> {
  const paths = [
    join(taskDir, "session", "actors", actor, "cookies.json"),
    ...(actor === "default" ? [join(taskDir, "session", "cookies.json")] : []),
  ];
  for (const p of paths) {
    try {
      const raw = await readFile(p, "utf8");
      const o = JSON.parse(raw) as unknown;
      if (o && typeof o === "object" && !Array.isArray(o)) {
        const jar: JarMap = {};
        for (const [k, v] of Object.entries(o as Record<string, unknown>)) jar[String(k)] = String(v);
        return jar;
      }
    } catch {
      /* try next */
    }
  }
  return {};
}

function commandExists(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", `command -v ${bin}`], { stdio: ["ignore", "pipe", "ignore"] });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function runTesseract(imagePath: string, psm: number): Promise<{ text: string; raw: string }> {
  return new Promise((resolve) => {
    const child = spawn("tesseract", [imagePath, "stdout", "--psm", String(psm)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve({ text: "", raw: stderr || "timeout" });
    }, 30_000);
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ text: "", raw: e instanceof Error ? e.message : String(e) });
    });
    child.on("close", () => {
      clearTimeout(timer);
      const text = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      resolve({ text, raw: stdout + stderr });
    });
  });
}
