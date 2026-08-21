/**
 * Composer textarea sizes like a growing prompt bar: min → content → compact max,
 * then native overflow. Visible text (no highlight overlay).
 * Run: npx tsx src/components/ChatComposer.textareaLayout.test.ts  (from platform/frontend)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPOSER_TEXTAREA_MAX_PX,
  COMPOSER_TEXTAREA_MIN_PX,
  composerTextareaLayout,
} from "./ChatComposer.tsx";

{
  assert.equal(composerTextareaLayout(20).heightPx, COMPOSER_TEXTAREA_MIN_PX);
  assert.equal(composerTextareaLayout(20).overflowY, "hidden");
  assert.equal(composerTextareaLayout(COMPOSER_TEXTAREA_MIN_PX).heightPx, COMPOSER_TEXTAREA_MIN_PX);
  assert.equal(composerTextareaLayout(COMPOSER_TEXTAREA_MIN_PX + 40).overflowY, "hidden");
  assert.equal(composerTextareaLayout(COMPOSER_TEXTAREA_MAX_PX).heightPx, COMPOSER_TEXTAREA_MAX_PX);
  assert.equal(composerTextareaLayout(COMPOSER_TEXTAREA_MAX_PX).overflowY, "hidden");
  assert.equal(composerTextareaLayout(COMPOSER_TEXTAREA_MAX_PX + 40).heightPx, COMPOSER_TEXTAREA_MAX_PX);
  assert.equal(composerTextareaLayout(COMPOSER_TEXTAREA_MAX_PX + 40).overflowY, "auto");
  console.log("ok: composerTextareaLayout min/max/overflow");
}

{
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "ChatComposer.tsx"), "utf8");
  assert.match(
    src,
    /applyComposerTextareaLayout\(el\)/,
    "textarea must auto-size from scrollHeight after draft changes",
  );
  assert.match(
    src,
    /text-ink caret-ink/,
    "textarea text must be visible (no transparent overlay)",
  );
  assert.equal(
    /text-transparent/.test(src),
    false,
    "transparent textarea + highlight overlay is the 4-line blank-caret bug",
  );
  console.log("ok: ChatComposer wires growing visible textarea");
}
