/**
 * Spec #490: composer Enter submits; IME confirm / Shift+Enter must not.
 * Run: npx tsx src/components/ChatComposer.submitKey.test.ts  (from platform/frontend)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shouldSubmitComposerOnEnter } from "./ChatComposer.tsx";

{
  assert.equal(
    shouldSubmitComposerOnEnter({ key: "Enter", shiftKey: false }),
    true,
    "plain Enter sends",
  );
  assert.equal(
    shouldSubmitComposerOnEnter({ key: "Enter", shiftKey: false, isComposing: false }),
    true,
    "Enter after IME settled sends",
  );
  assert.equal(
    shouldSubmitComposerOnEnter({ key: "Enter", shiftKey: false, isComposing: true }),
    false,
    "Enter while isComposing is IME confirm",
  );
  assert.equal(
    shouldSubmitComposerOnEnter({ key: "Enter", shiftKey: false, keyCode: 229 }),
    false,
    "Enter with IME keyCode 229 must not send",
  );
  assert.equal(
    shouldSubmitComposerOnEnter({ key: "Enter", shiftKey: false }, true),
    false,
    "Enter during composition-session flag must not send",
  );
  assert.equal(
    shouldSubmitComposerOnEnter({ key: "Enter", shiftKey: true }),
    false,
    "Shift+Enter newlines",
  );
  assert.equal(
    shouldSubmitComposerOnEnter({ key: "a", shiftKey: false }),
    false,
    "non-Enter keys never submit",
  );
  console.log("ok: shouldSubmitComposerOnEnter");
}

{
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "ChatComposer.tsx"), "utf8");
  assert.match(
    src,
    /onKeyDown=\{\(e\) => \{[\s\S]*shouldSubmitComposerOnEnter\(/,
    "textarea onKeyDown must gate submit through shouldSubmitComposerOnEnter",
  );
  assert.match(
    src,
    /onCompositionStart=\{beginImeComposition\}/,
    "textarea must track compositionstart for IME Enter-after-end races",
  );
  assert.match(
    src,
    /onCompositionEnd=\{endImeCompositionSoon\}/,
    "textarea must delay clearing composing until after a same-turn confirming Enter",
  );
  console.log("ok: ChatComposer wires IME-safe Enter");
}
