import { describe, expect, it, vi } from "vitest";
import {
  READ_CAPABILITY_REGISTRY,
  authorizeReadIntent,
  createReadOnlyTurnCoordinator,
  createAttentionReadCoordinator,
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
  it("registers exactly the calendar and attention-summary read capabilities", () => {
    // 2026-08-28, Second Brain typed hard-grounding slice: attention_summary_read
    // was deliberately added alongside the existing calendar_read capability.
    expect(READ_CAPABILITY_REGISTRY).toEqual({
      calendar_read: { permission: "read" },
      attention_summary_read: { permission: "read" },
    });
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

describe("Carson deterministic attention-summary read coordinator (typed hard-grounding)", () => {
  const ATTENTION_TURN = {
    accountId: "account-a",
    authorization: "Bearer session-a",
    turnId: "turn-attn-1",
    transcript: "What needs my attention?",
  };

  it("classifies deterministically — no model call — and returns the grounded evidence server result verbatim", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue({
      evidence: { ok: true, code: "attention_read_succeeded", completeness: "full" },
      text: "Needs your attention: call the dentist.",
    });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence });

    const result = await coordinate(ATTENTION_TURN);

    expect(fetchEvidence).toHaveBeenCalledOnce();
    expect(fetchEvidence).toHaveBeenCalledWith({ accountId: "account-a", authorization: "Bearer session-a" });
    expect(result).toMatchObject({
      handled: true,
      status: 200,
      capability: "attention_summary_read",
      groundingStatus: "grounded",
      ownerResult: "Needs your attention: call the dentist.",
    });
  });

  it("leaves a non-attention transcript unclaimed — the calendar path (or anything else) can still handle it", async () => {
    const fetchEvidence = vi.fn();
    const coordinate = createAttentionReadCoordinator({ fetchEvidence });

    const result = await coordinate({ ...ATTENTION_TURN, transcript: "What's on my calendar tomorrow?" });

    expect(result).toEqual({ handled: false, status: 422, code: "unsupported_intent" });
    expect(fetchEvidence).not.toHaveBeenCalled();
  });

  it("fails closed on retrieval failure — a truthful, honest result, never a fall-through to another answer path", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue({
      evidence: { ok: false, code: "attention_read_failed", completeness: "none" },
      text: "I couldn't check what needs your attention right now — the live check didn't complete.",
    });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence });

    const result = await coordinate(ATTENTION_TURN);

    expect(result).toMatchObject({
      handled: true,
      status: 502,
      code: "attention_read_failed",
      groundingStatus: "failed",
      ownerResult: "I couldn't check what needs your attention right now — the live check didn't complete.",
    });
  });

  it("fails closed even when the injected retrieval dependency throws outright", async () => {
    const fetchEvidence = vi.fn().mockRejectedValue(new Error("boom"));
    const coordinate = createAttentionReadCoordinator({ fetchEvidence });

    const result = await coordinate(ATTENTION_TURN);

    expect(result.handled).toBe(true);
    expect(result.groundingStatus).toBe("failed");
    expect(result.ownerResult).toBe("I couldn't check what needs your attention right now — the live check didn't complete.");
  });

  it("rejects an unauthenticated turn before any retrieval is attempted", async () => {
    // Matches createReadOnlyTurnCoordinator's own convention: a missing
    // accountId fails the initial owner-turn shape check (400,
    // invalid_owner_turn) before intent/authorization is even evaluated.
    const fetchEvidence = vi.fn();
    const coordinate = createAttentionReadCoordinator({ fetchEvidence });

    const result = await coordinate({ ...ATTENTION_TURN, accountId: "" });

    expect(result).toEqual({ handled: false, status: 400, code: "invalid_owner_turn" });
    expect(fetchEvidence).not.toHaveBeenCalled();
  });

  it("rejects an old/new ownership collision before retrieval", async () => {
    const fetchEvidence = vi.fn();
    const coordinate = createAttentionReadCoordinator({ fetchEvidence });

    const result = await coordinate({ ...ATTENTION_TURN, legacyClaimed: true });

    expect(result).toEqual({ handled: false, status: 409, code: "ownership_collision" });
    expect(fetchEvidence).not.toHaveBeenCalled();
  });
});

