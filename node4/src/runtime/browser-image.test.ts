/**
 * Run: npx tsx src/runtime/browser-image.test.ts
 */
import { resolveBrowserSandboxImage } from "./browser-sandbox.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const saved = { ...process.env };
try {
  delete process.env.NODE4_BROWSER_SANDBOX_IMAGE;
  delete process.env.NODE2_BROWSER_SANDBOX_IMAGE;
  const img = resolveBrowserSandboxImage();
  assert(
    img === "pen-browser:dev" ||
      img === "pen-browser:0.1.0" ||
      img.includes("strix-sandbox"),
    `unexpected default image: ${img}`,
  );

  process.env.NODE4_BROWSER_SANDBOX_IMAGE = "my-custom:browser";
  assert(resolveBrowserSandboxImage() === "my-custom:browser", "explicit wins");

  console.log(JSON.stringify({ ok: true, defaultOrResolved: img }, null, 2));
  console.log("RESULT: PASS — browser image resolution");
} finally {
  for (const k of Object.keys(process.env)) {
    if (!(k in saved)) delete process.env[k];
  }
  Object.assign(process.env, saved);
}
