/**
 * Chinese tool labels for chat chrome.
 * Run: npx tsx src/lib/toolLabels.test.ts  (from platform/frontend)
 */
import assert from "node:assert/strict";
import { friendlyToolLabel } from "./toolLabels.ts";

assert.equal(friendlyToolLabel("platform_create_report"), "生成交付报告");
assert.equal(friendlyToolLabel("shell"), "执行命令");
assert.equal(friendlyToolLabel("http"), "HTTP 探测");
assert.equal(friendlyToolLabel("todo"), "更新任务清单");
assert.equal(friendlyToolLabel(""), "工具");
assert.equal(friendlyToolLabel("platform_list_assets"), "查询资产台账");
assert.ok(friendlyToolLabel("platform_unknown_thing").startsWith("平台："));
console.log("ok: friendlyToolLabel Chinese map");
console.log("toolLabels.test.ts: all ok");
