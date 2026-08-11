/**
 * Spec #330: browser sandbox image is explicit env only; no Strix fallback.
 * Run: npx tsx src/runtime/browser-image.test.ts
 */
import {
  BrowserSandboxImageError,
  resolveBrowserSandboxImage,
} from "./browser-sandbox.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function clearBrowserImageEnv(): void {
  delete process.env.PEN_SANDBOX_IMAGE;
  delete process.env.PEN_TOOLS_IMAGE;
  delete process.env.NODE4_BROWSER_SANDBOX_IMAGE;
  delete process.env.NODE2_BROWSER_SANDBOX_IMAGE;
}

const saved = { ...process.env };
try {
  // --- missing env → hard failure (no ambient discovery, no Strix) ---
  clearBrowserImageEnv();
  let threw: unknown;
  try {
    resolveBrowserSandboxImage();
  } catch (e) {
    threw = e;
  }
  assert(threw instanceof BrowserSandboxImageError, "missing env throws BrowserSandboxImageError");
  const msg = threw instanceof Error ? threw.message : String(threw);
  assert(/PEN_SANDBOX_IMAGE|NODE4_BROWSER_SANDBOX_IMAGE/i.test(msg), "error names required env");
  assert(!/strix/i.test(msg) || /not used|no.*strix|without strix/i.test(msg), "error must not advertise Strix as default");
  assert(!/ghcr\.io\/usestrix/i.test(msg), "error must not suggest Strix image ref");

  // --- explicit browser override wins ---
  clearBrowserImageEnv();
  process.env.NODE4_BROWSER_SANDBOX_IMAGE = "my-custom:browser";
  assert(resolveBrowserSandboxImage() === "my-custom:browser", "NODE4_BROWSER_SANDBOX_IMAGE wins");

  // --- unified pen-sandbox pin ---
  clearBrowserImageEnv();
  process.env.PEN_SANDBOX_IMAGE = "registry.example/pen-sandbox:1.2.3";
  assert(
    resolveBrowserSandboxImage() === "registry.example/pen-sandbox:1.2.3",
    "PEN_SANDBOX_IMAGE is accepted",
  );

  // --- browser override beats unified ---
  clearBrowserImageEnv();
  process.env.PEN_SANDBOX_IMAGE = "pen-sandbox:unified";
  process.env.NODE4_BROWSER_SANDBOX_IMAGE = "pen-sandbox:browser-pin";
  assert(
    resolveBrowserSandboxImage() === "pen-sandbox:browser-pin",
    "browser override beats PEN_SANDBOX_IMAGE",
  );

  // --- no env → throw (no ambient discovery, never a Strix constant) ---
  clearBrowserImageEnv();
  try {
    resolveBrowserSandboxImage();
    assert(false, "expected throw when no explicit env");
  } catch (e) {
    assert(e instanceof BrowserSandboxImageError, "no ambient discovery path");
  }

  // whitespace-only env is not a pin
  clearBrowserImageEnv();
  process.env.PEN_SANDBOX_IMAGE = "   ";
  try {
    resolveBrowserSandboxImage();
    assert(false, "whitespace-only env must fail");
  } catch (e) {
    assert(e instanceof BrowserSandboxImageError, "whitespace throws");
  }

  console.log(JSON.stringify({ ok: true, cases: "explicit / missing / no-strix" }, null, 2));
  console.log("RESULT: PASS — browser image resolution (#330)");
} finally {
  for (const k of Object.keys(process.env)) {
    if (!(k in saved)) delete process.env[k];
  }
  Object.assign(process.env, saved);
}
