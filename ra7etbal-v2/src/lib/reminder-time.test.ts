import { describe, expect, it } from "vitest";
import { formatReminderCreatedTime } from "./reminder-time";

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
