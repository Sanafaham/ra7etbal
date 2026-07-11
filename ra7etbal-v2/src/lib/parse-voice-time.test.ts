import { describe, expect, it } from "vitest";
import { parseVoiceTime } from "./parse-voice-time";

// Confirmed production failure: a daily automation requested ~2 minutes
// ahead ("charge your phone" at 1:36 AM, created at 1:34 AM Europe/Istanbul)
// was scheduled for the following day instead of firing that morning.
// Reproduced directly against this function with the real timestamps:
// createAutomation's first_run_text (Carson's own tool-call argument)
// contained the literal word "tomorrow", which this absolute-time branch
// resolves literally by design (see the "critical fix" comment on the
// tomorrow branch below) — that is correct, intentional behavior for a
// one-time task, and is NOT changed here. The actual fix lives in
// createAutomation (ElevenLabsAgentWidget.tsx), which now snaps a
// recurring loop's first run back to today when this function resolves an
// explicit "tomorrow" but the same clock time is still safely ahead today.
// These tests lock in the exact inputs/outputs that fix depends on.
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

  it('resolves "tomorrow at 1:36 AM" to the next calendar day, even though the same clock time is still ahead today (documents the literal-"tomorrow" contract createAutomation must compensate for)', () => {
    const result = parseVoiceTime("tomorrow at 1:36 AM", now);
    expect(result.error).toBeUndefined();
    expect(result.dueAt).toBe(new Date("2026-07-13T01:36:00").toISOString());
    expect(result.parsedAs).toContain('day="tomorrow"');
  });

  it('a genuinely multi-day-ahead phrase like "next Friday" is unaffected by the createAutomation snap-back (it never resolves day="tomorrow")', () => {
    const result = parseVoiceTime("next Friday at 9 AM", now);
    expect(result.error).toBeUndefined();
    expect(result.parsedAs).not.toContain('day="tomorrow"');
    // 2026-07-12 is a Sunday; next Friday is 2026-07-17.
    expect(result.dueAt).toBe(new Date("2026-07-17T09:00:00").toISOString());
  });
});
