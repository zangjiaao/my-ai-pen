/**
 * toolUserFacingDetail — every tool should show user-meaningful intent.
 * Run: npx tsx src/lib/toolDetail.test.ts
 */
import assert from "node:assert/strict";
import {
  formatSurfaceToolDetail,
  formatToolArgsDetail,
  isJsonBlobText,
  isLifecycleOnlyText,
  toolFamilyFromName,
  toolFamilyKey,
  toolUserFacingDetail,
} from "./toolDetail.ts";
import { formatToolResultDrawerBody } from "./toolResultDrawer.ts";
import { groupConsecutiveToolMessages } from "./conversationMessageMerge.ts";
import type { Message } from "./types.ts";

{
  assert.equal(isLifecycleOnlyText("interrupted"), true);
  assert.equal(isLifecycleOnlyText("shell running"), true);
  assert.equal(isLifecycleOnlyText("失败"), true);
  assert.equal(isLifecycleOnlyText("nmap -sV x"), false);
}

{
  const shell = toolUserFacingDetail({
    toolId: "shell",
    toolName: "执行命令",
    args: { command: "nmap -sV 10.0.0.1" },
    summary: "interrupted",
  });
  assert.equal(shell.text, "nmap -sV 10.0.0.1");
  assert.equal(shell.mono, true);
}

{
  const http = toolUserFacingDetail({
    toolId: "http",
    args: { method: "POST", url: "https://example.com/login" },
  });
  assert.equal(http.text, "POST https://example.com/login");
  assert.equal(http.mono, true);
}

{
  const browser = toolUserFacingDetail({
    toolId: "browser",
    args: { action: "open", url: "https://app.test/" },
  });
  assert.equal(browser.text, "open https://app.test/");
}

{
  const read = toolUserFacingDetail({
    toolId: "read",
    args: { path: "scripts/poc.py" },
  });
  assert.equal(read.text, "scripts/poc.py");
  assert.equal(read.mono, true);
}

{
  const skill = toolUserFacingDetail({
    toolId: "skill",
    args: { op: "load", id: "sqli-manual" },
  });
  assert.equal(skill.text, "load sqli-manual");
}

{
  const finding = toolUserFacingDetail({
    toolId: "finding",
    args: { action: "confirm", title: "SQL injection", location: "/api/x" },
  });
  assert.match(finding.text, /confirm/);
  assert.match(finding.text, /SQL injection/);
}

{
  const todo = toolUserFacingDetail({
    toolId: "todo",
    args: { op: "start", task: "Enumerate login endpoints" },
  });
  assert.match(todo.text, /start/);
  assert.match(todo.text, /Enumerate login endpoints/);
}

{
  const sub = toolUserFacingDetail({
    toolId: "subagent",
    args: { this_turn_goal: "Probe /admin for IDOR" },
  });
  assert.match(sub.text, /Probe \/admin/);
}

{
  const platform = toolUserFacingDetail({
    toolId: "platform_get_vulnerability",
    args: { vulnerability_id: "vuln-abc" },
  });
  assert.match(platform.text, /vuln-abc/);
}

{
  // Lifecycle-only summary must not become the chip when args exist.
  const stuck = toolUserFacingDetail({
    toolId: "browser",
    summary: "browser running",
    args: { action: "snapshot" },
  });
  assert.equal(stuck.text, "snapshot");
  assert.notEqual(stuck.text, "browser running");
}

{
  // No args yet — empty detail is ok (title still shows tool name).
  const early = toolUserFacingDetail({
    toolId: "shell",
    summary: "shell running",
  });
  assert.equal(early.text, "");
}

{
  assert.equal(toolFamilyKey({ tool_name: "shell" }), "shell");
  assert.equal(toolFamilyKey({ tool_name: "执行命令" }), "shell");
  assert.equal(toolFamilyKey({ tool_name: "browser" }), "browser");
  assert.equal(toolFamilyKey({ tool_name: "surface" }), "surface");
}

{
  assert.equal(isJsonBlobText('{"ok":true,"op":"summary"}'), true);
  assert.equal(isJsonBlobText("nmap -sV x"), false);
  const surfaceLine = formatSurfaceToolDetail(
    { op: "summary" },
    { ok: true, op: "summary", total: 49, tested: 49, touched: 44, booked: 5, case_tested: 49 },
  );
  assert.match(surfaceLine, /共49/);
  assert.match(surfaceLine, /已测49/);
  assert.match(surfaceLine, /已登记5/);

  const surfaceCard = toolUserFacingDetail({
    toolId: "surface",
    toolName: "surface",
    summary: JSON.stringify({
      ok: true,
      op: "summary",
      total: 49,
      tested: 49,
      touched: 44,
      booked: 5,
    }),
  });
  // Request line = op only; counts belong in result drawer.
  assert.equal(surfaceCard.text, "summary");
  assert.equal(isJsonBlobText(surfaceCard.text), false);
}

