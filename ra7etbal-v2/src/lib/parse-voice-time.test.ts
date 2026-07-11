import { afterEach, describe, expect, it, vi } from "vitest";
import { parseVoiceTime, resolveRecurringAutomationFirstRun } from "./parse-voice-time";

// Confirmed production failure: a daily automation requested ~2 minutes
// ahead ("charge your phone" at 1:36 AM, created at 1:34 AM Europe/Istanbul)
// was scheduled for the following day instead of firing that morning.
// Reproduced directly against this function with the real timestamps:
// createAutomation's first_run_text (Carson's own tool-call argument)
// contained the literal word "tomorrow", which this absolute-time branch
// resolves literally by design (see the "critical fix" comment on the
// tomorrow branch below) — that is correct, intentional behavior for a
// one-time task, and is NOT changed here. The actual fix is
// resolveRecurringAutomationFirstRun (tested below), which snaps a
// recurring loop's first run back to today when this function resolves an
// explicit "tomorrow" but the same clock time is still safely ahead today.
describe("parseVoiceTime — reproduces the confirmed phone-charge-reminder production failure", () => {
  // 2026-07-12 01:34:10 local (Europe/Istanbul) — matches automations row
  // created_at 2026-07-11 22:34:16 UTC for id 1ab27f48-bd9b-4483-b441-8043391d3c39.
  const now = new Date("2026-07-12T01:34:10");

  it('resolves "1:36 AM" (no day word) to today when the target time is still ~2 minutes ahead', () => {
    const result = parseVoiceTime("1:36 AM", now);
    expect(result.error).toBeUndefined();
    expect(result.dueAt).toBe(new Date("2026-07-12T01:36:00").toISOString());
    expect(result.parsedAs).toContain('day="auto"');
  });

  it('resolves "tomorrow at 1:36 AM" to the next calendar day, even though the same clock time is still ahead today (documents the literal-"tomorrow" contract resolveRecurringAutomationFirstRun must compensate for)', () => {
    const result = parseVoiceTime("tomorrow at 1:36 AM", now);
    expect(result.error).toBeUndefined();
    expect(result.dueAt).toBe(new Date("2026-07-13T01:36:00").toISOString());
    expect(result.parsedAs).toContain('day="tomorrow"');
  });

  it('a genuinely multi-day-ahead phrase like "next Friday" is unaffected by resolveRecurringAutomationFirstRun (it never resolves day="tomorrow")', () => {
    const result = parseVoiceTime("next Friday at 9 AM", now);
    expect(result.error).toBeUndefined();
    expect(result.parsedAs).not.toContain('day="tomorrow"');
    // 2026-07-12 is a Sunday; next Friday is 2026-07-17.
    expect(result.dueAt).toBe(new Date("2026-07-17T09:00:00").toISOString());
  });
});

