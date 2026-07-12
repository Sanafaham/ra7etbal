import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseVoiceTime,
  resolveRecurringAutomationFirstRun,
  resolveRecurringFirstRunTextForParsing,
} from "./parse-voice-time";

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

describe("resolveRecurringFirstRunTextForParsing", () => {
  it('recovers the explicit clock from cadence_phrase when first_run_text is only "tonight" (live 11:40 PM regression)', () => {
    const result = resolveRecurringFirstRunTextForParsing({
      firstRunText: "tonight",
      cadencePhrase: "every night at 11:40 PM",
      cadenceType: "daily",
    });

    expect(result).toEqual({ timeText: "11:40 PM" });

    const parsed = parseVoiceTime(result.timeText, new Date("2026-07-12T23:17:00"));
    expect(parsed.error).toBeUndefined();
    expect(parsed.dueAt).toBe(new Date("2026-07-12T23:40:00").toISOString());
  });

  it("fails closed for recurring period defaults when no exact clock survives", () => {
    const result = resolveRecurringFirstRunTextForParsing({
      firstRunText: "tonight",
      cadencePhrase: "every night",
      cadenceType: "daily",
    });

    expect(result.timeText).toBe("");
    expect(result.error).toMatch(/exact clock time/i);
  });

  it('extracts an explicit clock from an ambiguous first_run_text wrapper like "tonight at 9:15 PM"', () => {
    const result = resolveRecurringFirstRunTextForParsing({
      firstRunText: "tonight at 9:15 PM",
      cadencePhrase: "every night",
      cadenceType: "daily",
    });

    expect(result).toEqual({ timeText: "9:15 PM" });

    const parsed = parseVoiceTime(result.timeText, new Date("2026-07-12T20:00:00"));
    expect(parsed.error).toBeUndefined();
    expect(parsed.dueAt).toBe(new Date("2026-07-12T21:15:00").toISOString());
  });

  it("preserves a valid first_run_text day reference instead of replacing it with cadence_phrase's bare clock", () => {
    const result = resolveRecurringFirstRunTextForParsing({
      firstRunText: "next Monday",
      cadencePhrase: "every Monday at 8 AM",
      cadenceType: "weekly",
    });

    expect(result).toEqual({ timeText: "next Monday" });
  });

  it("keeps the existing morning disambiguation by appending AM to a bare clock", () => {
    const result = resolveRecurringFirstRunTextForParsing({
      firstRunText: "3:15",
      cadencePhrase: "every morning",
      cadenceType: "daily",
    });

    expect(result).toEqual({ timeText: "3:15 AM" });
  });
});