{
  // Platform list: show query params, never echo Chinese tool title.
  assert.equal(
    formatToolArgsDetail({ status: "open", limit: 50 }),
    "status=open · limit=50",
  );
  const listVuln = toolUserFacingDetail({
    toolId: "platform_list_vulnerabilities",
    toolName: "查询漏洞台账",
    args: { status: "open", limit: 50 },
  });
  assert.match(listVuln.text, /status=open/);
  assert.match(listVuln.text, /limit=50/);
  assert.notEqual(listVuln.text, "查询漏洞台账");

  const listDefault = toolUserFacingDetail({
    toolId: "platform_list_vulnerabilities",
    toolName: "查询漏洞台账",
    args: {},
  });
  assert.equal(listDefault.text, "默认列表");

  const listAssets = toolUserFacingDetail({
    toolId: "platform_list_assets",
    toolName: "查询资产台账",
    args: { q: "dvwa", limit: 20 },
  });
  assert.match(listAssets.text, /关键词=dvwa|q=dvwa/);
  assert.match(listAssets.text, /limit=20/);

  const shell = toolUserFacingDetail({
    toolId: "shell",
    toolName: "执行命令",
    args: { command: "curl -x https://x" },
  });
  assert.equal(shell.text, "curl -x https://x");
  assert.equal(shell.mono, true);
}

{
  // Request line only — never response body / counts / exit codes.
  const http = toolUserFacingDetail({
    toolId: "http",
    toolName: "HTTP 探测",
    summary: JSON.stringify({
      ok: true,
      status: 200,
      url: "http://host.docker.internal:3000",
    }),
  });
  assert.equal(http.text, "GET http://host.docker.internal:3000");
  assert.ok(!http.text.includes("200"));

  const skill = toolUserFacingDetail({
    toolId: "skill",
    summary: JSON.stringify({
      ok: true,
      op: "load",
      id: "pentest-web-recon",
      name: "pentest-web-recon",
    }),
  });
  assert.equal(skill.text, "load pentest-web-recon");

  const todoDoneTask = toolUserFacingDetail({
    toolId: "todo",
    toolName: "更新任务清单",
    summary: JSON.stringify({
      ok: true,
      op: "done",
      task: "目录与隐藏路径扫描",
      summary: "Remaining items (20):\n  - API/接口枚举",
    }),
  });
  assert.equal(todoDoneTask.text, "done · 目录与隐藏路径扫描");

  const todoDoneCompleted = toolUserFacingDetail({
    toolId: "todo",
    summary: JSON.stringify({
      ok: true,
      op: "done",
      completed_tasks: [{ phase: "侦察", content: "首页与端口/服务枚举" }],
      summary: "Remaining items (20):",
    }),
  });
  assert.equal(todoDoneCompleted.text, "done · 首页与端口/服务枚举");

  // Truncated 4k JSON still recovers op + task when they appear early.
  const todoTrunc = toolUserFacingDetail({
    toolId: "todo",
    result_text: `{\n  "ok": true,\n  "op": "done",\n  "task": "登录机制探测与绕过",\n  "summary": "Remaining items (16):\\n  - 未闭合`,
  });
  assert.equal(todoTrunc.text, "done · 登录机制探测与绕过");

  const todoInitArgs = toolUserFacingDetail({
    toolId: "todo",
    args: {
      op: "init",
      list: [
        { phase: "侦察", items: ["a", "b"] },
        { phase: "测试", items: ["c"] },
      ],
    },
  });
  assert.equal(todoInitArgs.text, "init · 3 项");

  const finding = toolUserFacingDetail({
    toolId: "finding",
    summary: JSON.stringify({
      ok: true,
      finding: { action: "confirm", title: "PUT /api/Users" },
    }),
  });
  assert.match(finding.text, /confirm/);
  assert.match(finding.text, /PUT \/api\/Users/);

  const listVulnLegacy = toolUserFacingDetail({
    toolId: "platform_list_vulnerabilities",
    toolName: "查询漏洞台账",
    summary: JSON.stringify({
      ok: true,
      vulnerabilities: [{ id: "a" }, { id: "b" }, { id: "c" }],
    }),
  });
  assert.equal(listVulnLegacy.text, "默认列表");
  assert.ok(!listVulnLegacy.text.includes("3"));

  const shellLegacy = toolUserFacingDetail({
    toolId: "shell",
    toolName: "执行命令",
    summary: JSON.stringify({
      ok: true,
      timeout_seconds: 15,
      exitCode: 0,
      stdout: "HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *",
      command: "curl -sI http://x",
    }),
  });
  assert.equal(shellLegacy.text, "curl -sI http://x");
  assert.ok(!shellLegacy.text.includes("exit"));
  assert.ok(!shellLegacy.text.includes("HTTP/1.1"));

  const shellNoCmd = toolUserFacingDetail({
    toolId: "shell",
    toolName: "执行命令",
    summary: JSON.stringify({
      ok: true,
      exitCode: 0,
      stdout: "HTTP/1.1 200 OK",
    }),
  });
  // No request available — leave empty (result lives in drawer).
  assert.equal(shellNoCmd.text, "");
}

