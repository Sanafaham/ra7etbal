import { describe, it, expect } from "vitest";
import { isReminderOverdue as browserIsReminderOverdue } from "./reminder-time";
import { isReminderOverdue as sharedIsReminderOverdue } from "../../shared/carson-morning-brief-classifier.js";

/**
 * Documented exception (2026-08-28, Second Brain typed hard-grounding
 * slice): `isReminderOverdue` exists in two places on purpose.
 *
 * - src/lib/reminder-time.ts's copy is the original, protected by a
 *   deliberate, tested zero-import architectural invariant (see
 *   reminder-time.test.ts) — it must stay exactly as-is.
 * - shared/carson-morning-brief-classifier.js's copy exists only because
 *   buildMorningBrief() (also relocated there for server reuse) needs it,
 *   and that shared module cannot import from reminder-time.ts without
 *   reintroducing a dependency reminder-time.ts's own invariant forbids.
 *
 * This is accepted as a narrow exception to "one source of truth" because
 * isReminderOverdue is a trivial runtime primitive (`due < now`), not
 * business classification logic — unlike buildMorningBrief,
 * classifyAttentionWorthyCaptures, and renderAttentionSummary/
 * composeAttentionEvidence, which remain genuinely single-sourced in
 * shared/.
 *
 * Do NOT "deduplicate" this by making reminder-time.ts import from
 * shared/ — that breaks its protected zero-import invariant (proven by a
 * real test failure during this exact extraction). This test exists only
 * to catch the two copies drifting apart if either is ever edited alone.
 */
describe("isReminderOverdue — reminder-time.ts vs shared/ parity", () => {
  it("both report true when due is before now", () => {
    const now = new Date("2026-08-28T12:00:00.000Z");
    const due = new Date("2026-08-28T11:00:00.000Z").toISOString();
    expect(browserIsReminderOverdue(due, now)).toBe(true);
    expect(sharedIsReminderOverdue(due, now)).toBe(true);
    expect(browserIsReminderOverdue(due, now)).toBe(sharedIsReminderOverdue(due, now));
  });

  it("both report false when due equals now", () => {
    const now = new Date("2026-08-28T12:00:00.000Z");
    const due = now.toISOString();
    expect(browserIsReminderOverdue(due, now)).toBe(false);
    expect(sharedIsReminderOverdue(due, now)).toBe(false);
    expect(browserIsReminderOverdue(due, now)).toBe(sharedIsReminderOverdue(due, now));
  });

  it("both report false when due is after now", () => {
    const now = new Date("2026-08-28T12:00:00.000Z");
    const due = new Date("2026-08-28T13:00:00.000Z").toISOString();
    expect(browserIsReminderOverdue(due, now)).toBe(false);
    expect(sharedIsReminderOverdue(due, now)).toBe(false);
    expect(browserIsReminderOverdue(due, now)).toBe(sharedIsReminderOverdue(due, now));
  });
});
