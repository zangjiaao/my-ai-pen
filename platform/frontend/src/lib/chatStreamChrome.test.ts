/**
 * Spec #326 / #323 UI seam — stream stamps + infra status suppression.
 * Run: npx tsx src/lib/chatStreamChrome.test.ts  (from platform/frontend)
 */
import assert from "node:assert/strict";
import {
  calendarDayKey,
  formatChatDaySeparator,
  formatChatMessageTime,
  isInfraStatusNotice,
  projectStreamWithDaySeparators,
  shouldInsertDaySeparator,
  shouldRenderStatusNotice,
} from "./chatStreamChrome.ts";

// --- L9: tooling_health suppressed; engagement_closeout kept -----------------

{
  assert.equal(
    isInfraStatusNotice({ phase: "tooling_health", text: "sandbox degraded" }, "status"),
    true,
    "phase tooling_health is infra",
  );
  assert.equal(
    isInfraStatusNotice({ agent_phase: "tooling_health", text: "probe ok" }, "status"),
    true,
    "agent_phase tooling_health is infra",
  );
  assert.equal(
    isInfraStatusNotice(
      {
        text: "pen-tools summary",
        tooling_health: { gating: false, degraded: true },
      },
      "status",
    ),
    true,
    "nested tooling_health object is infra",
  );
  assert.equal(
    isInfraStatusNotice({ type: "tooling_health", text: "health" }, "status"),
    true,
    "type token tooling_health is infra",
  );
  console.log("ok: tooling_health structured tokens are infra");
}

{
  assert.equal(
    isInfraStatusNotice(
      {
        text: "Engagement close-out · terminal=completed",
        type: "engagement_closeout",
        terminal: "completed",
      },
      "engagement_closeout",
    ),
    false,
    "engagement_closeout msg_type is never infra",
  );
  assert.equal(
    isInfraStatusNotice(
      {
        text: "Engagement close-out · terminal=completed",
        type: "engagement_closeout",
      },
      "status",
    ),
    false,
    "engagement_closeout content.type is never infra",
  );
  assert.equal(
    isInfraStatusNotice({ text: "Task incomplete - partial", status: "incomplete" }, "status"),
    false,
    "ordinary status notices are not infra",
  );
  console.log("ok: engagement_closeout and ordinary status stay visible");
}

{
  const tooling = {
    role: "system",
    msg_type: "status",
    content: { phase: "tooling_health", text: "Tooling health: degraded" },
  };
  assert.equal(shouldRenderStatusNotice(tooling), false, "tooling_health not rendered");

  const closeout = {
    role: "system",
    msg_type: "engagement_closeout",
    content: {
      text: "Engagement close-out · terminal=completed",
      type: "engagement_closeout",
      terminal: "completed",
    },
  };
  assert.equal(shouldRenderStatusNotice(closeout), true, "engagement_closeout still renders");

  const emptyCloseout = {
    role: "system",
    msg_type: "engagement_closeout",
    content: { type: "engagement_closeout", text: "" },
  };
  assert.equal(shouldRenderStatusNotice(emptyCloseout), false, "empty closeout has no chrome");

  const legacyPhase = {
    role: "system",
    msg_type: "status",
    content: { phase: "recon", text: "攻击面发现", synthetic: true },
  };
  assert.equal(shouldRenderStatusNotice(legacyPhase), false, "legacy phase-only still hidden");

  console.log("ok: shouldRenderStatusNotice projection outcomes");
}

// --- Day separators + message times ------------------------------------------

{
  // Construct local-midnight-ish timestamps via Date so day keys are stable.
  const day1 = new Date(2026, 7, 5, 10, 15, 0); // Aug 5 2026 local
  const day1b = new Date(2026, 7, 5, 18, 0, 0);
  const day2 = new Date(2026, 7, 6, 9, 0, 0);
  const iso1 = day1.toISOString();
  const iso1b = day1b.toISOString();
  const iso2 = day2.toISOString();

  assert.equal(calendarDayKey(iso1), calendarDayKey(iso1b), "same local day shares key");
  assert.notEqual(calendarDayKey(iso1), calendarDayKey(iso2), "next day differs");
  assert.equal(shouldInsertDaySeparator(undefined, iso1), true, "first message gets separator");
  assert.equal(shouldInsertDaySeparator(iso1, iso1b), false, "same day no separator");
  assert.equal(shouldInsertDaySeparator(iso1, iso2), true, "day change inserts separator");

  const clock = formatChatMessageTime(iso1);
  assert.match(clock, /^\d{2}:\d{2}$/, "message time is HH:mm");
  console.log("ok: calendar day keys and message clock");
}

