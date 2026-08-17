/**
 * Spec #474 S2: Case-open restore adapter (source contract).
 * Run: npx tsx src/pages/ConversationPage.composerRestore.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pageSrc = readFileSync(join(here, "ConversationPage.tsx"), "utf8");

assert.match(
  pageSrc,
  /from "\.\.\/lib\/composerCaseRestore"/,
  "ConversationPage must use the S1 restore helper",
);
assert.match(
  pageSrc,
  /applyComposerRestoreFromSnapshot\(id, state\)/,
  "Case load must restore composer from the snapshot",
);
assert.match(
  pageSrc,
  /resetComposerChips\(\)/,
  "Case open / blank home must reset composer chips before restore",
);

assert.equal(
  /applyComposerRestoreFromSnapshot\(id, fallbackState\)/.test(pageSrc),
  false,
  "non-404 /state failure must not restore from empty archaeology",
);

const refreshFn = pageSrc.slice(
  pageSrc.indexOf("const refreshConversationState"),
  pageSrc.indexOf("const setConversationMessageData"),
);
assert.match(
  refreshFn,
  /if \(composerRestoreCaseIdRef\.current !== id\) \{\s*applyComposerRestoreFromSnapshot\(id, state\);/,
  "heartbeat may complete a still-pending once-on-open restore",
);
assert.equal(
  refreshFn.includes("applyComposerRestoreFromSnapshot(id, state)") &&
    refreshFn.includes("composerRestoreCaseIdRef.current !== id"),
  true,
  "heartbeat restore stays gated on pending once-on-open (#474 L6 / #278 D3)",
);

assert.match(
  pageSrc,
  /composerRestoreCaseIdRef\.current = convId/,
  "first-send mint must keep send-time chips (do not S1-overwrite empty new Case)",
);
assert.match(
  pageSrc,
  /if \(activeId && composerRestoreCaseIdRef\.current !== activeId\) return;/,
  "#299 default must wait while Case restore is pending",
);

console.log("ok: ConversationPage.composerRestore.test.ts");
