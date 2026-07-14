import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEvent } from "./calendar";

const insertMock = vi.fn();
const selectEqCallsMock = vi.fn();

vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } } }),
    },
    from: vi.fn(() => ({
      insert: (payload: unknown) => {
        insertMock(payload);
        return {
          select: vi.fn(() => ({ single: vi.fn().mockResolvedValue({ data: { id: "plan-1" }, error: null }) })),
        };
      },
      update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })),
      select: vi.fn(() => {
        const chain = {
          eq: (...args: unknown[]) => {
            selectEqCallsMock(...args);
            return chain;
          },
          gt: vi.fn(() => chain),
          order: vi.fn(() => chain),
          limit: vi.fn(() => chain),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
        return chain;
      }),
    })),
  },
}));

const createCalendarEventMock = vi.fn();
const fetchCalendarEventsMock = vi.fn();
vi.mock("./calendar", () => ({
  createCalendarEvent: (...args: unknown[]) => createCalendarEventMock(...args),
  fetchCalendarEvents: (...args: unknown[]) => fetchCalendarEventsMock(...args),
}));

import {
  buildWeekPlan,
  detectWeeklyPlanningIntent,
  dropConflictingEvents,
  executeWeekPlan,
  findSchedulingConflicts,
  isWeekPlanExpired,
  isWeekPlanRetryRequest,
  loadLatestPendingWeekPlan,
  type ProposedCalendarEvent,
  type ProposedWeekPlan,
  type WeekPlanContext,
  type WeekEventResult,
} from "./weekly-planning";

function baseCtx(overrides: Partial<WeekPlanContext> = {}): WeekPlanContext {
  return {
    sourceText: "Carson, organize my week",
    calendarEvents: [],
    todosBlock: "",
    needsAttentionBlock: "",
    waitingBlock: "",
    automationStatusBlock: "",
    householdRules: "",
    persistentMemory: "",
    timezone: "Europe/Istanbul",
    now: new Date("2026-07-14T08:00:00.000Z"),
    ...overrides,
  };
}

function mockAnthropicResponse(json: unknown) {
  return {
    ok: true,
    json: async () => ({ content: [{ type: "text", text: JSON.stringify(json) }] }),
  };
}

describe("detectWeeklyPlanningIntent", () => {
  it.each([
    "Carson, organize my week",
    "can you organize my week?",
    "plan my week please",
    "help me plan the week",
    "map out this week for me",
  ])('detects "%s"', (text) => {
    expect(detectWeeklyPlanningIntent(text)).toBe(true);
  });

  it.each([
    "what's on my to-do list?",
    "remind me to call mom",
    "organize my desk",
    "plan a trip to Paris",
  ])('does not falsely trigger on "%s"', (text) => {
    expect(detectWeeklyPlanningIntent(text)).toBe(false);
  });
});

describe("isWeekPlanRetryRequest", () => {
  it.each(["try again", "retry", "please retry", "redo those", "attempt that again"])(
    'detects "%s" as a retry request',
    (text) => {
      expect(isWeekPlanRetryRequest(text)).toBe(true);
    },
  );

  it("does not flag an unrelated message", () => {
    expect(isWeekPlanRetryRequest("what's on my calendar")).toBe(false);
  });
});

describe("isWeekPlanExpired", () => {
  const plan = (createdAt: number): ProposedWeekPlan => ({
    events: [],
    proposalSpeech: "",
    sourceText: "",
    createdAt,
  });

  it("is not expired within 10 minutes", () => {
    const now = Date.parse("2026-07-14T12:10:00.000Z");
    expect(isWeekPlanExpired(plan(Date.parse("2026-07-14T12:00:00.000Z")), now)).toBe(false);
  });

  it("is expired after 10 minutes", () => {
    const now = Date.parse("2026-07-14T12:11:00.000Z");
    expect(isWeekPlanExpired(plan(Date.parse("2026-07-14T12:00:00.000Z")), now)).toBe(true);
  });
});

