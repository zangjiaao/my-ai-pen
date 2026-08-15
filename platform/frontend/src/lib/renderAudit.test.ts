/**
 * Typed input must not increment chrome that does not depend on the field.
 * Run: npx tsx src/lib/renderAudit.test.ts  (from platform/frontend)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  beginTypedInput,
  finishTypedInput,
  recordRender,
  report,
  resetRenderAudit,
} from "./renderAudit.ts";

const here = dirname(fileURLToPath(import.meta.url));
const frontendSrc = join(here, "..");

function src(rel: string): string {
  return readFileSync(join(frontendSrc, rel), "utf8");
}

{
  resetRenderAudit();
  recordRender("ConversationPage");
  recordRender("MessageRenderer");
  recordRender("ChatComposer");
  beginTypedInput("ChatComposer");
  recordRender("ChatComposer");
  const flag = finishTypedInput();
  assert.equal(flag, null, "isolated composer increment is not a leak");
  assert.equal(report().flags.length, 0);
  console.log("ok: isolated ChatComposer render is clean");
}

{
  resetRenderAudit();
  recordRender("ConversationPage");
  beginTypedInput("ChatComposer");
  recordRender("ChatComposer");
  recordRender("ConversationPage");
  recordRender("MessageRenderer");
  recordRender("MessageRenderer");
  recordRender("RightPanel");
  const flag = finishTypedInput();
  assert.ok(flag, "composer must flag Case stream chrome");
  assert.equal(flag?.reason, "typed-input");
  assert.equal(flag?.owner, "ChatComposer");
  assert.equal(flag?.delta.ConversationPage, 1);
  assert.equal(flag?.delta.MessageRenderer, 2);
  assert.equal(flag?.delta.RightPanel, 1);
  assert.equal(flag?.delta.ChatComposer, undefined);
  console.log("ok: leaked ConversationPage/MessageRenderer/RightPanel is flagged");
}

{
  resetRenderAudit();
  recordRender("AssetPage");
  recordRender("Sidebar");
  beginTypedInput("AssetPage.search", { allow: ["AssetPage"] });
  recordRender("AssetPage");
  recordRender("Sidebar");
  recordRender("TopBar");
  const flag = finishTypedInput();
  assert.ok(flag, "page search may update the page; chrome still leaks");
  assert.equal(flag?.owner, "AssetPage.search");
  assert.equal(flag?.delta.AssetPage, undefined, "owner page is allowed to filter");
  assert.equal(flag?.delta.Sidebar, 1);
  assert.equal(flag?.delta.TopBar, 1);
  console.log("ok: filter input allows the page, still flags Sidebar/TopBar");
}

{
  resetRenderAudit();
  recordRender("SurfaceTreeView");
  recordRender("RightPanel");
  beginTypedInput("SurfaceTreeView");
  recordRender("SurfaceTreeView");
  const flag = finishTypedInput();
  assert.equal(flag, null, "isolated widget search is clean when parent stays still");
  console.log("ok: isolated SurfaceTreeView search is clean");
}

{
  resetRenderAudit();
  recordRender("ConversationPage");
  const flag = finishTypedInput();
  assert.equal(flag, null, "imperative setValue / non-keystroke must not flag");
  console.log("ok: finish without beginTypedInput is ignored");
}

{
  const watched: Array<[string, string]> = [
    ["pages/ConversationPage.tsx", 'useRenderAudit("ConversationPage")'],
    ["pages/AssetPage.tsx", 'useRenderAudit("AssetPage")'],
    ["pages/VulnerabilityPage.tsx", 'useRenderAudit("VulnerabilityPage")'],
    ["pages/ExpertPage.tsx", 'useRenderAudit("ExpertPage")'],
    ["pages/NodePage.tsx", 'useRenderAudit("NodePage")'],
    ["pages/SchedulesPage.tsx", 'useRenderAudit("SchedulesPage")'],
    ["pages/AuditPage.tsx", 'useRenderAudit("AuditPage")'],
    ["pages/DashboardPage.tsx", 'useRenderAudit("DashboardPage")'],
    ["pages/LoginPage.tsx", 'useRenderAudit("LoginPage")'],
    ["components/ChatComposer.tsx", 'useRenderAudit("ChatComposer")'],
    ["components/MessageRenderer.tsx", 'useRenderAudit("MessageRenderer")'],
    ["components/MarkdownText.tsx", 'useRenderAudit("MarkdownText")'],
    ["components/RightPanel.tsx", 'useRenderAudit("RightPanel")'],
    ["components/Sidebar.tsx", 'useRenderAudit("Sidebar")'],
    ["components/TopBar.tsx", 'useRenderAudit("TopBar")'],
    ["components/SurfaceTreeView.tsx", 'useRenderAudit("SurfaceTreeView")'],
  ];
  for (const [file, needle] of watched) {
    assert.match(src(file), new RegExp(needle.replace(/[()]/g, "\\$&")), `${file} must call ${needle}`);
  }
  assert.match(src("App.tsx"), /RenderAuditBadge/);
  assert.match(src("components/ChatComposer.tsx"), /commitTypedInput\("ChatComposer"/);
  assert.equal(/useTypedInputAudit/.test(src("lib/renderAudit.ts")), false);
  console.log("ok: watched surfaces call useRenderAudit");
}

{
  assert.match(src("components/MessageRenderer.tsx"), /export default memo\(MessageRenderer\)/);
  assert.match(src("components/MarkdownText.tsx"), /export default memo\(MarkdownText\)/);
  assert.match(src("components/Sidebar.tsx"), /export default memo\(Sidebar\)/);
  assert.match(src("components/TopBar.tsx"), /export default memo\(TopBar\)/);
  console.log("ok: stream + chrome stay memoized");
}

resetRenderAudit();
console.log("renderAudit.test.ts: all ok");
