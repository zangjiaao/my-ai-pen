import assert from "node:assert/strict";
import {
  classifyEvidenceRole,
  evidencePropertiesForPlatform,
  extractObservationHighlight,
  isPlausiblePathHint,
  looksLikeMaterialPath,
  pathHintFromCommand,
  pathHintFromStdout,
} from "./common.js";

const httpProps = evidencePropertiesForPlatform("http", {
  method: "GET",
  url: "http://lab/backup/app.tar.gz",
  status: 200,
  body_preview: "PK\x03\x04 leaked archive bytes here for proof",
});
assert.equal(httpProps.kind, "http");
assert.equal(httpProps.role, "proof");
assert.ok(String(httpProps.excerpt || "").includes("leaked archive"));
assert.equal(httpProps.path_or_url, "http://lab/backup/app.tar.gz");

// Empty body HTTP → trace (status line still in excerpt for UI)
const emptyHttp = evidencePropertiesForPlatform("http", {
  method: "GET",
  url: "http://lab/",
  status: 302,
  body_preview: "",
  headers: { location: "/login.php" },
});
// with Location header → still proof
assert.equal(emptyHttp.role, "proof");

const emptyHttpNoLoc = evidencePropertiesForPlatform("http", {
  method: "GET",
  url: "http://lab/",
  status: 200,
  body_preview: "",
});
assert.equal(emptyHttpNoLoc.role, "trace");
assert.ok(String(emptyHttpNoLoc.excerpt || "").includes("http://lab/"));

const shellProps = evidencePropertiesForPlatform("shell", {
  command: "cat notes/source_dump/app.py",
  exitCode: 0,
  stdout: "def vuln():\n  eval(request.args['q'])\n",
  stderr: "",
});
assert.equal(shellProps.kind, "source_excerpt");
assert.equal(shellProps.role, "proof");
assert.ok(String(shellProps.path || "").includes("source_dump"));
assert.ok(String(shellProps.excerpt || "").includes("eval"));

// Agent probe script must NOT look like target source material
const probe = evidencePropertiesForPlatform("script", {
  file: "/tmp/task/scripts/stored_xss_probe.py",
  command: "python3 scripts/stored_xss_probe.py",
  exitCode: 0,
  stdout: [
    "=== Stored XSS - DVWA /vulnerabilities/xss_s/ ===",
    "",
    "[Step 1] Submitting XSS payload to guestbook...",
    "[CONFIRMED] Stored XSS - payload reflected in response!",
    "Context: ...Name: pentest_user<br />Message: <script>alert(document.cookie)</script><br /></div>",
    "",
    "[Step 2] Reloading page to verify persistence...",
    "[CONFIRMED] Stored XSS is PERSISTENT across page reloads!",
  ].join("\n"),
});
assert.equal(probe.kind, "shell", "probe scripts are process evidence, not source_excerpt");
assert.ok(String(probe.observation || "").includes("CONFIRMED"), "observation highlight");
assert.ok(String(probe.excerpt || "").includes("script>alert"), "excerpt shows proving payload fragment");
assert.ok(!String(probe.excerpt || "").startsWith("status/exit"), "excerpt must not lead with process metadata");
assert.ok(!looksLikeMaterialPath("scripts/stored_xss_probe.py"));
assert.ok(looksLikeMaterialPath("notes/source_dump/sqli/index.php"));

const obs = extractObservationHighlight(
  "=== banner ===\n[*] login ok\n[CONFIRMED] reflected\nContext: <script>x</script>\n",
);
assert.ok(obs.includes("CONFIRMED") && obs.includes("<script>"));

const noise = evidencePropertiesForPlatform("shell", {
  command: "ls",
  exitCode: 0,
  stdout: "total 0",
  stderr: "",
});
assert.equal(noise.role, "trace");

// Regex garbage must NOT become path_or_url
const regexShell = evidencePropertiesForPlatform("shell", {
  command: "python3 -c \"import re; re.search(r').*?(?=</pre>)', x)\"",
  exitCode: 0,
  stdout: "matched First name admin",
  stderr: "",
});
assert.ok(
  !String(regexShell.path_or_url || "").includes(".*"),
  `path should not be regex: ${regexShell.path_or_url}`,
);

const fileProps = evidencePropertiesForPlatform("write", {
  kind: "source_excerpt",
  path: "notes/source_dump/Main.java",
  preview: "public class Main {}",
  hash: "sha256:abcd",
});
assert.equal(fileProps.kind, "source_excerpt");
assert.equal(fileProps.role, "proof");
assert.equal(fileProps.path_or_url, "notes/source_dump/Main.java");

// Browser maps snapshot → excerpt
const browser = evidencePropertiesForPlatform("browser", {
  url: "http://lab/xss",
  snapshot: "html body with script and form fields enough text for proof material",
});
assert.equal(browser.role, "proof");
assert.ok(String(browser.excerpt || "").includes("script"));

const browserEmpty = evidencePropertiesForPlatform("browser", {
  url: "http://lab/xss",
  snapshot: "",
});
assert.equal(browserEmpty.role, "trace");

assert.equal(pathHintFromCommand("cat /tmp/x.py && echo ok"), "/tmp/x.py");
assert.equal(pathHintFromCommand("cat notes/source_dump/sqli_source.html"), "notes/source_dump/sqli_source.html");
assert.ok(!pathHintFromCommand("re.search(r').*?(?=</pre>)', html)"));
assert.ok(isPlausiblePathHint("notes/source_dump/a.php"));
assert.ok(!isPlausiblePathHint(").*?(?=</pre>)"));
assert.equal(pathHintFromStdout("wrote notes/source_dump/sqli_source.html ok"), "notes/source_dump/sqli_source.html");
assert.equal(classifyEvidenceRole("todo", {}), "trace");

console.log("common.evidence.test.ts ok");