{
  const now = new Date(2026, 7, 8, 12, 0, 0); // Aug 8 2026
  const today = new Date(2026, 7, 8, 8, 0, 0).toISOString();
  const yesterday = new Date(2026, 7, 7, 8, 0, 0).toISOString();
  const older = new Date(2026, 7, 1, 8, 0, 0).toISOString();
  const lastYear = new Date(2025, 11, 25, 8, 0, 0).toISOString();

  assert.equal(formatChatDaySeparator(today, now), "今天");
  assert.equal(formatChatDaySeparator(yesterday, now), "昨天");
  assert.equal(formatChatDaySeparator(older, now), "8月1日");
  assert.equal(formatChatDaySeparator(lastYear, now), "2025年12月25日");
  console.log("ok: day separator labels");
}

{
  const now = new Date(2026, 7, 8, 12, 0, 0);
  const msgs = [
    {
      id: "m1",
      created_at: new Date(2026, 7, 5, 10, 0, 0).toISOString(),
      msg_type: "text",
      role: "user",
      content: { text: "day1" },
    },
    {
      id: "m2",
      created_at: new Date(2026, 7, 5, 14, 0, 0).toISOString(),
      msg_type: "text",
      role: "agent",
      content: { text: "reply" },
    },
    {
      id: "m3",
      created_at: new Date(2026, 7, 7, 9, 0, 0).toISOString(),
      msg_type: "text",
      role: "user",
      content: { text: "day2" },
    },
    // Suppressed tooling_health would be filtered before projectStreamWithDaySeparators;
    // if it leaked in, renderer still nulls — stream projection keeps message rows here.
    {
      id: "m4",
      created_at: new Date(2026, 7, 8, 11, 0, 0).toISOString(),
      msg_type: "engagement_closeout",
      role: "system",
      content: { text: "Engagement close-out · terminal=completed", type: "engagement_closeout" },
    },
  ];

  const projected = projectStreamWithDaySeparators(msgs, now);
  const days = projected.filter((p) => p.kind === "day_separator");
  const messages = projected.filter((p) => p.kind === "message");

  assert.equal(messages.length, 4, "all messages present");
  assert.equal(days.length, 3, "one separator per distinct calendar day");
  assert.ok(
    days.every((d) => d.kind === "day_separator" && d.label && d.dayKey),
    "separators have label + dayKey",
  );
  // First item should be a day separator before the first message.
  assert.equal(projected[0]?.kind, "day_separator");
  assert.equal(projected[1]?.kind, "message");

  // Multi-day orientation: later day labels differ from earlier.
  const labels = days.map((d) => (d.kind === "day_separator" ? d.label : ""));
  assert.ok(new Set(labels).size === labels.length, "distinct day labels for multi-day Case");

  // Filter simulation: tooling_health never contributes stream chrome text.
  const toolingMsg = {
    role: "system" as const,
    msg_type: "status",
    content: { phase: "tooling_health", text: "Tooling health: nuclei missing" },
  };
  assert.equal(shouldRenderStatusNotice(toolingMsg), false);
  const filtered = msgs.filter((m) =>
    m.msg_type === "status" || m.role === "system" || m.msg_type === "engagement_closeout"
      ? shouldRenderStatusNotice(m)
      : true,
  );
  assert.ok(
    filtered.some((m) => m.msg_type === "engagement_closeout"),
    "closeout survives filter",
  );
  assert.ok(
    !filtered.some((m) => isInfraStatusNotice(m.content, m.msg_type)),
    "no infra rows after filter",
  );

  console.log("ok: projectStreamWithDaySeparators multi-day stream");
}

console.log("all chatStreamChrome tests passed");
