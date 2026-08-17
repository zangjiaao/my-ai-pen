/**
 * Attack-surface host parse — paths are not hosts (Spec workset emit).
 * Run: npx tsx src/runtime/attack-surface.test.ts
 */
import assert from "node:assert/strict";
import { buildAttackSurfaceCandidates, parseHostPort } from "./attack-surface.js";

const task = {
  target: { type: "url", value: "http://host.docker.internal:8080" },
  scope: { allow: ["http://host.docker.internal:8080"] },
};

{
  const cands = buildAttackSurfaceCandidates({
    task,
    locationStrings: [
      "/login.php (dvwaLogin 无 session_regenerate_id)",
      "cmd.png",
      "medium.php",
      "http://host.docker.internal:8080/vulnerabilities/upload/",
      "https://oos.lab.example/x",
    ],
  });
  assert.ok(
    !cands.some((c) => c.host === "login.php" || c.host === "cmd.png" || c.host === "medium.php"),
    "path / file-ext locations are not hosts",
  );
  assert.ok(
    cands.some((c) => c.host === "host.docker.internal" && c.in_scope),
    "real URL host stays in-scope",
  );
  assert.ok(
    cands.some((c) => c.host === "oos.lab.example" && !c.in_scope),
    "foreign URL host is out-of-scope candidate",
  );
  console.log("ok path locations do not become hosts");
}

{
  assert.equal(parseHostPort("secrets.env").host, "");
  assert.equal(parseHostPort("backup.bak").host, "");
  assert.equal(parseHostPort("http://host.docker.internal:8080/x").host, "host.docker.internal");
  console.log("ok finding and surface share the same host-parse filter");
}

console.log("attack-surface.test.ts ok");
