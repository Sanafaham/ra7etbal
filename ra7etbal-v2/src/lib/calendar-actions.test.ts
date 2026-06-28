import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("./supabase", () => ({
  supabase: { auth: { getSession: h.getSession } },
}));

import { callCalendarApi } from "./calendar-actions";

describe("callCalendarApi", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    h.getSession.mockReset();
    h.getSession.mockResolvedValue({ data: { session: { access_token: "jwt-123" } } });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns unauthenticated when there is no session JWT", async () => {
    h.getSession.mockResolvedValue({ data: { session: null } });
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await callCalendarApi("POST", { title: "Standup" });

    expect(result).toEqual({ ok: false, data: null, code: "unauthenticated" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the JWT, method, and body to /api/google-calendar", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      json: async () => ({ ok: true, id: "evt_1", title: "Standup" }),
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await callCalendarApi("POST", { title: "Standup", date: "2026-07-01", time: "09:00" });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/google-calendar",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer jwt-123" }),
        body: JSON.stringify({ title: "Standup", date: "2026-07-01", time: "09:00" }),
      }),
    );
    expect(result).toEqual({ ok: true, data: { ok: true, id: "evt_1", title: "Standup" } });
  });

  it("passes through server-side reconnect_required failures", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      json: async () => ({ ok: false, code: "reconnect_required" }),
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await callCalendarApi("PATCH", { event_id: "evt_1", title: "New title" });

    expect(result).toEqual({ ok: false, data: { ok: false, code: "reconnect_required" } });
  });

  it("passes through not_found failures for delete", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      json: async () => ({ ok: false, code: "not_found" }),
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await callCalendarApi("DELETE", { event_id: "evt_missing" });

    expect(result).toEqual({ ok: false, data: { ok: false, code: "not_found" } });
  });

  it("returns parse_error when the response body cannot be parsed as JSON", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      json: async () => {
        throw new Error("invalid json");
      },
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await callCalendarApi("POST", { title: "Standup" });

    expect(result).toEqual({ ok: false, data: null, code: "parse_error" });
  });

  it("returns network_error when fetch throws", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("offline"));
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await callCalendarApi("DELETE", { event_id: "evt_1" });

    expect(result).toEqual({ ok: false, data: null, code: "network_error" });
  });
});
