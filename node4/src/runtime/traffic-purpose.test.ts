/**
 * Spec #413 L3 — traffic purpose classification (pure).
 * Run: npx tsx src/runtime/traffic-purpose.test.ts  (from node4/)
 */
import assert from "node:assert/strict";
import {
  classifyTrafficPurpose,
  hasProbePathShape,
  isTrafficPurpose,
  isWriteHttpMethod,
  normalizeTrafficPurpose,
  purposeMarksCaseTested,
  toolFamilyPurposeDefault,
} from "./traffic-purpose.js";

// --- enum helpers ---
{
  assert.equal(isTrafficPurpose("test"), true);
  assert.equal(isTrafficPurpose("BROWSE"), true);
  assert.equal(isTrafficPurpose("nope"), false);
  assert.equal(normalizeTrafficPurpose("Setup"), "setup");
  assert.equal(normalizeTrafficPurpose(""), null);
  assert.equal(purposeMarksCaseTested("test"), true);
  assert.equal(purposeMarksCaseTested("browse"), false);
  assert.equal(purposeMarksCaseTested("unknown"), false);
}

// --- tool family defaults ---
{
  assert.equal(toolFamilyPurposeDefault("shell"), "test");
  assert.equal(toolFamilyPurposeDefault("http"), "test");
  assert.equal(toolFamilyPurposeDefault("session"), "test");
  assert.equal(toolFamilyPurposeDefault("mitm"), "test");
  assert.equal(toolFamilyPurposeDefault("browser"), "browse");
  assert.equal(toolFamilyPurposeDefault("http", { is_target_seed: true }), "setup");
  assert.equal(toolFamilyPurposeDefault("target_seed"), "setup");
  assert.equal(toolFamilyPurposeDefault("other"), null);
}

// --- explicit wins ---
{
  assert.equal(
    classifyTrafficPurpose({
      purpose: "browse",
      source: "shell",
      method: "GET",
      url: "https://t.example/api",
    }),
    "browse",
    "explicit browse overrides shell default test",
  );
  assert.equal(
    classifyTrafficPurpose({
      purpose: "test",
      source: "browser",
      method: "GET",
      url: "https://t.example/",
    }),
    "test",
    "explicit test on browser nav",
  );
  assert.equal(
    classifyTrafficPurpose({
      purpose: "setup",
      source: "http",
      url: "https://t.example/",
    }),
    "setup",
  );
}

// --- shell/http GET → test ---
{
  assert.equal(
    classifyTrafficPurpose({
      source: "shell",
      method: "GET",
      url: "https://lab.example/login",
    }),
    "test",
  );
  assert.equal(
    classifyTrafficPurpose({
      source: "http",
      method: "GET",
      url: "https://lab.example/api/users",
    }),
    "test",
  );
}

// --- browser nav → browse ---
{
  assert.equal(
    classifyTrafficPurpose({
      source: "browser",
      method: "GET",
      url: "https://lab.example/index.html",
      browser_resource_class: "document",
    }),
    "browse",
  );
}

// --- seed → setup ---
{
  assert.equal(
    classifyTrafficPurpose({
      source: "http",
      url: "https://lab.example/",
      is_target_seed: true,
    }),
    "setup",
  );
}

// --- heuristics: garbage path → noise ---
{
  assert.equal(
    classifyTrafficPurpose({
      source: "shell",
      method: "GET",
      url: "https://lab.example/ftp/${pdf}",
    }),
    "noise",
  );
  assert.equal(
    classifyTrafficPurpose({
      source: "http",
      url: "https://lab.example/{{id}}/x",
    }),
    "noise",
  );
}

// --- heuristics: OOS → noise when scope gated ---
{
  assert.equal(
    classifyTrafficPurpose({
      source: "shell",
      method: "GET",
      url: "https://www.w3.org/TR/html",
      scope: { allowedHosts: new Set(["lab.example"]) },
    }),
    "noise",
  );
  assert.equal(
    classifyTrafficPurpose({
      source: "shell",
      method: "GET",
      url: "https://lab.example/ok",
      scope: { allowedHosts: new Set(["lab.example"]) },
    }),
    "test",
    "in-scope shell stays test",
  );
}

// --- heuristics: write methods / probe shapes → test (upgrade browse) ---
{
  assert.equal(isWriteHttpMethod("POST"), true);
  assert.equal(isWriteHttpMethod("get"), false);
  assert.equal(hasProbePathShape("https://x/etc/passwd"), true);
  assert.equal(hasProbePathShape("https://x/api/users"), false);
  assert.equal(
    classifyTrafficPurpose({
      source: "browser",
      method: "POST",
      url: "https://lab.example/login",
    }),
    "test",
    "browser POST upgrades to test",
  );
  assert.equal(
    classifyTrafficPurpose({
      source: "browser",
      method: "GET",
      url: "https://lab.example/..%2f..%2fetc/passwd",
    }),
    "test",
    "browser probe path upgrades to test",
  );
}

// --- unknown source without signals ---
{
  assert.equal(
    classifyTrafficPurpose({
      source: "other",
      method: "GET",
      url: "https://lab.example/",
    }),
    "unknown",
  );
}

console.log("traffic-purpose.test.ts: ok");
