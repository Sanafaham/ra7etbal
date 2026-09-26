/**
 * Stale elapsed calendar event spoken as upcoming — Production truthfulness
 * regression (2026-09-26).
 *
 * At ~18:38 Europe/Zurich Carson told Sana "You also have Hairdresser
 * Appointment at 4:00 PM" for a 16:00-17:00 event that had ended 1 h 38 min
 * earlier (Google Calendar `ma7tirqvhngn73f83l8s7mol1k`, conversation
 * `conv_1301m3f99zm3ev8raw51hpsv9k56`). The same payload's `ra7etbal_state`
 * already said "Past: Hairdresser Appointment, ended 5:00 PM", so the
 * authoritative classification existed and the spoken slot simply did not
 * consult it. The identical failure occurred on 2026-09-25 with a Doctor's
 * Appointment, before PR #412 — this defect is independent of P3 5b.
 *
 * These tests exercise the real spoken opening (buildMorningBriefSpoken), not
 * an internal helper, because the defect was only ever visible in the spoken
 * output.
 */

import { describe, expect, it, vi } from "vitest";

// morning-brief.ts reaches ./supabase at module load via calendar.ts /
// automation-context.ts. Stubbed exactly as the sibling suites do; every
// function exercised here is pure.
vi.mock("./supabase", () => ({ supabase: {} }));

const { buildMorningBriefSpoken } = await import("./morning-brief");
const { buildCarsonContext } = await import("./carson-context");
const { classifyCalendarEvent } = await import("./calendar");
const { buildNightSweepSpoken } = await import("./night-sweep");

import type { CalendarEvent } from "./calendar";
import type { Task } from "../types/task";
import type { AutomationDigest } from "./automation-context";

/**
 * Europe/Zurich fixtures. The suite runs under TZ=UTC, so local wall-clock is
 * expressed through explicit +02:00 / +01:00 offsets and the resulting Date is
 * what the builder compares against — the same comparison Production made.
 */
function ev(over: Partial<CalendarEvent> & { id: string; title: string }): CalendarEvent {
  return { start: null, end: null, location: null, allDay: false, ...over };
}

/** The real Production event. */
const HAIRDRESSER = ev({
  id: "ma7tirqvhngn73f83l8s7mol1k",
  title: "Hairdresser Appointment",
  start: "2026-09-26T16:00:00+02:00",
  end: "2026-09-26T17:00:00+02:00",
});

/** 18:38:23 Europe/Zurich — the exact moment Carson spoke. */
const NOW_1838 = new Date("2026-09-26T16:38:23Z");

function digest(): AutomationDigest {
  return {
    pending: [], escalated: [], failed: [], confirmedToday: [],
    firingToday: [], firingTomorrow: [], routineAutomationTaskIds: new Set(),
  };
}

function spoken(events: CalendarEvent[], now: Date, tasks: Task[] = []): string {
  return buildMorningBriefSpoken(tasks, [], "Sana", now, events, digest(), []);
}

describe("production regression — the 2026-09-26 Hairdresser Appointment", () => {
  it("never speaks an already-ended appointment as though it is still ahead", () => {
    const out = spoken([HAIRDRESSER], NOW_1838);

    expect(out).not.toContain("You also have Hairdresser Appointment at 4:00 PM");
    expect(out).not.toContain("Hairdresser Appointment at 4:00 PM");
    // The elapsed event must not reach the upcoming/current calendar slot at all.
    expect(out).not.toContain("You also have Hairdresser Appointment");
    expect(out).not.toContain("You're currently in Hairdresser Appointment");
  });

  it("proves the classifier already knew, so no second notion of calendar truth was added", () => {
    expect(classifyCalendarEvent(HAIRDRESSER, NOW_1838)).toBe("past");
  });

  it("says something truthful about the rest of the day instead of claiming the calendar was clear", () => {
    const out = spoken([HAIRDRESSER], NOW_1838);

    // An appointment DID happen today — denying it is its own falsehood.
    expect(out).not.toContain("Your calendar is clear today");
    expect(out).toContain("Nothing else on your calendar today");
  });

  it("reproduces the 2026-09-25 Doctor's Appointment shape identically", () => {
    const doctor = ev({
      id: "doctor-1",
      title: "Doctor's Appointment",
      start: "2026-09-25T16:00:00+02:00",
      end: "2026-09-25T17:00:00+02:00",
    });

    const out = spoken([doctor], new Date("2026-09-25T16:40:14Z"));

    expect(out).not.toContain("You also have Doctor's Appointment at 4:00 PM");
    expect(out).toContain("Nothing else on your calendar today");
  });
});

