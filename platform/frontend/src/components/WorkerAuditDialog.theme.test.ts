/**
 * Spec #491: Worker audit CTA contrast + Status close-out card gone.
 * Run: npx tsx src/components/WorkerAuditDialog.theme.test.ts  (from platform/frontend)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

{
  const src = readFileSync(join(here, "WorkerAuditDialog.tsx"), "utf8");
  assert.match(
    src,
    /bg-ink[^"\n]*text-on-ink/,
    "Worker rename 保存 must use text-on-ink (dark mode ink is near-white)",
  );
  assert.equal(
    /bg-ink[^"\n]*text-white/.test(src),
    false,
    "must not hardcode text-white on bg-ink",
  );
  console.log("ok: WorkerAuditDialog ink CTA uses text-on-ink");
}

{
  const src = readFileSync(join(here, "RightPanel.tsx"), "utf8");
  assert.equal(
    /EngagementCloseoutCard/.test(src),
    false,
    "Status tab must not render EngagementCloseoutCard (#491)",
  );
  console.log("ok: RightPanel has no Status close-out card");
}
