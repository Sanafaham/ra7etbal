import { describe, expect, it, vi } from "vitest";

// calendar.ts imports ./supabase at module top level, which throws without
// VITE_SUPABASE_* env vars in this test environment.
vi.mock("./supabase", () => ({
  supabase: { auth: { getSession: vi.fn() } },
}));

import {
  deriveCalendarConnectionStatus,
  buildCalendarConnectionStatusBlock,
  type CalendarResult,
} from "./calendar";

describe("deriveCalendarConnectionStatus", () => {
  it("returns 'connected' when the calendar is connected", () => {
    const result: CalendarResult = { connected: true, events: [] };
    expect(deriveCalendarConnectionStatus(result)).toBe("connected");
  });

  it("returns 'revoked' when Google revoked access", () => {
    const result: CalendarResult = { connected: false, revoked: true, events: [] };
    expect(deriveCalendarConnectionStatus(result)).toBe("revoked");
  });

  it("returns 'disconnected' when never connected", () => {
    const result: CalendarResult = { connected: false, events: [] };
    expect(deriveCalendarConnectionStatus(result)).toBe("disconnected");
  });
});

describe("buildCalendarConnectionStatusBlock — Phase 9A user-facing language rule", () => {
  it("reports a clean 'connected' state", () => {
    const block = buildCalendarConnectionStatusBlock("connected");
    expect(block).toContain("Connected");
  });

  it("tells the user to reconnect when disconnected, without exposing technical detail", () => {
    const block = buildCalendarConnectionStatusBlock("disconnected");
    expect(block).toContain("reconnect");
    expect(block.toLowerCase()).not.toMatch(/token|oauth|api|error code/);
  });

  it("tells the user to reconnect when revoked — same user-facing language as disconnected, no mention of revocation mechanics", () => {
    const block = buildCalendarConnectionStatusBlock("revoked");
    expect(block).toContain("reconnect");
    expect(block.toLowerCase()).not.toMatch(/token|oauth|revoked by google|api|error code/);
  });

  it("returns empty string for 'unknown' — never claims a state that hasn't been checked", () => {
    expect(buildCalendarConnectionStatusBlock("unknown")).toBe("");
  });
});