describe("upcoming, in-progress and all-day behavior is preserved", () => {
  it("still speaks an event that is later today", () => {
    const later = ev({
      id: "later",
      title: "Dentist",
      start: "2026-09-26T20:00:00+02:00",
      end: "2026-09-26T21:00:00+02:00",
    });

    expect(spoken([later], NOW_1838)).toContain("You also have Dentist at");
  });

  it("still speaks an in-progress event with its wrap-up time", () => {
    const running = ev({
      id: "running",
      title: "Team Sync",
      start: "2026-09-26T18:00:00+02:00",
      end: "2026-09-26T19:00:00+02:00",
    });

    expect(classifyCalendarEvent(running, NOW_1838)).toBe("in_progress");
    expect(spoken([running], NOW_1838)).toContain("You're currently in Team Sync");
  });

  it("an in-progress event is never suppressed by an elapsed one alongside it", () => {
    const running = ev({
      id: "running",
      title: "Team Sync",
      start: "2026-09-26T18:00:00+02:00",
      end: "2026-09-26T19:00:00+02:00",
    });

    const out = spoken([HAIRDRESSER, running], NOW_1838);

    expect(out).toContain("You're currently in Team Sync");
    expect(out).not.toContain("Hairdresser Appointment at");
  });

  it("preserves all-day semantics — an all-day event stays eligible all day", () => {
    const allDay = ev({ id: "allday", title: "Public Holiday", start: "2026-09-26", allDay: true });

    expect(classifyCalendarEvent(allDay, NOW_1838)).toBe("upcoming");
    const out = spoken([allDay], NOW_1838);
    expect(out).toContain("Public Holiday");
    expect(out).not.toContain("Nothing else on your calendar today");
  });

  it("keeps the clear-calendar wording when there genuinely are no events", () => {
    expect(spoken([], NOW_1838)).toContain("Your calendar is clear today");
  });
});

describe("mixed and multiple events", () => {
  it("excludes the elapsed event and keeps the future one", () => {
    const later = ev({
      id: "later",
      title: "Dentist",
      start: "2026-09-26T20:00:00+02:00",
      end: "2026-09-26T21:00:00+02:00",
    });

    const out = spoken([HAIRDRESSER, later], NOW_1838);

    expect(out).toContain("You also have Dentist at");
    expect(out).not.toContain("Hairdresser");
  });

  it("counts only what is still ahead, never the elapsed ones", () => {
    const a = ev({ id: "a", title: "Dentist", start: "2026-09-26T20:00:00+02:00", end: "2026-09-26T20:30:00+02:00" });
    const b = ev({ id: "b", title: "Call", start: "2026-09-26T21:00:00+02:00", end: "2026-09-26T21:30:00+02:00" });

    // Three events today, but only two remain.
    const out = spoken([HAIRDRESSER, a, b], NOW_1838);

    expect(out).toContain("two events on the calendar today");
    expect(out).not.toContain("three events");
  });

  it("preserves multi-event wording when nothing has elapsed yet", () => {
    const a = ev({ id: "a", title: "Dentist", start: "2026-09-26T20:00:00+02:00", end: "2026-09-26T20:30:00+02:00" });
    const b = ev({ id: "b", title: "Call", start: "2026-09-26T21:00:00+02:00", end: "2026-09-26T21:30:00+02:00" });

    const early = new Date("2026-09-26T06:00:00Z"); // 08:00 Europe/Zurich
    expect(spoken([a, b], early)).toContain("two events on the calendar today");
  });
});

describe("local-date, midnight and DST boundaries", () => {
  it("a yesterday event cannot leak into today's spoken calendar", () => {
    const yesterday = ev({
      id: "y",
      title: "Old Meeting",
      start: "2026-09-25T20:00:00+02:00",
      end: "2026-09-25T21:00:00+02:00",
    });

    const out = spoken([yesterday], NOW_1838);

    expect(out).not.toContain("Old Meeting");
    // Not today's business at all — so the calendar is genuinely clear today.
    expect(out).toContain("Your calendar is clear today");
  });

  it("just after local midnight, a late event from the previous day does not carry over", () => {
    // Day membership is computed in the RUNTIME timezone (Europe/Zurich in
    // Production, UTC under this suite), whereas the elapsed check is absolute
    // time. This case exercises day membership, so it is framed in runtime-local
    // terms — otherwise it would silently assert nothing.
    const lateYesterday = ev({
      id: "ly",
      title: "Night Call",
      start: "2026-09-25T23:00:00Z",
      end: "2026-09-25T23:30:00Z",
    });

    const justAfterMidnight = new Date("2026-09-26T00:10:00Z");
    const out = spoken([lateYesterday], justAfterMidnight);

    expect(out).not.toContain("Night Call");
    expect(out).toContain("Your calendar is clear today");
  });

  it("an event earlier on the SAME runtime-local day is elapsed, not carried over as upcoming", () => {
    // The complement of the case above: same local day, already ended.
    const earlierToday = ev({
      id: "et",
      title: "Morning Call",
      start: "2026-09-26T08:00:00Z",
      end: "2026-09-26T09:00:00Z",
    });

    const out = spoken([earlierToday], new Date("2026-09-26T16:38:23Z"));

    expect(out).not.toContain("You also have Morning Call");
    expect(out).toContain("Nothing else on your calendar today");
  });

  it("an event still ahead one minute before its start is spoken; one minute after its end it is not", () => {
    const before = new Date("2026-09-26T13:59:00Z"); // 15:59 local — 1 min before 16:00
    const after = new Date("2026-09-26T15:01:00Z"); // 17:01 local — 1 min after 17:00

    expect(classifyCalendarEvent(HAIRDRESSER, before)).toBe("upcoming");
    expect(spoken([HAIRDRESSER], before)).toContain("You also have Hairdresser Appointment at");

    expect(classifyCalendarEvent(HAIRDRESSER, after)).toBe("past");
    expect(spoken([HAIRDRESSER], after)).not.toContain("You also have Hairdresser Appointment");
  });

  it("holds across the Europe/Zurich DST change (CET, UTC+1)", () => {
    // 2026-11-10 is after the autumn change — Zurich is UTC+1.
    const winterEvent = ev({
      id: "w",
      title: "Winter Meeting",
      start: "2026-11-10T16:00:00+01:00",
      end: "2026-11-10T17:00:00+01:00",
    });
    const winterNow = new Date("2026-11-10T17:38:00Z"); // 18:38 local

    expect(classifyCalendarEvent(winterEvent, winterNow)).toBe("past");
    expect(spoken([winterEvent], winterNow)).not.toContain("You also have Winter Meeting");
  });
});

