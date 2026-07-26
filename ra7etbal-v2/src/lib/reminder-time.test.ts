import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatReminderCreatedTime, formatReminderDue } from "./reminder-time";
import { parseVoiceTime } from "./parse-voice-time";

/**
 * Reminder cards in What's Happening previously showed only the due date,
 * with no indication of when the reminder was created (unlike
 * followup/delegation cards, which already show a "Sent ..." created_at
 * line). This adds the equivalent for reminders: "Created today at ..." or
 * the full date for anything older, using the same today/date/time
 * building blocks formatReminderDue already exports and this repo already
 * relies on elsewhere.
 */
describe("formatReminderCreatedTime", () => {
  const now = new Date("2026-07-26T00:40:00"); // Sunday 12:40 AM local

  it("returns null for a null or invalid value", () => {
    expect(formatReminderCreatedTime(null, now)).toBeNull();
    expect(formatReminderCreatedTime("not-a-date", now)).toBeNull();
  });

  it("labels a same-day creation as \"Created today at <time>\"", () => {
    const result = formatReminderCreatedTime("2026-07-26T00:40:00", now);
    expect(result).toBe("Created today at 12:40 AM");
  });

  it("labels an earlier creation with the full local date and time, not \"today\"", () => {
    const result = formatReminderCreatedTime("2026-07-24T09:15:00", now);
    expect(result).toBe("Created Jul 24 at 9:15 AM");
  });

  it("never says \"today\" for a creation on a different calendar day, even a few hours before midnight", () => {
    // Created 11:50 PM the night before "now" (00:40 AM) — a different
    // calendar day, must not be mislabeled "today".
    const lateNight = new Date("2026-07-26T00:40:00");
    const result = formatReminderCreatedTime("2026-07-25T23:50:00", lateNight);
    expect(result).not.toContain("today");
    expect(result).toBe("Created Jul 25 at 11:50 PM");
  });
});

// Protects the display/persistence boundary explicitly: reminder-time.ts is
// pure display formatting over an already-stored value. It must never be
// able to read or write reminder scheduling data itself — that would let a
// display bug corrupt (or a display fix silently touch) the stored due date,
// exactly the kind of layer-mixing the PR #73 investigation had to rule out
// by hand via a direct production query.
describe("reminder-time.ts — display formatting cannot touch stored reminder data", () => {
  const SOURCE = readFileSync(join(__dirname, "reminder-time.ts"), "utf-8");

  it("imports nothing from Supabase, the tasks store, or parseVoiceTime — pure formatting over its string/Date inputs only", () => {
    expect(SOURCE).not.toMatch(/from ["'].*supabase/i);
    expect(SOURCE).not.toMatch(/from ["'].*tasks["']/);
    expect(SOURCE).not.toMatch(/from ["'].*parse-voice-time/);
    expect(SOURCE).not.toContain("import");
  });
});

// Protected behavior: the stored due_at and the displayed due date/time must
// always agree — no separate "display value" exists anywhere that could
// silently drift from what createReminderTask actually persisted. This locks
// the boundary end-to-end by feeding parseVoiceTime's own dueAt output
// straight into formatReminderDue (the same string createReminderTask would
// store verbatim as task.due_at — reminders.ts passes dueAt straight through
// with no transformation), using fixtures already proven correct by
// parse-voice-time.test.ts.
describe("formatReminderDue — stored vs. displayed due time agreement", () => {
  it('"Monday at 5:00 PM" stored as due_at displays back as exactly "Monday at 5:00 PM", with no timezone or weekday drift', () => {
    // Same fixture as parse-voice-time.test.ts's bare-weekday regression:
    // Saturday night, past 5 PM — the case that previously mis-rolled to Sunday.
    const now = new Date("2026-07-25T23:24:00");
    const parsed = parseVoiceTime("Monday at 5:00 PM", now);
    expect(parsed.error).toBeUndefined();

    const displayed = formatReminderDue(parsed.dueAt, now);
    expect(displayed).toBe("Monday at 5:00 PM");
  });

  it('a multi-day-out weekday reminder ("next Friday at 9 AM") displays back with the same weekday and time it was stored with', () => {
    // Same fixture as parse-voice-time.test.ts's phone-charge-reminder suite.
    const now = new Date("2026-07-12T01:34:10");
    const parsed = parseVoiceTime("next Friday at 9 AM", now);
    expect(parsed.error).toBeUndefined();
    expect(parsed.dueAt).toBe(new Date("2026-07-17T09:00:00").toISOString());

    const displayed = formatReminderDue(parsed.dueAt, now);
    expect(displayed).toBe("Friday at 9:00 AM");
  });

  it("formats directly from the raw stored value via `new Date(value)` — no separate re-derivation that could diverge from the persisted due_at", () => {
    const SOURCE = readFileSync(join(__dirname, "reminder-time.ts"), "utf-8");
    const block = SOURCE.slice(
      SOURCE.indexOf("export function formatReminderDue("),
      SOURCE.indexOf("export function formatReminderDueTime"),
    );
    expect(block).toContain("const due = new Date(value);");
  });
});
