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
  // A direct match never needs the reasoning dependency to actually be
  // called — but the coordinator still requires it to be injected (fails
  // fast on a missing dependency, matching this file's existing
  // convention), so every test supplies a throwing stub unless it's
  // specifically testing the reasoning path.
  const unusedReasonOverEvidence = vi.fn(() => {
    throw new Error("reasonOverEvidence must not be called for a direct attention intent");
  });

  it("[1] classifies deterministically — no model call — and returns the grounded evidence server result verbatim", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue({
      evidence: {
        ok: true,
        code: "attention_read_succeeded",
        completeness: "full",
        needsYou: [],
        overdueReminders: [],
        upcomingReminders: [],
        waiting: [],
        later: [],
        unresolvedCaptures: [],
      },
      text: "Needs your attention: call the dentist.",
    });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence: unusedReasonOverEvidence });

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

  it("leaves a non-attention transcript unclaimed when there is no active grounded context either", async () => {
    const fetchEvidence = vi.fn();
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence: unusedReasonOverEvidence });

    const result = await coordinate({ ...ATTENTION_TURN, transcript: "What's on my calendar tomorrow?" });

    expect(result).toEqual({ handled: false, status: 422, code: "unsupported_intent" });
    expect(fetchEvidence).not.toHaveBeenCalled();
  });

  it("[11] fails closed on retrieval failure — a truthful, honest result, never a fall-through to another answer path", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue({
      evidence: { ok: false, code: "attention_read_failed", completeness: "none" },
      text: "I couldn't check what needs your attention right now — the live check didn't complete.",
    });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence: unusedReasonOverEvidence });

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
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence: unusedReasonOverEvidence });

    const result = await coordinate(ATTENTION_TURN);

    expect(result.handled).toBe(true);
    expect(result.groundingStatus).toBe("failed");
    expect(result.ownerResult).toBe("I couldn't check what needs your attention right now — the live check didn't complete.");
  });

  it("rejects an unauthenticated turn before any retrieval is attempted", async () => {
    const fetchEvidence = vi.fn();
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence: unusedReasonOverEvidence });

    const result = await coordinate({ ...ATTENTION_TURN, accountId: "" });

    expect(result).toEqual({ handled: false, status: 400, code: "invalid_owner_turn" });
    expect(fetchEvidence).not.toHaveBeenCalled();
  });

  it("rejects an old/new ownership collision before retrieval", async () => {
    const fetchEvidence = vi.fn();
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence: unusedReasonOverEvidence });

    const result = await coordinate({ ...ATTENTION_TURN, legacyClaimed: true });

    expect(result).toEqual({ handled: false, status: 409, code: "ownership_collision" });
    expect(fetchEvidence).not.toHaveBeenCalled();
  });

  it("requires both fetchEvidence and reasonOverEvidence to be injected", () => {
    expect(() => createAttentionReadCoordinator({ fetchEvidence: vi.fn() })).toThrow();
    expect(() => createAttentionReadCoordinator({ reasonOverEvidence: vi.fn() })).toThrow();
  });
});

