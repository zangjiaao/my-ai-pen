/**
 * Long-Case composer typing must not live on ConversationPage state.
 * A page-level `input` re-renders the whole message list + RightPanel on every keystroke.
 * Run: npx tsx src/pages/ConversationPage.composerIsolation.test.ts  (from platform/frontend)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pageSrc = readFileSync(join(here, "ConversationPage.tsx"), "utf8");

assert.equal(
  /const \[input,\s*setInput\]/.test(pageSrc),
  false,
  "ConversationPage must not own composer draft state (setInput on each keystroke re-renders the Case stream)",
);
assert.match(
  pageSrc,
  /ChatComposer/,
  "composer UI must be the isolated ChatComposer child",
);
assert.match(
  pageSrc,
  /SessionDemandQueue/,
  "queued user text must render as list-tail chrome, not composer draft",
);

console.log("ok: ConversationPage composer input is isolated");