describe("boundaries this correction must not cross", () => {
  it("leaves ra7etbal_state's Past/Upcoming classification untouched", () => {
    const later = ev({
      id: "later",
      title: "Dentist",
      start: "2026-09-26T20:00:00+02:00",
      end: "2026-09-26T21:00:00+02:00",
    });

    const context = buildCarsonContext({
      tasks: [],
      people: [],
      now: NOW_1838,
      calendarEvents: [HAIRDRESSER, later],
    });

    // The already-correct branch keeps rendering the elapsed event as history.
    expect(context).toContain("- Past: Hairdresser Appointment");
    expect(context).toContain("- Upcoming:");
    expect(context).toContain("Dentist");
  });

  it("has no notion of event status, so cancellation semantics are unchanged", () => {
    // CalendarEvent carries no status field — cancelled events are excluded
    // upstream, never here. The slot reacts only to start/end/allDay.
    expect(Object.keys(HAIRDRESSER).sort()).toEqual(
      ["allDay", "end", "id", "location", "start", "title"],
    );
  });

  it("does not mutate the caller's event array or the event objects", () => {
    const events = [HAIRDRESSER, ev({ id: "later", title: "Dentist", start: "2026-09-26T20:00:00+02:00", end: "2026-09-26T21:00:00+02:00" })];
    const snapshot = JSON.stringify(events);

    spoken(events, NOW_1838);

    expect(JSON.stringify(events)).toBe(snapshot);
    expect(events).toHaveLength(2);
  });
});

describe("Night Sweep — evidence that it does not share this defect", () => {
  /**
   * Night Sweep was inspected and NOT modified. Its two calendar consumers are
   * already safe by construction:
   *   - buildUpcomingDeadline() selects with
   *     `classifyCalendarEvent(ev, now) === "upcoming"`, so an elapsed event is
   *     excluded before it can be spoken.
   *   - buildNightSweepSpoken()'s `tomorrowEvs` is bounded to
   *     [tomorrowStart, dayAfterStart), which an event earlier today cannot enter.
   * These tests pin that, so a future change to either cannot silently acquire
   * the Morning Brief defect.
   */
  const evening = new Date("2026-09-26T19:30:00Z"); // 21:30 Europe/Zurich

  it("never speaks an elapsed same-day event as upcoming or current", () => {
    const out = buildNightSweepSpoken([], "Sana", evening, [HAIRDRESSER], digest(), []);

    expect(out).not.toContain("Hairdresser Appointment at");
    expect(out).not.toContain("You also have Hairdresser Appointment");
    expect(out).not.toContain("Hairdresser Appointment is tomorrow");
  });

  it("still surfaces a genuinely upcoming event", () => {
    const tomorrow = ev({
      id: "tm",
      title: "Board Review",
      start: "2026-09-27T10:00:00+02:00",
      end: "2026-09-27T11:00:00+02:00",
    });

    expect(buildNightSweepSpoken([], "Sana", evening, [tomorrow], digest(), [])).toContain("Board Review");
  });

  it("an elapsed today event cannot enter the tomorrow bucket", () => {
    const withBoth = buildNightSweepSpoken(
      [],
      "Sana",
      evening,
      [HAIRDRESSER, ev({ id: "tm", title: "Board Review", start: "2026-09-27T10:00:00+02:00", end: "2026-09-27T11:00:00+02:00" })],
      digest(),
      [],
    );

    expect(withBoth).toContain("Board Review");
    expect(withBoth).not.toContain("Hairdresser");
  });
});
