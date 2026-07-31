import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock("./supabase", () => ({
  supabase: { auth: { getSession: h.getSession } },
}));

import { fetchCalendarEvents, searchCalendarHistory } from "./calendar";

describe("calendar history client boundary", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    h.getSession.mockReset().mockResolvedValue({ data: { session: { access_token: "jwt-123" } } });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("uses the authenticated canonical route with explicit historical mode", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        events: [],
        search_start: "2025-07-31",
        search_end: "2026-07-30",
        result_count: 0,
        truncated: false,
        retrieved_at: "2026-07-31T12:00:00.000Z",
        message: "No matching calendar event was found in the searched period.",
      }),
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    await searchCalendarHistory({
      start_date: "2025-07-31",
      end_date: "2026-07-30",
      query: "Grace",
      limit: 5,
    });

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toContain("/api/google-calendar?");
    expect(url).toContain("range=historical");
    expect(url).toContain("start_date=2025-07-31");
    expect(url).toContain("end_date=2026-07-30");
    expect(url).toContain("query=Grace");
    expect(options.headers.Authorization).toBe("Bearer jwt-123");
    expect(options.cache).toBe("no-store");
  });

  it("does not silently call the upcoming path after a historical error", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ ok: false, code: "invalid_date", error: "Invalid date" }),
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await searchCalendarHistory({ start_date: "bad", end_date: "2026-06-30" });
    expect(result).toMatchObject({ ok: false, code: "invalid_date", events: [] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toContain("range=historical");
  });

  it("keeps existing upcoming fetch semantics unchanged", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ connected: true, events: [{ id: "future-1", title: "Tomorrow" }] }),
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await fetchCalendarEvents("tomorrow");
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/google-calendar?range=tomorrow",
      expect.objectContaining({ headers: { Authorization: "Bearer jwt-123" }, cache: "no-store" }),
    );
    expect(result).toMatchObject({ connected: true, events: [{ id: "future-1", title: "Tomorrow" }] });
  });
});