describe("findSchedulingConflicts / dropConflictingEvents", () => {
  // findSchedulingConflicts parses proposed events' date/time in the
  // browser's local timezone (matches the user's real timezone in
  // production — see toRangeMs). Building the "existing" mock's start/end
  // via local Date construction + toISOString() (rather than a hardcoded
  // "Z" literal) keeps this test's expectations correct regardless of which
  // timezone the test runner happens to execute in.
  const existing: CalendarEvent[] = [
    {
      id: "ev-1",
      title: "Dentist",
      start: new Date(2026, 6, 20, 9, 0, 0).toISOString(),
      end: new Date(2026, 6, 20, 10, 0, 0).toISOString(),
      location: null,
      allDay: false,
    },
  ];

  function proposedEvent(overrides: Partial<ProposedCalendarEvent> = {}): ProposedCalendarEvent {
    return {
      id: "prop-1",
      title: "Deep work",
      date: "2026-07-20",
      time: "09:30",
      durationMinutes: 60,
      ...overrides,
    };
  }

  it("flags a proposed slot that overlaps an existing event", () => {
    const proposed = [proposedEvent()];
    expect(findSchedulingConflicts(proposed, existing)).toEqual(proposed);
  });

  it("does not flag a proposed slot that does not overlap", () => {
    const proposed = [proposedEvent({ time: "11:00" })];
    expect(findSchedulingConflicts(proposed, existing)).toEqual([]);
  });

  it("drops only the conflicting event, keeping the rest", () => {
    const clean = proposedEvent({ id: "prop-clean", time: "11:00" });
    const conflicting = proposedEvent({ id: "prop-conflict", time: "09:30" });
    const result = dropConflictingEvents([clean, conflicting], existing);
    expect(result).toEqual([clean]);
  });

  it("all-day existing events never block a timed proposal", () => {
    const allDay: CalendarEvent[] = [
      { id: "ev-2", title: "Public holiday", start: "2026-07-20", end: null, location: null, allDay: true },
    ];
    expect(findSchedulingConflicts([proposedEvent()], allDay)).toEqual([]);
  });
});

