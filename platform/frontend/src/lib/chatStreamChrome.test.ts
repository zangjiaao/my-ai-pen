/**
 * Spec #326 / #323 UI seam — stream stamps + status suppression.
 * Run: npx tsx src/lib/chatStreamChrome.test.ts  (from platform/frontend)
 */
import assert from "node:assert/strict";
import {
  calendarDayKey,
  formatChatMessageTime,
  isInfraStatusNotice,
  projectStreamWithDaySeparators,
  shouldInsertStreamTimeStamp,
  shouldRenderStatusNotice,
  STREAM_TIME_STAMP_GAP_MS,
} from "./chatStreamChrome.ts";

// --- Status: harness/tooling hidden; engagement_closeout kept -----------------

{
  assert.equal(
    isInfraStatusNotice({ phase: "tooling_health", text: "sandbox degraded" }, "status"),
    true,
  );
  assert.equal(
    shouldRenderStatusNotice({
      role: "system",
      msg_type: "status",
      content: { text: "harness abort: cancelled" },
    }),
    false,
    "harness abort status is not product chrome",
  );
  assert.equal(
    shouldRenderStatusNotice({
      role: "system",
      msg_type: "status",
      content: { phase: "tooling_health", text: "Tooling health: degraded" },
    }),
    false,
  );
  assert.equal(
    shouldRenderStatusNotice({
      role: "system",
      msg_type: "engagement_closeout",
      content: {
        text: "Engagement close-out · terminal=completed",
        type: "engagement_closeout",
        terminal: "completed",
      },
    }),
    true,
    "engagement_closeout still renders",
  );
  assert.equal(
    shouldRenderStatusNotice({
      role: "system",
      msg_type: "status",
      content: { text: "Task incomplete - partial", status: "incomplete" },
    }),
    false,
    "ordinary status notices are hidden in multi-agent Case stream",
  );
  console.log("ok: status suppression; closeout kept");
}

// --- Reject epoch / 1970 placeholders -----------------------------------------

{
  assert.equal(
    formatChatMessageTime("1970-01-01T00:00:00.000Z"),
    "",
    "epoch ISO must not render as a chat stamp",
  );
  assert.equal(
    shouldInsertStreamTimeStamp(undefined, "1970-01-01T00:00:00.000Z"),
    false,
    "epoch first message must not force a stamp",
  );
  const real = new Date(2026, 7, 8, 12, 0, 0).toISOString();
  assert.equal(
    shouldInsertStreamTimeStamp(real, "1970-01-01T00:00:00.000Z"),
    false,
    "epoch after real message must not insert 1970 day-change stamp",
  );
  const projected = projectStreamWithDaySeparators([
    { id: "u1", created_at: real, msg_type: "text", role: "user" },
    {
      id: "live",
      created_at: "1970-01-01T00:00:00.000Z",
      msg_type: "text",
      role: "agent",
    },
  ]);
  const stamps = projected.filter((p) => p.kind === "time_separator");
  assert.ok(
    stamps.every((s) => s.kind === "time_separator" && !s.label.startsWith("1970")),
    "no 1970 labels in projection",
  );
  console.log("ok: epoch placeholders never become stream stamps");
}

// --- Centered full datetime when necessary -----------------------------------

{
  const day1 = new Date(2026, 7, 5, 10, 15, 30);
  const day1Soon = new Date(2026, 7, 5, 10, 16, 0); // +30s
  const day1Later = new Date(2026, 7, 5, 10, 15 + 6, 30); // +6min
  const day2 = new Date(2026, 7, 6, 9, 0, 0);
  const iso1 = day1.toISOString();
  const isoSoon = day1Soon.toISOString();
  const isoLater = day1Later.toISOString();
  const iso2 = day2.toISOString();

  assert.equal(shouldInsertStreamTimeStamp(undefined, iso1), true, "first message needs stamp");
  assert.equal(
    shouldInsertStreamTimeStamp(iso1, isoSoon),
    false,
    "short gap same day — no stamp",
  );
  assert.equal(
    shouldInsertStreamTimeStamp(iso1, isoLater),
    true,
    `gap ≥ ${STREAM_TIME_STAMP_GAP_MS}ms needs stamp`,
  );
  assert.equal(shouldInsertStreamTimeStamp(iso1, iso2), true, "day change needs stamp");

  const stamp = formatChatMessageTime(iso1);
  assert.match(stamp, /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/, "YYYY/MM/DD HH:mm:ss");
  assert.equal(calendarDayKey(iso1), calendarDayKey(isoSoon));
  console.log("ok: necessary stamp rules + full datetime format");
}

{
  const msgs = [
    {
      id: "m1",
      created_at: new Date(2026, 7, 5, 10, 0, 0).toISOString(),
      msg_type: "text",
      role: "user",
      content: { text: "hi" },
    },
    {
      id: "m2",
      created_at: new Date(2026, 7, 5, 10, 1, 0).toISOString(),
      msg_type: "text",
      role: "agent",
      content: { text: "reply" },
    },
    {
      id: "m3",
      created_at: new Date(2026, 7, 5, 11, 0, 0).toISOString(),
      msg_type: "text",
      role: "user",
      content: { text: "later" },
    },
  ];

  const projected = projectStreamWithDaySeparators(msgs);
  const stamps = projected.filter((p) => p.kind === "time_separator");
  const messages = projected.filter((p) => p.kind === "message");

  assert.equal(messages.length, 3);
  // First message always stamped; m2 within 1 min no stamp; m3 after 1h stamped.
  assert.equal(stamps.length, 2, "only necessary timestamps");
  assert.equal(projected[0]?.kind, "time_separator", "stamp appears before dialogue");
  assert.equal(projected[1]?.kind, "message");
  if (projected[0]?.kind === "time_separator") {
    assert.match(projected[0].label, /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
  }
  console.log("ok: stream projection puts full datetime before dialogue when needed");
}

console.log("all chatStreamChrome tests passed");