{
  // Same tool type merges; different types stay separate.
  const grouped = groupConsecutiveToolMessages([
    {
      id: "1",
      role: "agent",
      msg_type: "tool_call",
      content: {
        tool_name: "shell",
        status: "done",
        command: "bun run x",
        tool_run_id: "a",
      },
    },
    {
      id: "2",
      role: "agent",
      msg_type: "tool_call",
      content: {
        tool_name: "shell",
        status: "done",
        command: "curl https://x",
        tool_run_id: "b",
      },
    },
    {
      id: "3",
      role: "agent",
      msg_type: "tool_call",
      content: {
        tool_name: "todo",
        status: "done",
        args: { op: "start", task: "map" },
        tool_run_id: "c",
      },
    },
    {
      id: "4",
      role: "agent",
      msg_type: "text",
      content: { text: "done" },
    },
  ] as Message[]);
  assert.equal(grouped.length, 3, "two shells merge; todo separate; text separate");
  const shellItems = grouped[0]!.content.tool_items as Array<Record<string, unknown>>;
  assert.equal(shellItems.length, 2);
  assert.equal(shellItems[0]!.command, "bun run x");
  assert.equal(shellItems[1]!.command, "curl https://x");
  assert.equal(grouped[1]!.content.tool_name, "todo");
}

{
  // Shell drawer: readable stdout with real newlines — not JSON with \\n.
  const body = formatToolResultDrawerBody({
    toolId: "shell",
    result: {
      ok: true,
      command: "curl -sI http://x",
      exitCode: 0,
      stdout: "HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *",
    },
  });
  assert.match(body, /HTTP\/1\.1 200 OK/);
  assert.match(body, /Access-Control-Allow-Origin/);
  assert.match(body, /exit=0/);
  assert.ok(!body.includes('"command"'), "drawer should not dump shell JSON");
  assert.ok(!body.includes("\\r\\n"), "newlines should be real, not escaped");
  // Request row owns the command; drawer is output-only.
  assert.ok(!body.includes("curl -sI"));
}

{
  // Truncated 4k result_text still recovers open-ended stdout for the drawer.
  const trunc = formatToolResultDrawerBody({
    toolId: "shell",
    result_text:
      `{"ok":true,"command":"curl -s http://x/api-docs/","stdout":"\\n<!-- HTML for static distribution bundle build -->\\n<!DOCTYPE html>\\n<html lang=\\"`,
  });
  assert.match(trunc, /DOCTYPE html/);
  assert.match(trunc, /static distribution/);
  assert.ok(!trunc.includes('"stdout"'));
}

{
  // Long multi-line shell command must not be 240/500-teased on the request line.
  const longCmd =
    `# Fresh proof\nJIM_TOKEN=$(python3 -c "print('x'*800)")\n`
    + `# ${"A".repeat(600)}\n`
    + `curl -sH "Authorization: Bearer $JIM_TOKEN" http://x/`;
  assert.ok(longCmd.length > 500);
  const row = toolUserFacingDetail({
    toolId: "shell",
    toolName: "执行命令",
    command: longCmd,
    args: { command: longCmd },
  });
  assert.equal(row.text, longCmd);
  assert.ok(row.text.includes("JIM_TOKEN"));
  assert.ok(row.text.includes("python3"));
}

{
  // Shell drawer with streams missing + wire_truncated is honest (not JWT/command mash).
  const empty = formatToolResultDrawerBody({
    toolId: "shell",
    result: {
      ok: true,
      command: "# Fresh proof - need to hit non-deleted IDs\nJIM_TOKEN=$(python3 -c \"",
      wire_truncated: true,
    },
  });
  assert.match(empty, /截断|无 stdout|无输出/);
  assert.ok(!empty.includes('"alg"'));
}

{
  // 查询漏洞台账 — list summary, not shell stdout speech.
  const ledger = formatToolResultDrawerBody({
    toolId: "platform_list_vulnerabilities",
    toolName: "查询漏洞台账",
    args: { limit: 50 },
    result: {
      ok: true,
      vulnerabilities: [
        { id: "a", title: "XSS on /profile", status: "open" },
        { id: "b", title: "SQLi", status: "fixed" },
      ],
      total: 2,
    },
  });
  assert.match(ledger, /vulnerabilities/);
  assert.match(ledger, /XSS on \/profile/);
  assert.ok(!ledger.includes("无 stdout"));
  assert.ok(!ledger.includes("tool-output"));
}

