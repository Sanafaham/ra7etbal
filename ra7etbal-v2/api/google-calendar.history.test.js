import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import handler, {
  finalizeHistoricalSearch,
  localDateBoundaryToIso,
  shapeHistoricalCalendarEvent,
  validateHistoricalSearchInput,
} from "./google-calendar.js";

function createRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status: vi.fn(function status(code) { this.statusCode = code; return this; }),
    json: vi.fn(function json(body) { this.body = body; return this; }),
    setHeader: vi.fn(function setHeader(name, value) { this.headers[name] = value; }),
    redirect: vi.fn(),
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function event(overrides = {}) {
  return {
    id: "event-1",
    summary: "Dentist appointment",
    start: { dateTime: "2026-05-12T11:00:00+03:00", timeZone: "Europe/Istanbul" },
    end: { dateTime: "2026-05-12T12:00:00+03:00", timeZone: "Europe/Istanbul" },
    ...overrides,
  };
}

function shape(item, query = "dentist") {
  return shapeHistoricalCalendarEvent(item, {
    query,
    profileTimezone: "Europe/Istanbul",
    searchStart: "2026-01-01",
    searchEnd: "2026-06-30",
  });
}

describe("historical calendar input validation", () => {
  it("accepts a bounded explicit date range and default limit", () => {
    expect(validateHistoricalSearchInput({ startDate: "2026-01-01", endDate: "2026-06-30" }))
      .toMatchObject({ ok: true, limit: 10 });
  });

  it("rejects malformed and impossible dates", () => {
    expect(validateHistoricalSearchInput({ startDate: "2026-02-30", endDate: "2026-03-01" }))
      .toMatchObject({ ok: false, code: "invalid_date" });
    expect(validateHistoricalSearchInput({ startDate: "05/01/2026", endDate: "2026-06-01" }))
      .toMatchObject({ ok: false, code: "invalid_date" });
  });

  it("rejects reversed and oversized ranges", () => {
    expect(validateHistoricalSearchInput({ startDate: "2026-06-02", endDate: "2026-06-01" }))
      .toMatchObject({ ok: false, code: "reversed_range" });
    expect(validateHistoricalSearchInput({ startDate: "2025-01-01", endDate: "2026-01-02" }))
      .toMatchObject({ ok: false, code: "range_too_large" });
  });

  it("rejects limits outside the bounded server range", () => {
    expect(validateHistoricalSearchInput({ startDate: "2026-01-01", endDate: "2026-01-02", limit: 21 }))
      .toMatchObject({ ok: false, code: "invalid_limit" });
  });
});

describe("historical calendar local dates and timezone", () => {
  it("uses the owner timezone for local midnight boundaries", () => {
    expect(localDateBoundaryToIso({ year: 2026, month: 7, day: 1 }, "Europe/Istanbul"))
      .toBe("2026-06-30T21:00:00.000Z");
    expect(localDateBoundaryToIso({ year: 2026, month: 1, day: 1 }, "America/New_York"))
      .toBe("2026-01-01T05:00:00.000Z");
  });

  it("preserves all-day local dates and reports the owner timezone", () => {
    const result = shape(event({
      summary: "Istanbul",
      start: { date: "2026-05-12" },
      end: { date: "2026-05-13" },
    }), "Istanbul");
    expect(result).toMatchObject({
      start: "2026-05-12",
      end: "2026-05-13",
      timezone: "Europe/Istanbul",
      all_day: true,
    });
  });
});

describe("historical calendar privacy-aware matching", () => {
  it("matches by title", () => {
    expect(shape(event(), "dentist")).toMatchObject({ match_reasons: ["title"] });
  });

  it("matches a person by attendee display name and returns only that attendee", () => {
    const result = shape(event({
      summary: "Lunch",
      attendees: [
        { displayName: "Grace", email: "grace@example.com" },
        { displayName: "Private Person", email: "private@example.com" },
      ],
    }), "Grace");
    expect(result.match_reasons).toContain("attendee");
    expect(result.matched_attendees).toEqual([{ display_name: "Grace" }]);
    expect(JSON.stringify(result)).not.toContain("grace@example.com");
    expect(JSON.stringify(result)).not.toContain("Private Person");
    expect(JSON.stringify(result)).not.toContain("private@example.com");
  });

  it("matches attendee email when explicitly queried", () => {
    const result = shape(event({
      summary: "Lunch",
      attendees: [{ displayName: "Grace", email: "grace@example.com" }],
    }), "grace@example.com");
    expect(result.match_reasons).toContain("attendee");
    expect(result.matched_attendees[0].email).toBe("grace@example.com");
  });

  it("matches by location", () => {
    expect(shape(event({ summary: "Lunch", location: "Mikla, Istanbul" }), "Mikla"))
      .toMatchObject({ match_reasons: ["location"], location: "Mikla, Istanbul" });
  });

  it("matches by topic in description and bounds the relevant excerpt", () => {
    const description = `${"private preface ".repeat(30)}Christopher discussed the June documents.${" trailing detail".repeat(30)}`;
    const result = shape(event({ summary: "Meeting", description }), "documents");
    expect(result.match_reasons).toContain("description");
    expect(result.relevant_description_excerpt).toContain("documents");
    expect(result.relevant_description_excerpt.length).toBeLessThanOrEqual(242);
    expect(result.relevant_description_excerpt).not.toBe(description);
  });

  it("filters unrelated events instead of exposing their details", () => {
    expect(shape(event({
      summary: "Private medical detail",
      location: "Private clinic",
      description: "Unrelated sensitive content",
      attendees: [{ displayName: "Unrelated Person", email: "unrelated@example.com" }],
    }), "Grace")).toBeNull();
  });

  it("uses date_range as evidence when the user intentionally supplies no query", () => {
    expect(shape(event(), "")).toMatchObject({ match_reasons: ["date_range"] });
  });
});