describe("Carson attention follow-up continuation (2026-08-28 fix)", () => {
  const GROUNDED_RESULT = {
    evidence: { ok: true, code: "attention_read_succeeded", completeness: "full" },
    text: "Also on your mind: buy groceries.",
  };
  const validContinuation = {
    accountId: "account-a",
    authorization: "Bearer session-a",
    turnId: "turn-followup-1",
    transcript: "What else?",
    previousCapability: "attention_summary_read",
    previousGroundingStatus: "grounded",
  };

  it("[2/3] admits a follow-up with valid continuation context and returns a fresh grounded result, not unsupported_intent", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const coordinate = createAttentionReadCoordinator({ fetchEvidence });

    const result = await coordinate(validContinuation);

    expect(result.code).not.toBe("unsupported_intent");
    expect(result).toMatchObject({
      handled: true,
      status: 200,
      capability: "attention_summary_read",
      groundingStatus: "grounded",
      ownerResult: GROUNDED_RESULT.text,
    });
  });

  it("[4] server independently re-verifies matchesAttentionFollowUp — a non-follow-up transcript is still rejected even with valid continuation fields", async () => {
    const fetchEvidence = vi.fn();
    const coordinate = createAttentionReadCoordinator({ fetchEvidence });

    const result = await coordinate({
      ...validContinuation,
      transcript: "Order more cat food please",
    });

    expect(result).toEqual({ handled: false, status: 422, code: "unsupported_intent" });
    expect(fetchEvidence).not.toHaveBeenCalled();
  });

  it("[5] previousCapability/previousGroundingStatus alone cannot turn arbitrary text into an attention request", async () => {
    const fetchEvidence = vi.fn();
    const coordinate = createAttentionReadCoordinator({ fetchEvidence });

    const result = await coordinate({
      ...validContinuation,
      transcript: "Please transfer $500 to my landlord",
    });

    expect(result).toEqual({ handled: false, status: 422, code: "unsupported_intent" });
    expect(fetchEvidence).not.toHaveBeenCalled();
  });

  it("[5b] an incomplete continuation claim (wrong capability or non-grounded prior status) does not admit a bare follow-up transcript", async () => {
    const fetchEvidence = vi.fn();
    const coordinate = createAttentionReadCoordinator({ fetchEvidence });

    const wrongCapability = await coordinate({ ...validContinuation, previousCapability: "calendar_read" });
    const notGrounded = await coordinate({ ...validContinuation, previousGroundingStatus: "failed" });
    const missingBoth = await coordinate({
      ...validContinuation,
      previousCapability: undefined,
      previousGroundingStatus: undefined,
    });

    for (const result of [wrongCapability, notGrounded, missingBoth]) {
      expect(result).toEqual({ handled: false, status: 422, code: "unsupported_intent" });
    }
    expect(fetchEvidence).not.toHaveBeenCalled();
  });

  it("[6] performs a fresh retrieval for the follow-up — never reuses or replays prior evidence", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const coordinate = createAttentionReadCoordinator({ fetchEvidence });

    await coordinate({
      accountId: "account-a",
      authorization: "Bearer session-a",
      turnId: "turn-1",
      transcript: "What needs my attention?",
    }); // direct intent turn
    await coordinate({ ...validContinuation, turnId: "turn-2" }); // follow-up turn

    expect(fetchEvidence).toHaveBeenCalledTimes(2);
  });

  it("[7] continuation context never reaches or alters the retrieval call's identity/tenant scoping", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const coordinate = createAttentionReadCoordinator({ fetchEvidence });

    await coordinate(validContinuation);

    expect(fetchEvidence).toHaveBeenCalledWith({ accountId: "account-a", authorization: "Bearer session-a" });
    const callArgs = fetchEvidence.mock.calls[0][0];
    expect(callArgs).not.toHaveProperty("previousCapability");
    expect(callArgs).not.toHaveProperty("previousGroundingStatus");
  });

  it("[9] a valid continuation whose fresh retrieval fails still fails closed to the honest fallback, never a fabricated answer", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue({
      evidence: { ok: false, code: "attention_read_failed", completeness: "none" },
      text: "I couldn't check what needs your attention right now — the live check didn't complete.",
    });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence });

    const result = await coordinate(validContinuation);

    expect(result).toMatchObject({
      handled: true,
      status: 502,
      groundingStatus: "failed",
      ownerResult: "I couldn't check what needs your attention right now — the live check didn't complete.",
    });
  });
});