{
  // Destroyed empty-shell wire payload on todo → raw req + honest resp note.
  const destroyed = formatToolResultDrawerBody({
    toolId: "todo",
    toolName: "更新任务清单",
    args: { op: "done", task: "SQL注入测试" },
    result_text: '{"ok":true,"output_truncated":true,"stdout":"","stderr":"","wire_truncated":true}',
  });
  assert.match(destroyed, /【请求】/);
  assert.match(destroyed, /SQL注入测试/);
  assert.match(destroyed, /响应/);
  assert.ok(!destroyed.includes("无 stdout/stderr — 结果在上屏时被截断；请重跑该命令"));
}

{
  // finding drawer: id/action/title, not full poc dump.
  const findingBody = formatToolResultDrawerBody({
    toolId: "finding",
    args: { action: "confirm", title: "XSS", poc: "long poc..." },
    result: {
      ok: true,
      finding: { id: "f_1", action: "confirm", title: "XSS", severity: "high" },
    },
  });
  assert.match(findingBody, /f_1/);
  assert.match(findingBody, /confirm/);
  assert.match(findingBody, /XSS/);
  assert.ok(!findingBody.includes("long poc"));
}

{
  // http drawer: status + body
  const httpBody = formatToolResultDrawerBody({
    toolId: "http",
    args: { url: "http://x/", method: "GET" },
    result: {
      ok: true,
      status: 200,
      url: "http://x/",
      headers: { "content-type": "text/html" },
      body: "<html>hi</html>",
    },
  });
  assert.match(httpBody, /status: 200/);
  assert.match(httpBody, /content-type/);
  assert.match(httpBody, /<html>hi/);
}

{
  // decision request line must not use polluted content.command
  const dec = toolUserFacingDetail({
    toolId: "request_user_decision",
    toolName: "请求用户决策",
    command: "GET http://host.docker.internal:3000",
    args: {
      kind: "next_steps",
      target: "http://host.docker.internal:3000",
      question: "下一步？",
    },
  });
  assert.match(dec.text, /next_steps/);
  assert.ok(!dec.text.startsWith("GET http"));
}

{
  // Generic unknown tool → raw dual JSON fallback
  const gen = formatToolResultDrawerBody({
    toolId: "custom_probe",
    args: { x: 1 },
    result: { ok: true, y: 2 },
  });
  assert.match(gen, /【请求】/);
  assert.match(gen, /【响应】/);
  assert.match(gen, /"x": 1/);
  assert.match(gen, /"y": 2/);
}

{
  // Icon family must follow raw id, not only English substrings on Chinese labels.
  assert.equal(toolFamilyFromName("shell"), "shell");
  assert.equal(toolFamilyFromName("执行命令"), "shell");
  assert.equal(toolFamilyFromName("http"), "http");
  assert.equal(toolFamilyFromName("HTTP 探测"), "http");
  assert.equal(toolFamilyFromName("browser"), "browser");
  assert.equal(toolFamilyFromName("浏览器探测"), "browser");
  assert.equal(toolFamilyFromName("read"), "file");
  assert.equal(toolFamilyFromName("读取文件"), "file");
  assert.equal(toolFamilyFromName("todo"), "todo");
  assert.equal(toolFamilyFromName("更新任务清单"), "todo");
  assert.equal(toolFamilyFromName("skill"), "skill");
  assert.equal(toolFamilyFromName("加载技能"), "skill");
  assert.equal(toolFamilyFromName("finding"), "finding");
  assert.equal(toolFamilyFromName("登记发现"), "finding");
  assert.equal(toolFamilyFromName("surface"), "surface");
  assert.equal(toolFamilyFromName("记录攻击面"), "surface");
  assert.equal(toolFamilyFromName("subagent"), "subagent");
  assert.equal(toolFamilyFromName("platform_list_assets"), "platform");
  assert.equal(toolFamilyFromName("查询资产台账"), "platform");
  assert.equal(toolFamilyFromName("graph_feedback"), "feedback");
  assert.equal(toolFamilyFromName("阶段评审"), "feedback");
  assert.equal(toolFamilyKey({ tool_name: "graph_feedback" }), "feedback");
  assert.equal(toolFamilyFromName("workset"), "workset");
  assert.equal(toolFamilyFromName("暴露面候选"), "workset");
  assert.equal(toolFamilyKey({ tool_name: "shell" }), "shell");
  assert.equal(toolFamilyKey({ latest_tool_name: "http" }), "http");
}

console.log("toolDetail.test.ts: ok");