describe("historical calendar result truthfulness", () => {
  const base = {
    events: [],
    limit: 10,
    searchStart: "2026-01-01",
    searchEnd: "2026-06-30",
    retrievedAt: "2026-07-31T12:00:00.000Z",
  };

  it("uses the required no-match wording for a complete search", () => {
    expect(finalizeHistoricalSearch({ ...base, truncated: false })).toMatchObject({
      message: "No matching calendar event was found in the searched period.",
      result_count: 0,
      truncated: false,
    });
  });

  it("never turns a truncated empty search into a definitive no-match", () => {
    const result = finalizeHistoricalSearch({ ...base, truncated: true });
    expect(result.truncated).toBe(true);
    expect(result.message).toMatch(/incomplete/i);
    expect(result.message).not.toBe("No matching calendar event was found in the searched period.");
  });

  it("returns ambiguous matches newest first without collapsing them", () => {
    const first = shape(event({ id: "old", start: { dateTime: "2026-02-01T10:00:00+03:00" } }), "dentist");
    const second = shape(event({ id: "new", start: { dateTime: "2026-05-01T10:00:00+03:00" } }), "dentist");
    const result = finalizeHistoricalSearch({ ...base, events: [first, second], truncated: false });
    expect(result.result_count).toBe(2);
    expect(result.events.map((item) => item.event_id)).toEqual(["new", "old"]);
  });
});

describe("historical calendar authenticated route", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.stubEnv("SUPABASE_ANON_KEY", "anon-key");
    vi.stubEnv("GOOGLE_CLIENT_ID", "client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("handles pagination, single-event expansion, newest-first results, and truncation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: "user-1" }))
      .mockResolvedValueOnce(jsonResponse([{ google_refresh_token: "refresh", morning_brief_timezone: "Europe/Istanbul" }]))
      .mockResolvedValueOnce(jsonResponse({ access_token: "access" }))
      .mockResolvedValueOnce(jsonResponse({ items: [event({ id: "page-1" })], nextPageToken: "next" }))
      .mockResolvedValueOnce(jsonResponse({ items: [event({ id: "page-2", start: { dateTime: "2026-06-12T11:00:00+03:00" } })] }));
    vi.stubGlobal("fetch", fetchMock);

    const req = {
      method: "GET",
      query: { range: "historical", start_date: "2026-01-01", end_date: "2026-06-30", query: "dentist", limit: "1" },
      headers: { authorization: "Bearer jwt" },
    };
    const res = createRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.result_count).toBe(1);
    expect(res.body.events[0].event_id).toBe("page-2");
    expect(res.body.truncated).toBe(true);
    const firstGoogleUrl = fetchMock.mock.calls[3][0];
    const secondGoogleUrl = fetchMock.mock.calls[4][0];
    expect(firstGoogleUrl).toContain("singleEvents=true");
    expect(firstGoogleUrl).toContain("q=dentist");
    expect(secondGoogleUrl).toContain("pageToken=next");
  });

  it("cannot silently fall back to upcoming search when historical input is invalid", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const req = {
      method: "GET",
      query: { range: "historical", start_date: "bad", end_date: "2026-06-30" },
      headers: { authorization: "Bearer jwt" },
    };
    const res = createRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe("invalid_date");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports an incomplete search instead of definitive no-match when the pagination cap is reached", async () => {
    const unrelated = event({ id: "private", summary: "Unrelated private event" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: "user-1" }))
      .mockResolvedValueOnce(jsonResponse([{ google_refresh_token: "refresh", morning_brief_timezone: "Europe/Istanbul" }]))
      .mockResolvedValueOnce(jsonResponse({ access_token: "access" }))
      .mockResolvedValueOnce(jsonResponse({ items: [unrelated], nextPageToken: "page-2" }))
      .mockResolvedValueOnce(jsonResponse({ items: [unrelated], nextPageToken: "page-3" }))
      .mockResolvedValueOnce(jsonResponse({ items: [unrelated], nextPageToken: "page-4" }))
      .mockResolvedValueOnce(jsonResponse({ items: [unrelated], nextPageToken: "page-5" }));
    vi.stubGlobal("fetch", fetchMock);

    const req = {
      method: "GET",
      query: { range: "historical", start_date: "2026-01-01", end_date: "2026-06-30", query: "Grace" },
      headers: { authorization: "Bearer jwt" },
    };
    const res = createRes();
    await handler(req, res);

    expect(res.body).toMatchObject({ result_count: 0, truncated: true });
    expect(res.body.message).toMatch(/incomplete/i);
    expect(res.body.message).not.toBe("No matching calendar event was found in the searched period.");
    expect(JSON.stringify(res.body)).not.toContain("Unrelated private event");
  });
});
