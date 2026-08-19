/**
 * Spec #490: composer Enter submits; IME confirm / Shift+Enter / ⌘·Ctrl+Enter must not.
 * Run: npx tsx src/components/ChatComposer.submitKey.test.ts  (from platform/frontend)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  insertComposerNewlineAtCaret,
  shouldInsertComposerNewline,
  shouldSubmitComposerOnEnter,
} from "./ChatComposer.tsx";

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
    shouldSubmitComposerOnEnter({ key: "Enter", shiftKey: false, metaKey: true }),
    false,
    "⌘+Enter must not send",
  );
  assert.equal(
    shouldSubmitComposerOnEnter({ key: "Enter", shiftKey: false, ctrlKey: true }),
    false,
    "Ctrl+Enter must not send",
  );
  assert.equal(
    shouldSubmitComposerOnEnter({ key: "a", shiftKey: false }),
    false,
    "non-Enter keys never submit",
  );
  console.log("ok: shouldSubmitComposerOnEnter");
}

{
  assert.equal(
    shouldInsertComposerNewline({ key: "Enter", shiftKey: false, metaKey: true }),
    true,
    "⌘+Enter inserts newline",
  );
  assert.equal(
    shouldInsertComposerNewline({ key: "Enter", shiftKey: false, ctrlKey: true }),
    true,
    "Ctrl+Enter inserts newline",
  );
  assert.equal(
    shouldInsertComposerNewline({ key: "Enter", shiftKey: true }),
    false,
    "Shift+Enter stays native textarea newline",
  );
  assert.equal(
    shouldInsertComposerNewline({ key: "Enter", shiftKey: false }),
    false,
    "plain Enter does not insert via modifier path",
  );
  assert.equal(
    shouldInsertComposerNewline({ key: "Enter", shiftKey: false, metaKey: true, isComposing: true }),
    false,
    "⌘+Enter during IME must not insert",
  );
  assert.equal(
    insertComposerNewlineAtCaret("ab", 1, 1).next,
    "a\nb",
  );
  assert.equal(insertComposerNewlineAtCaret("ab", 1, 1).caret, 2);
  console.log("ok: shouldInsertComposerNewline");
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
    /shouldInsertComposerNewline\(keyEvent, composing\)/,
    "textarea onKeyDown must insert newline on ⌘/Ctrl+Enter",
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