describe("resolveRecurringAutomationFirstRun", () => {
  // Same real-world case as above, expressed as parseVoiceTime's own output
  // shape rather than re-parsing text, per CodeRabbit's request for
  // behavioral tests against the extracted helper's actual output.
  const now = new Date("2026-07-12T01:34:10");
  const tomorrowParsed = {
    dueAt: new Date("2026-07-13T01:36:00").toISOString(),
    parsedAs: 'absolute: day="tomorrow" time=01:36',
  };

  it("snaps a recurring cadence's explicit-tomorrow result back to today when still >60s ahead", () => {
    const result = resolveRecurringAutomationFirstRun(tomorrowParsed, "daily", now);
    expect(result).toBe(new Date("2026-07-12T01:36:00").toISOString());
  });

  it(`leaves a "once" cadence's explicit-tomorrow result untouched — a one-time task must respect an explicit "tomorrow" literally`, () => {
    const result = resolveRecurringAutomationFirstRun(tomorrowParsed, "once", now);
    expect(result).toBe(tomorrowParsed.dueAt);
  });

  it('leaves a result untouched when parsedAs did not resolve day="tomorrow" (e.g. "auto", "next Friday", relative days)', () => {
    const autoParsed = {
      dueAt: new Date("2026-07-12T01:36:00").toISOString(),
      parsedAs: 'absolute: day="auto" time=01:36',
    };
    expect(resolveRecurringAutomationFirstRun(autoParsed, "daily", now)).toBe(autoParsed.dueAt);

    const nextFridayParsed = {
      dueAt: new Date("2026-07-17T09:00:00").toISOString(),
      parsedAs: 'named: next friday → +5 days at 09:00',
    };
    expect(resolveRecurringAutomationFirstRun(nextFridayParsed, "weekly", now)).toBe(nextFridayParsed.dueAt);
  });

  it("never snaps back into the past — if today's occurrence of the time has already passed, tomorrow is kept", () => {
    // now is 8:00 AM; tomorrow's resolved time-of-day is 1:36 AM, which
    // already passed today hours ago.
    const lateNow = new Date("2026-07-12T08:00:00");
    const result = resolveRecurringAutomationFirstRun(tomorrowParsed, "daily", lateNow);
    expect(result).toBe(tomorrowParsed.dueAt);
  });

  it("uses a strict >60s threshold, not >=  (a target exactly 60s from now is not snapped)", () => {
    const exactlyOneMinuteAway = {
      dueAt: new Date(now.getTime() + 24 * 60 * 60 * 1000 + 60_000).toISOString(),
      parsedAs: 'absolute: day="tomorrow" time=00:00',
    };
    // today's occurrence would land exactly at now + 60_000ms — the guard
    // requires strictly greater than that, so this must NOT snap.
    const result = resolveRecurringAutomationFirstRun(exactlyOneMinuteAway, "daily", now);
    expect(result).toBe(exactlyOneMinuteAway.dueAt);
  });

  // CodeRabbit finding: a fixed 24-hour millisecond subtraction is incorrect
  // across a DST transition, because a calendar day that crosses a DST
  // boundary is not always 24 real hours. Proven here with a genuine
  // America/New_York spring-forward transition (2027-03-14, clocks jump
  // from 01:59:59 to 03:00:00): "tomorrow at 5:00 AM" on March 14 (already
  // in EDT, UTC-4) is only 23 real hours after "today at 5:00 AM" on March
  // 13 (still in EST, UTC-5) — a naive getTime() - 24*60*60*1000 would land
  // on 4:00 AM local, not 5:00 AM, and in this exact scenario would even
  // wrongly fail the "still ahead of now" check and keep tomorrow instead
  // of correctly snapping to today's real 5:00 AM.
  describe("DST safety (America/New_York spring-forward, 2027-03-14)", () => {
    const TZ = "America/New_York";

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("resolves to today's true local wall-clock time, not a fixed-24h-off result", () => {
      vi.stubEnv("TZ", TZ);

      // now: March 13, 2027, 04:00:00 local (EST, UTC-5) — one hour before
      // today's target time, so the snap-back should trigger.
      const dstNow = new Date(2027, 2, 13, 4, 0, 0, 0);
      // tomorrow's resolved instant: March 14, 2027, 05:00:00 local (EDT,
      // UTC-4, after the 2 AM transition) — exactly what parseVoiceTime's
      // "day=tomorrow" branch would produce for "tomorrow at 5 AM".
      const dstTomorrowParsed = {
        dueAt: new Date(2027, 2, 14, 5, 0, 0, 0).toISOString(),
        parsedAs: 'absolute: day="tomorrow" time=05:00',
      };

      const result = resolveRecurringAutomationFirstRun(dstTomorrowParsed, "daily", dstNow);

      // Correct: today (March 13) at the true local 5:00 AM EST.
      const expected = new Date(2027, 2, 13, 5, 0, 0, 0).toISOString();
      expect(result).toBe(expected);

      // Demonstrates the bug this replaces: a naive 24-hour-ms subtraction
      // from dstTomorrowParsed.dueAt lands one hour earlier than the
      // correct local wall-clock time, because the calendar day crossed a
      // DST transition (23 real hours, not 24).
      const naiveOneDayEarlier = new Date(
        new Date(dstTomorrowParsed.dueAt).getTime() - 24 * 60 * 60 * 1000,
      ).toISOString();
      expect(naiveOneDayEarlier).not.toBe(expected);
    });
  });
});