describe("executeWeekPlan", () => {
  beforeEach(() => {
    createCalendarEventMock.mockReset();
    fetchCalendarEventsMock.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  function plan(events: ProposedCalendarEvent[], dbId = "plan-1"): ProposedWeekPlan {
    return { dbId, events, proposalSpeech: "Shall I add this plan to your calendar?", sourceText: "organize my week", createdAt: Date.now() };
  }

  it("creates every event and reports full success once verified", async () => {
    const events: ProposedCalendarEvent[] = [
      { id: "e1", title: "Deep work", date: "2026-07-20", time: "09:00", durationMinutes: 60 },
      { id: "e2", title: "Gym", date: "2026-07-21", time: "07:00", durationMinutes: 45 },
    ];
    createCalendarEventMock
      .mockResolvedValueOnce({ ok: true, id: "g1" })
      .mockResolvedValueOnce({ ok: true, id: "g2" });
    fetchCalendarEventsMock.mockResolvedValue({
      connected: true,
      events: [
        { id: "g1", title: "Deep work", start: "2026-07-20T09:00:00Z", end: null, location: null, allDay: false },
        { id: "g2", title: "Gym", start: "2026-07-21T07:00:00Z", end: null, location: null, allDay: false },
      ],
    });

    const { summary, results } = await executeWeekPlan(plan(events));
    expect(results.every((r) => r.status === "created")).toBe(true);
    expect(summary).toBe("Added 2 events to your calendar for this week.");
  });

  it("reports partial failure truthfully, naming exactly which events failed", async () => {
    const events: ProposedCalendarEvent[] = [
      { id: "e1", title: "Deep work", date: "2026-07-20", time: "09:00", durationMinutes: 60 },
      { id: "e2", title: "Gym", date: "2026-07-21", time: "07:00", durationMinutes: 45 },
    ];
    createCalendarEventMock
      .mockResolvedValueOnce({ ok: true, id: "g1" })
      .mockResolvedValueOnce({ ok: false, code: "calendar_error" });
    fetchCalendarEventsMock.mockResolvedValue({
      connected: true,
      events: [{ id: "g1", title: "Deep work", start: "2026-07-20T09:00:00Z", end: null, location: null, allDay: false }],
    });

    const { summary, results } = await executeWeekPlan(plan(events));
    expect(results.find((r) => r.id === "e1")?.status).toBe("created");
    expect(results.find((r) => r.id === "e2")?.status).toBe("failed");
    expect(summary).toContain("Added 1 event");
    expect(summary).toContain("Gym");
  });

  it("downgrades a reported success to verified_missing when the re-read calendar doesn't show it", async () => {
    // createCalendarEvent returning ok:true is not sufficient on its own —
    // executeWeekPlan must re-read the calendar and only report success
    // once the event is confirmed to actually be there.
    const events: ProposedCalendarEvent[] = [
      { id: "e1", title: "Deep work", date: "2026-07-20", time: "09:00", durationMinutes: 60 },
    ];
    createCalendarEventMock.mockResolvedValueOnce({ ok: true, id: "g1" });
    fetchCalendarEventsMock.mockResolvedValue({ connected: true, events: [] }); // g1 absent

    const { results } = await executeWeekPlan(plan(events));
    expect(results[0].status).toBe("verified_missing");
  });

  it("never recreates an event already confirmed created on retry", async () => {
    const events: ProposedCalendarEvent[] = [
      { id: "e1", title: "Deep work", date: "2026-07-20", time: "09:00", durationMinutes: 60 },
      { id: "e2", title: "Gym", date: "2026-07-21", time: "07:00", durationMinutes: 45 },
    ];
    const previousResults: WeekEventResult[] = [
      { id: "e1", title: "Deep work", date: "2026-07-20", time: "09:00", status: "created", googleEventId: "g1" },
      { id: "e2", title: "Gym", date: "2026-07-21", time: "07:00", status: "failed", error: "calendar_error" },
    ];
    createCalendarEventMock.mockResolvedValueOnce({ ok: true, id: "g2" });
    fetchCalendarEventsMock.mockResolvedValue({
      connected: true,
      events: [
        { id: "g1", title: "Deep work", start: "2026-07-20T09:00:00Z", end: null, location: null, allDay: false },
        { id: "g2", title: "Gym", start: "2026-07-21T07:00:00Z", end: null, location: null, allDay: false },
      ],
    });

    const { results } = await executeWeekPlan(plan(events), previousResults);

    // createCalendarEvent must only be called once — for the retried event.
    expect(createCalendarEventMock).toHaveBeenCalledTimes(1);
    expect(createCalendarEventMock).toHaveBeenCalledWith("Gym", "2026-07-21", "07:00", 45);
    expect(results.find((r) => r.id === "e1")?.status).toBe("created");
    expect(results.find((r) => r.id === "e2")?.status).toBe("created");
  });

  // CodeRabbit finding: createCalendarEvent reporting ok:true doesn't
  // guarantee the event is immediately visible in a re-read (Google Calendar
  // eventual consistency) — auto-retrying a "verified_missing" result could
  // create a real duplicate of an event that actually was created the first
  // time. It must be treated exactly like "created": never re-attempted.
  it("never retries a verified_missing event either, since it may have actually succeeded", async () => {
    const events: ProposedCalendarEvent[] = [
      { id: "e1", title: "Deep work", date: "2026-07-20", time: "09:00", durationMinutes: 60 },
    ];
    const previousResults: WeekEventResult[] = [
      { id: "e1", title: "Deep work", date: "2026-07-20", time: "09:00", status: "verified_missing", googleEventId: "g1" },
    ];
    fetchCalendarEventsMock.mockResolvedValue({ connected: true, events: [] });

    const { results } = await executeWeekPlan(plan(events), previousResults);

    expect(createCalendarEventMock).not.toHaveBeenCalled();
    expect(results.find((r) => r.id === "e1")?.status).toBe("verified_missing");
  });
});

describe("buildWeekPlan", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    insertMock.mockClear();
  });

  it("proposes a plan with zero clarification questions when there's enough context", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockAnthropicResponse({
          needs_clarification: false,
          events: [{ title: "Finish report", date: "2026-07-15", time: "10:00", duration_minutes: 90 }],
          proposal_speech: "I'll block Tuesday morning for the report. Shall I add this plan to your calendar?",
        }),
      ),
    );

    const result = await buildWeekPlan(
      baseCtx({ todosBlock: "- Finish report (due Wed)" }),
    );
    expect(result.status).toBe("proposed");
    if (result.status === "proposed") {
      expect(result.plan.events).toHaveLength(1);
      expect(result.plan.proposalSpeech).toContain("Shall I add this plan to your calendar?");
    }
  });

  it("asks exactly one combined clarification question when essential context is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockAnthropicResponse({
          needs_clarification: true,
          clarification_question:
            "You don't have any to-dos or events yet this week — what would you like to focus on, and what are your usual working hours?",
        }),
      ),
    );

    const result = await buildWeekPlan(baseCtx());
    expect(result.status).toBe("clarification_needed");
    if (result.status === "clarification_needed") {
      expect(result.question).toContain("what would you like to focus on");
    }
  });

  it("drops a model-proposed event that conflicts with a real existing event, keeping the rest", async () => {
    const existing: CalendarEvent[] = [
      {
        id: "ev-1",
        title: "Dentist",
        start: new Date(2026, 6, 15, 10, 0, 0).toISOString(),
        end: new Date(2026, 6, 15, 11, 0, 0).toISOString(),
        location: null,
        allDay: false,
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockAnthropicResponse({
          needs_clarification: false,
          events: [
            { title: "Conflicts with dentist", date: "2026-07-15", time: "10:00", duration_minutes: 60 },
            { title: "Deep work", date: "2026-07-15", time: "13:00", duration_minutes: 60 },
          ],
          proposal_speech: "Shall I add this plan to your calendar?",
        }),
      ),
    );

    const result = await buildWeekPlan(baseCtx({ calendarEvents: existing }));
    expect(result.status).toBe("proposed");
    if (result.status === "proposed") {
      expect(result.plan.events).toHaveLength(1);
      expect(result.plan.events[0].title).toBe("Deep work");
    }
  });

  it("passes the caller's timezone into the planning prompt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockAnthropicResponse({
        needs_clarification: false,
        events: [{ title: "Focus block", date: "2026-07-15", time: "09:00" }],
        proposal_speech: "Shall I add this plan to your calendar?",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await buildWeekPlan(baseCtx({ timezone: "America/New_York" }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const promptText = body.messages[0].content as string;
    expect(promptText).toContain("America/New_York");
  });

  it("persists the proposed plan scoped to the signed-in user and type weekly_plan", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockAnthropicResponse({
          needs_clarification: false,
          events: [{ title: "Focus block", date: "2026-07-15", time: "09:00" }],
          proposal_speech: "Shall I add this plan to your calendar?",
        }),
      ),
    );

    await buildWeekPlan(baseCtx());
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: "user-1", type: "weekly_plan" }),
    );
  });
});

describe("loadLatestPendingWeekPlan — user isolation", () => {
  it("scopes the query to the signed-in user's id and the weekly_plan type", async () => {
    selectEqCallsMock.mockClear();
    await loadLatestPendingWeekPlan();
    const calls = selectEqCallsMock.mock.calls;
    expect(calls).toContainEqual(["user_id", "user-1"]);
    expect(calls).toContainEqual(["type", "weekly_plan"]);
  });
});