// Regression: confirmed production failure. "Remind me every morning ...
// at 3:15 AM" was correctly heard and correctly spoken back by Carson
// ("I'll remind you every morning at 3:15 AM..."), but the stored
// automation ran at 3:15 PM instead (automations.id=2b0153f2,
// cadence_value.time "15:15", next_run_at 2026-07-12 12:15:00+00 = 15:15
// Europe/Istanbul). Reproduced exactly: parseVoiceTime("3:15", <the real
// creation timestamp>) — i.e. first_run_text with no AM/PM marker — hits
// this function's own documented ambiguous-hour heuristic ("no AM/PM and
// hour 1–7 almost always means PM") and produces the identical 15:15
// result. These tests lock in correct AM/PM resolution — explicit markers
// must never invert — as a baseline the createAutomation-level
// disambiguation fix (ElevenLabsAgentWidget.tsx) builds on; that fix
// (verified in the todo-tools test suite) ensures an explicit "AM" marker
// reaches this function in the first place for a morning-cadenced request.
describe("parseVoiceTime — AM/PM resolution (regression: confirmed 3:15 AM → 3:15 PM production inversion)", () => {
  // 2026-07-12 00:03:34 UTC = 2026-07-12 03:03:34 Europe/Istanbul — the
  // real creation timestamp for automations.id=2b0153f2.
  const now = new Date("2026-07-12T03:03:34");

  it("exact reproduction: a bare hour with no AM/PM marker (\"3:15\") is forced to PM by the ambiguous-hour heuristic", () => {
    const result = parseVoiceTime("3:15", now);
    expect(result.error).toBeUndefined();
    // Matches the real stored production row exactly: 15:15 local, today.
    expect(result.dueAt).toBe(new Date("2026-07-12T15:15:00").toISOString());
  });

  it('"3:15 AM" resolves to 03:15, never 15:15', () => {
    const result = parseVoiceTime("3:15 AM", now);
    expect(result.error).toBeUndefined();
    expect(result.dueAt).toBe(new Date("2026-07-12T03:15:00").toISOString());
  });

  it('"3:15 PM" resolves to 15:15, never 03:15', () => {
    const result = parseVoiceTime("3:15 PM", now);
    expect(result.error).toBeUndefined();
    expect(result.dueAt).toBe(new Date("2026-07-12T15:15:00").toISOString());
  });

  it('"12:15 AM" resolves to the 00:15 (midnight hour), not 12:15 (noon) — rolls to tomorrow since 00:15 today has already passed relative to "now" (03:03)', () => {
    const result = parseVoiceTime("12:15 AM", now);
    expect(result.error).toBeUndefined();
    expect(result.dueAt).toBe(new Date("2026-07-13T00:15:00").toISOString());
  });

  it('"12:15 PM" resolves to 12:15 (noon), not 00:15 (midnight)', () => {
    const result = parseVoiceTime("12:15 PM", now);
    expect(result.error).toBeUndefined();
    expect(result.dueAt).toBe(new Date("2026-07-12T12:15:00").toISOString());
  });

  it('"1:05 AM" resolves to 01:05, never 13:05', () => {
    const result = parseVoiceTime("1:05 AM", now);
    expect(result.error).toBeUndefined();
    expect(result.dueAt).toBe(new Date("2026-07-13T01:05:00").toISOString());
  });

  it('"1:05 PM" resolves to 13:05, never 01:05', () => {
    const result = parseVoiceTime("1:05 PM", now);
    expect(result.error).toBeUndefined();
    expect(result.dueAt).toBe(new Date("2026-07-12T13:05:00").toISOString());
  });

  it("near-midnight creation: requesting a time just after midnight, created just before midnight, still resolves to the correct AM hour today/tomorrow — never inverted to PM", () => {
    // now: 2026-07-11 23:58:00 local — 2 minutes before midnight.
    const nearMidnightNow = new Date("2026-07-11T23:58:00");
    const result = parseVoiceTime("12:01 AM", nearMidnightNow);
    expect(result.error).toBeUndefined();
    // 00:01 today (2026-07-11) has already passed (it's 23:58) — the "no
    // day specified" branch correctly rolls to tomorrow's 00:01, still AM.
    expect(result.dueAt).toBe(new Date("2026-07-12T00:01:00").toISOString());
  });

  it("confirms Europe/Istanbul is the resolved timezone for all of the above (matches the real production account's timezone)", () => {
    const result = parseVoiceTime("3:15 AM", now);
    expect(result.timezone).toBe("Europe/Istanbul");
  });

  it("no 12-hour inversion: for every hour 1-12 with both AM and PM stated explicitly, the two results are always exactly 12 hours apart, never equal and never off by a different amount", () => {
    for (let hour = 1; hour <= 12; hour++) {
      const amResult = parseVoiceTime(`${hour}:00 AM`, now);
      const pmResult = parseVoiceTime(`${hour}:00 PM`, now);
      expect(amResult.error).toBeUndefined();
      expect(pmResult.error).toBeUndefined();
      const diffMs = new Date(pmResult.dueAt).getTime() - new Date(amResult.dueAt).getTime();
      // Both may have independently rolled to the next day (the "no day
      // specified" branch), so compare only the time-of-day component via
      // modulo — the AM/PM offset itself must always be exactly 12 hours.
      const twelveHoursMs = 12 * 60 * 60 * 1000;
      const twentyFourHoursMs = 24 * 60 * 60 * 1000;
      const normalizedDiff = ((diffMs % twentyFourHoursMs) + twentyFourHoursMs) % twentyFourHoursMs;
      expect(normalizedDiff === twelveHoursMs || normalizedDiff === -twelveHoursMs + twentyFourHoursMs).toBe(true);
    }
  });
});
