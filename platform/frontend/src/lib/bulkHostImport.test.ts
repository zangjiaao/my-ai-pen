import assert from "node:assert/strict";
import { parseBulkHostCsv, summarizeBulkGroups } from "./bulkHostImport.js";

{
  const r = parseBulkHostCsv(`
# comment
address,port,protocol,name
10.0.0.1,80,tcp,http
10.0.0.1,443,tcp,https
pay.example.com,8080,http
10.0.0.2
`);
  assert.equal(r.groups.length, 3);
  assert.equal(r.groups[0]!.address, "10.0.0.1");
  assert.deepEqual(
    r.groups[0]!.services.map((s) => s.port),
    ["80", "443"],
  );
  assert.equal(r.groups[0]!.services[0]!.protocol, "tcp");
  assert.equal(r.groups[0]!.services[0]!.name, "http");
  assert.equal(r.groups[1]!.services[0]!.port, "8080");
  // "http" alone in protocol col with no name → treated as service name when not L4-only
  // Actually http is in KNOWN_PROTO so it stays protocol
  assert.equal(r.groups[1]!.services[0]!.protocol, "http");
  assert.equal(r.groups[2]!.services.length, 0);
  assert.ok(summarizeBulkGroups(r.groups).includes("3 台主机"));
}

{
  const r = parseBulkHostCsv(`
10.0.0.8:3000
10.0.0.8,22/tcp,ssh
`);
  assert.equal(r.groups.length, 1);
  const ports = r.groups[0]!.services.map((s) => s.port).sort();
  assert.deepEqual(ports, ["22", "3000"]);
  const ssh = r.groups[0]!.services.find((s) => s.port === "22");
  assert.equal(ssh?.protocol, "tcp");
  assert.equal(ssh?.name, "ssh");
}

{
  const r = parseBulkHostCsv(`
address,port,protocol,name,tags
10.1.1.1,443,tcp,https,"prod,web"
`);
  assert.equal(r.groups[0]!.tags.includes("prod"), true);
  assert.equal(r.groups[0]!.services[0]!.name, "https");
}

console.log("bulkHostImport.test.ts: ok");
