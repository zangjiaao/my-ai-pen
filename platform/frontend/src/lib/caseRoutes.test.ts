/**
 * Case URL helpers.
 * Run: npx tsx src/lib/caseRoutes.test.ts
 */
import assert from "node:assert/strict";
import {
  HOME_CHAT_PATH,
  caseIdFromPathname,
  casePath,
  isCaseId,
  isConversationSurfacePath,
} from "./caseRoutes.ts";

const UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

assert.equal(HOME_CHAT_PATH, "/");
assert.equal(casePath(UUID), `/${UUID}`);
assert.equal(casePath(`  ${UUID}  `), `/${UUID}`);

assert.equal(isCaseId(UUID), true);
assert.equal(isCaseId(UUID.toUpperCase()), true);
assert.equal(isCaseId("not-a-uuid"), false);
assert.equal(isCaseId("dashboard"), false);
assert.equal(isCaseId(""), false);
assert.equal(isCaseId(null), false);

assert.equal(isConversationSurfacePath("/"), true);
assert.equal(isConversationSurfacePath(`/${UUID}`), true);
assert.equal(isConversationSurfacePath("/dashboard"), false);
assert.equal(isConversationSurfacePath("/assets"), false);
assert.equal(isConversationSurfacePath("/case/foo"), false);

assert.equal(caseIdFromPathname(`/${UUID}`), UUID);
assert.equal(caseIdFromPathname("/"), null);
assert.equal(caseIdFromPathname("/dashboard"), null);
assert.equal(caseIdFromPathname("/foo/bar"), null);

console.log("caseRoutes.test.ts: ok");
