import { describe, expect, it, vi } from "vitest";
import {
  READ_CAPABILITY_REGISTRY,
  authorizeReadIntent,
  createReadOnlyTurnCoordinator,
  normalizeCalendarEvidence,
  renderCalendarOwnerResult,
  validateStructuredIntent,
} from "./_carson-read-turn.js";

const OWNER_TURN = {
  accountId: "account-a",
  authorization: "Bearer session-a",
  turnId: "turn-1",
  providerEventId: "event-1",
  transcript: "What do I have on my calendar tomorrow?",
};

describe("Carson read-only turn contracts", () => {
  it("registers only the existing calendar read capability", () => {
    expect(READ_CAPABILITY_REGISTRY).toEqual({ calendar_read: { permission: "read" } });
  });

  it("accepts strict calendar intent and rejects unsupported or malformed output", () => {
    expect(validateStructuredIntent({ capability: "calendar_read", range: "tomorrow" })).toEqual({
      ok: true,
      intent: { capability: "calendar_read", range: "tomorrow" },
    });
    expect(validateStructuredIntent({ capability: "send_message", range: "tomorrow" })).toEqual({ ok: false, code: "unsupported_intent" });
    expect(validateStructuredIntent({ capability: "calendar_read" })).toEqual({ ok: false, code: "malformed_intent" });
  });

  it("binds policy to the authenticated account and read permission", () => {
    expect(authorizeReadIntent({ accountId: "account-a", intent: { capability: "calendar_read" } })).toMatchObject({
      ok: true,
      accountId: "account-a",
      permission: "read",
    });
    expect(authorizeReadIntent({ accountId: "", intent: { capability: "calendar_read" } })).toEqual({ ok: false, code: "unauthorized" });
  });

  it("normalizes only supported calendar evidence and renders only returned titles", () => {
    const evidence = normalizeCalendarEvidence({
      connected: true,
      events: [{ id: "evt-1", title: "Dentist", start: "2026-08-20T10:00:00+03:00", location: null, allDay: false }],
    }, "tomorrow");
    expect(renderCalendarOwnerResult(evidence)).toBe("Tomorrow: Dentist.");
    expect(renderCalendarOwnerResult(evidence)).not.toContain("location");
    expect(renderCalendarOwnerResult(evidence)).not.toContain("confirmed");
  });

  it("returns a truthful empty result", () => {
    const evidence = normalizeCalendarEvidence({ connected: true, events: [] }, "tomorrow");
    expect(renderCalendarOwnerResult(evidence)).toBe("You have nothing on your calendar tomorrow.");
  });
});

describe("Carson composed read-only turn", () => {
  it("owns one authoritative turn from transcript through existing capability evidence", async () => {
    const interpretIntent = vi.fn().mockResolvedValue({ capability: "calendar_read", range: "tomorrow" });
    const readCalendar = vi.fn().mockResolvedValue({
      connected: true,
      events: [{ id: "evt-1", title: "Dentist", start: "2026-08-20T10:00:00+03:00", end: null, location: null, allDay: false }],
    });
    const coordinate = createReadOnlyTurnCoordinator({ interpretIntent, readCalendar });

    const result = await coordinate(OWNER_TURN);

    expect(interpretIntent).toHaveBeenCalledOnce();
    expect(interpretIntent).toHaveBeenCalledWith(OWNER_TURN.transcript);
    expect(readCalendar).toHaveBeenCalledOnce();
    expect(readCalendar).toHaveBeenCalledWith({ accountId: "account-a", authorization: "Bearer session-a", range: "tomorrow" });
    expect(result).toMatchObject({
      handled: true,
      status: 200,
      capability: "calendar_read",
      ownerResult: "Tomorrow: Dentist.",
      evidence: { connected: true, range: "tomorrow" },
    });
  });

  it("fails closed on malformed model output without invoking Calendar", async () => {
    const readCalendar = vi.fn();
    const coordinate = createReadOnlyTurnCoordinator({ interpretIntent: vi.fn().mockResolvedValue({ range: "tomorrow" }), readCalendar });
    const result = await coordinate(OWNER_TURN);
    expect(result).toMatchObject({ handled: true, status: 502, code: "malformed_intent" });
    expect(readCalendar).not.toHaveBeenCalled();
  });

  it("leaves unsupported intent unclaimed for the legacy owner", async () => {
    const readCalendar = vi.fn();
    const coordinate = createReadOnlyTurnCoordinator({ interpretIntent: vi.fn().mockResolvedValue({ capability: "unsupported", range: "tomorrow" }), readCalendar });
    expect(await coordinate(OWNER_TURN)).toEqual({ handled: false, status: 422, code: "unsupported_intent" });
    expect(readCalendar).not.toHaveBeenCalled();
  });

  it("rejects an old/new ownership collision before model or tool invocation", async () => {
    const interpretIntent = vi.fn();
    const readCalendar = vi.fn();
    const coordinate = createReadOnlyTurnCoordinator({ interpretIntent, readCalendar });
    expect(await coordinate({ ...OWNER_TURN, legacyClaimed: true })).toEqual({ handled: false, status: 409, code: "ownership_collision" });
    expect(interpretIntent).not.toHaveBeenCalled();
    expect(readCalendar).not.toHaveBeenCalled();
  });

  it("returns canonical read failure without inventing data", async () => {
    const coordinate = createReadOnlyTurnCoordinator({
      interpretIntent: vi.fn().mockResolvedValue({ capability: "calendar_read", range: "tomorrow" }),
      readCalendar: vi.fn().mockRejectedValue(new Error("provider unavailable")),
    });
    const result = await coordinate(OWNER_TURN);
    expect(result).toMatchObject({ handled: true, status: 502, code: "calendar_read_failed", ownerResult: "I couldn't read your calendar right now." });
    expect(result.ownerResult).not.toContain("event");
  });
});