describe("Carson Second Brain stateful reasoning over grounded attention evidence (2026-08-28)", () => {
  const SAMPLE_EVIDENCE = {
    ok: true,
    code: "attention_read_succeeded",
    completeness: "full",
    needsYou: [],
    overdueReminders: [
      { id: "task-1", label: "call the dentist", type: "reminder", status: "pending", dueAt: "2026-08-25T10:00:00.000Z", dueDescription: "Overdue by 3 days", assignee: null, category: "overdueReminders" },
    ],
    upcomingReminders: [
      { id: "task-2", label: "pay the electricity bill", type: "reminder", status: "pending", dueAt: "2026-08-28T18:00:00.000Z", dueDescription: "Due in 3 hours", assignee: null, category: "upcomingReminders" },
    ],
    waiting: [{ id: "task-3", label: "Grace: kitchen cleaning", type: "delegation", status: "pending", dueAt: null, dueDescription: null, assignee: "Grace", category: "waiting" }],
    later: [],
    unresolvedCaptures: [],
  };
  const GROUNDED_RESULT = { evidence: SAMPLE_EVIDENCE, text: "Needs your attention: call the dentist; pay the electricity bill." };
  const FALLBACK_RENDER =
    "Nothing needs your direct decision right now. You do have 1 overdue reminder and 1 upcoming reminder and 1 thing you're waiting on.";
  const activeContext = {
    accountId: "account-a",
    authorization: "Bearer session-a",
    turnId: "turn-followup-1",
    previousCapability: "attention_summary_read",
    previousGroundingStatus: "grounded",
    previouslySurfacedEvidenceIds: ["task-1", "task-2"],
    priorObjective: "reviewing attention list",
  };

  it("[2] admits a message with NO regex/follow-up match at all, purely on active grounded context, and calls the reasoning model with fresh evidence + conversation state", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockResolvedValue({
      responseIntent: "list",
      selectedEvidenceIds: ["task-3"],
    });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...activeContext, transcript: "What else?" });

    expect(fetchEvidence).toHaveBeenCalledOnce();
    expect(reasonOverEvidence).toHaveBeenCalledOnce();
    const call = reasonOverEvidence.mock.calls[0][0];
    expect(call.userMessage).toBe("What else?");
    expect(call.authorizedEvidence).toEqual(SAMPLE_EVIDENCE);
    expect(call.conversationState).toMatchObject({
      priorCapability: "attention_summary_read",
      priorGroundingStatus: "grounded",
      previouslySurfacedEvidenceIds: ["task-1", "task-2"],
      priorObjective: "reviewing attention list",
    });
    expect(result).toMatchObject({ handled: true, status: 200, groundingStatus: "grounded" });
    expect(result.ownerResult).toContain("Grace");
    expect(result.surfacedEvidenceIds).toEqual(["task-3"]);
  });

  it("[3] a genuinely novel phrasing with zero corresponding regex — 'Which should I do first?' — is handled through the same mechanism, with ranking", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockResolvedValue({
      responseIntent: "rank",
      selectedEvidenceIds: ["task-1", "task-2"],
      rankedEvidenceIds: ["task-1", "task-2"],
    });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...activeContext, transcript: "Which should I do first?" });

    expect(result.ownerResult).toBe("In order: call the dentist; then pay the electricity bill.");
  });

  it("[8-contrast] 'What can wait?' — contrast decision, selected and contrasted sets both authorized, visibly different from a plain list/urgent response", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockResolvedValue({
      responseIntent: "contrast",
      selectedEvidenceIds: ["task-3"],
      contrastedEvidenceIds: ["task-1"],
    });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...activeContext, transcript: "What can wait?" });

    expect(result.ownerResult).toBe("Waiting on others: Grace: kitchen cleaning. Overdue: call the dentist.");
    // Genuinely different shape from a plain "list" of the same selection —
    // both sets are visible, each under its own true category.
    expect(result.ownerResult).not.toBe(FALLBACK_RENDER);
  });

  it("[5] 'Why does that need me?' may reference an already-surfaced authorized id via explain", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockResolvedValue({
      responseIntent: "explain",
      selectedEvidenceIds: ["task-1"],
    });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...activeContext, transcript: "Why does that need me?" });

    expect(result.ownerResult).toBe("call the dentist is in Overdue — Overdue by 3 days.");
  });

  it("[6] a novel paraphrase not present in any regex is still handled via the reasoning layer given active context", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockResolvedValue({
      responseIntent: "nothing_new",
      selectedEvidenceIds: [],
    });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...activeContext, transcript: "Okay, and after that?" });

    expect(result.ownerResult).toBe("Nothing else needs your attention beyond what I already mentioned.");
  });

  it("[7] an unrelated message after attention context returns not_attention and is left unclaimed for the normal typed path", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockResolvedValue({
      responseIntent: "not_attention",
      selectedEvidenceIds: [],
    });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...activeContext, transcript: "Send Christopher a message." });

    // Fresh evidence WAS still retrieved (per the mandatory-retrieval
    // contract — the model needs evidence to decide relevance at all), but
    // the turn is explicitly left unclaimed, never answered as attention.
    expect(fetchEvidence).toHaveBeenCalledOnce();
    expect(result).toEqual({ handled: false, status: 200, code: "not_attention" });
  });

  it("[8] the model referencing an unauthorized/invented evidence id is rejected — falls back to the full deterministic render, never a fabricated answer", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockResolvedValue({
      responseIntent: "list",
      selectedEvidenceIds: ["task-1", "id-that-does-not-exist"],
    });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...activeContext, transcript: "What else?" });

    expect(result).toMatchObject({ handled: true, status: 200, groundingStatus: "grounded" });
    expect(result.ownerResult).toBe(FALLBACK_RENDER);
  });

  it("[9] malformed model output (missing required fields) falls back to the full deterministic render", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockResolvedValue({ nonsense: true });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...activeContext, transcript: "What else?" });

    expect(result.ownerResult).toBe(FALLBACK_RENDER);
    expect(result.groundingStatus).toBe("grounded");
  });

  it("[10] the reasoning provider throwing/unavailable falls back to the full deterministic render, not the honest-failure message", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...activeContext, transcript: "What else?" });

    expect(result.ownerResult).toBe(FALLBACK_RENDER);
    expect(result.groundingStatus).toBe("grounded");
  });

  it("[11b] fresh retrieval failing in the reasoning-gated path still fails closed honestly — the reasoning model is never even called", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue({
      evidence: { ok: false, code: "attention_read_failed", completeness: "none" },
      text: "I couldn't check what needs your attention right now — the live check didn't complete.",
    });
    const reasonOverEvidence = vi.fn();
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...activeContext, transcript: "What else?" });

    expect(reasonOverEvidence).not.toHaveBeenCalled();
    expect(result).toMatchObject({ handled: true, status: 502, groundingStatus: "failed" });
  });

  it("[12a] conversation state (previouslySurfacedEvidenceIds/priorObjective) never reaches the retrieval call's identity/tenant scoping", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockResolvedValue({ responseIntent: "list", selectedEvidenceIds: ["task-1"] });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    await coordinate({ ...activeContext, transcript: "What else?" });

    expect(fetchEvidence).toHaveBeenCalledWith({ accountId: "account-a", authorization: "Bearer session-a" });
    const callArgs = fetchEvidence.mock.calls[0][0];
    expect(callArgs).not.toHaveProperty("previousCapability");
    expect(callArgs).not.toHaveProperty("previouslySurfacedEvidenceIds");
  });

  it("[12b] the reasoning model itself never receives accountId or authorization", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockResolvedValue({ responseIntent: "list", selectedEvidenceIds: ["task-1"] });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    await coordinate({ ...activeContext, transcript: "What else?" });

    const call = reasonOverEvidence.mock.calls[0][0];
    expect(call).not.toHaveProperty("accountId");
    expect(call).not.toHaveProperty("authorization");
  });

  it("a follow-up whose predecessor was NOT grounded (or capability mismatched) is not admitted — same as a plain unrelated turn", async () => {
    const fetchEvidence = vi.fn();
    const reasonOverEvidence = vi.fn();
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const wrongCapability = await coordinate({ ...activeContext, transcript: "What else?", previousCapability: "calendar_read" });
    const notGrounded = await coordinate({ ...activeContext, transcript: "What else?", previousGroundingStatus: "failed" });

    for (const result of [wrongCapability, notGrounded]) {
      expect(result).toEqual({ handled: false, status: 422, code: "unsupported_intent" });
    }
    expect(fetchEvidence).not.toHaveBeenCalled();
    expect(reasonOverEvidence).not.toHaveBeenCalled();
  });

  it("performs a fresh retrieval for every turn — never reuses or replays prior evidence across a direct turn and a follow-up", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockResolvedValue({ responseIntent: "list", selectedEvidenceIds: ["task-1"] });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    await coordinate({
      accountId: "account-a",
      authorization: "Bearer session-a",
      turnId: "turn-1",
      transcript: "What needs my attention?",
    });
    await coordinate({ ...activeContext, transcript: "What else?", turnId: "turn-2" });

    expect(fetchEvidence).toHaveBeenCalledTimes(2);
  });
});
