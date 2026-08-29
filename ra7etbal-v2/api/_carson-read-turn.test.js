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

    expect(result.ownerResult).toBe(
      "In order: call the dentist (Overdue by 3 days); then pay the electricity bill (Due in 3 hours).",
    );
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

    expect(result.ownerResult).toBe(
      "Waiting on others: Grace: kitchen cleaning. Overdue: call the dentist (Overdue by 3 days).",
    );
    // Genuinely different shape from a plain "list" of the same selection —
    // both sets are visible, each under its own true category.
    expect(result.ownerResult).not.toBe(FALLBACK_RENDER);
    // Both rendered sets must count as surfaced (CodeRabbit finding) — a
    // later "what else?" must not re-surface the contrasted items either,
    // since they were genuinely shown to the owner in this response.
    expect(new Set(result.surfacedEvidenceIds)).toEqual(new Set(["task-3", "task-1"]));
  });

  it("[8-contrast-empty-selection] a contrast decision with an empty selectedEvidenceIds (everything is in the contrasted set) still marks the contrasted items as surfaced", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockResolvedValue({
      responseIntent: "contrast",
      selectedEvidenceIds: [],
      contrastedEvidenceIds: ["task-1", "task-2"],
    });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...activeContext, transcript: "What can wait?" });

    expect(result.handled).toBe(true);
    expect(new Set(result.surfacedEvidenceIds)).toEqual(new Set(["task-1", "task-2"]));
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

  it("[10] the reasoning provider throwing/unavailable falls back to the full deterministic render, not the honest-failure message, and is NOT structurally retried (5/6: a thrown error is a separate failure mode from a returned-but-invalid decision)", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...activeContext, transcript: "What else?" });

    expect(result.ownerResult).toBe(FALLBACK_RENDER);
    expect(result.groundingStatus).toBe("grounded");
    expect(reasonOverEvidence).toHaveBeenCalledTimes(1);
  });

  it("['Anything overdue?' 1/5] selects and names the actual overdue items with due context when the reasoning model returns a valid decision", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockResolvedValue({
      responseIntent: "list",
      selectedEvidenceIds: ["task-1"],
    });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...activeContext, transcript: "Anything overdue?" });

    expect(result.ownerResult).toContain("call the dentist");
    expect(result.ownerResult).toContain("Overdue by 3 days");
    expect(result.surfacedEvidenceIds).toEqual(["task-1"]);
  });

  it("['Anything overdue?' 2/5] does not include unrelated Waiting/Later items when the model selects only the overdue item", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockResolvedValue({
      responseIntent: "list",
      selectedEvidenceIds: ["task-1"],
    });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...activeContext, transcript: "Anything overdue?" });

    expect(result.ownerResult).not.toContain("Grace");
    expect(result.ownerResult).not.toContain("electricity bill");
  });

  it("['Anything overdue?' 3/5] a selected evidence id must validate against the authorized overdue set — an invented id is rejected, not surfaced", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockResolvedValue({
      responseIntent: "list",
      selectedEvidenceIds: ["task-1", "invented-overdue-id"],
    });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...activeContext, transcript: "Anything overdue?" });

    // Whole decision degrades to the safe deterministic fallback rather than
    // surfacing a partially-invented selection.
    expect(result.ownerResult).toBe(FALLBACK_RENDER);
  });

  it("['Anything overdue?' 4/5] the exact production failure shape — a tool call missing the required selectedEvidenceIds field entirely — still safely falls back to the deterministic render (2026-08-28 root cause: Anthropic strict mode omitted this field at schema scale; fixed in _carson-attention-reasoning.js by making all tool properties required)", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockResolvedValue({ responseIntent: "list" });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...activeContext, transcript: "Anything overdue?" });

    expect(result.ownerResult).toBe(FALLBACK_RENDER);
    expect(result.groundingStatus).toBe("grounded");
  });

  it("['Anything overdue?' 5/5] no overdue evidence retrieved means no invented overdue answer — the model's own empty selection is honored, never a fabricated item", async () => {
    const emptyEvidence = { ...SAMPLE_EVIDENCE, overdueReminders: [] };
    const fetchEvidence = vi.fn().mockResolvedValue({ evidence: emptyEvidence, text: "Needs your attention: nothing overdue." });
    const reasonOverEvidence = vi.fn().mockResolvedValue({
      responseIntent: "nothing_new",
      selectedEvidenceIds: [],
    });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...activeContext, transcript: "Anything overdue?" });

    expect(result.ownerResult).toBe("Nothing else needs your attention beyond what I already mentioned.");
    expect(result.surfacedEvidenceIds).toEqual([]);
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

describe("Carson rank ordering is deterministic by dueAt, never model-authored (2026-08-28 Turn 3 canary fix)", () => {
  // Reproduces the exact production tie the Turn 3 canary surfaced: three
  // items whose dueDescription all round to the same "Overdue by 3 days"
  // bucket, but whose real dueAt values differ by hours.
  const RANK_EVIDENCE = {
    ok: true,
    code: "attention_read_succeeded",
    completeness: "full",
    needsYou: [],
    overdueReminders: [
      { id: "r1", label: "call Loulya", type: "reminder", status: "pending", dueAt: "2026-08-25T14:14:23.686Z", dueDescription: "Overdue by 3 days", assignee: null, category: "overdueReminders" },
      { id: "r2", label: "my mailbox", type: "reminder", status: "pending", dueAt: "2026-08-25T14:51:07.246Z", dueDescription: "Overdue by 3 days", assignee: null, category: "overdueReminders" },
      { id: "r3", label: "my email", type: "reminder", status: "pending", dueAt: "2026-08-25T16:18:40.904Z", dueDescription: "Overdue by 3 days", assignee: null, category: "overdueReminders" },
    ],
    upcomingReminders: [],
    // Deliberately NOT selected by the model in these tests — earliest
    // dueAt of everything in evidence — to prove ranking never sorts the
    // full evidence universe, only the model's own selected subset.
    waiting: [
      { id: "r-not-selected", label: "Grace: kitchen", type: "delegation", status: "pending", dueAt: "2026-01-01T00:00:00.000Z", dueDescription: "Overdue by a long time", assignee: "Grace", category: "waiting" },
    ],
    later: [],
    unresolvedCaptures: [],
  };
  const RANK_GROUNDED_RESULT = { evidence: RANK_EVIDENCE, text: "Needs your attention: call Loulya; my mailbox; my email." };
  const rankActiveContext = {
    accountId: "account-a",
    authorization: "Bearer session-a",
    turnId: "turn-rank-1",
    previousCapability: "attention_summary_read",
    previousGroundingStatus: "grounded",
    previouslySurfacedEvidenceIds: ["r1", "r2", "r3"],
    priorObjective: "reviewing overdue reminders",
  };

  it("[rank 1/6] a deliberately wrong model-supplied rankedEvidenceIds order is ignored — final rendered order follows ascending dueAt", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(RANK_GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockResolvedValue({
      responseIntent: "rank",
      selectedEvidenceIds: ["r1", "r2", "r3"],
      // Deliberately backwards relative to the true dueAt order.
      rankedEvidenceIds: ["r3", "r2", "r1"],
    });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...rankActiveContext, transcript: "Which one should I do first?" });

    expect(result.ownerResult).toBe(
      "In order: call Loulya (Overdue by 3 days); then my mailbox (Overdue by 3 days); then my email (Overdue by 3 days).",
    );
  });

  it("[rank 1b/6] an exact dueAt tie is ordered by a stable secondary key (id) — not by the model's selectedEvidenceIds order (2026-08-28 CodeRabbit finding)", async () => {
    const tieEvidence = {
      ...RANK_EVIDENCE,
      overdueReminders: [
        { id: "tie-a", label: "task A", type: "reminder", status: "pending", dueAt: "2026-08-25T14:14:23.686Z", dueDescription: "Overdue by 3 days", assignee: null, category: "overdueReminders" },
        { id: "tie-b", label: "task B", type: "reminder", status: "pending", dueAt: "2026-08-25T14:14:23.686Z", dueDescription: "Overdue by 3 days", assignee: null, category: "overdueReminders" },
      ],
    };
    const fetchEvidence = vi.fn().mockResolvedValue({ evidence: tieEvidence, text: "..." });
    // Selection order is reversed relative to id order — if the tie fell
    // back to input order instead of a stable key, this would render
    // task B before task A.
    const reasonOverEvidence = vi.fn().mockResolvedValue({
      responseIntent: "rank",
      selectedEvidenceIds: ["tie-b", "tie-a"],
      rankedEvidenceIds: ["tie-b", "tie-a"],
    });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...rankActiveContext, transcript: "Which one should I do first?" });

    expect(result.ownerResult).toBe("In order: task A (Overdue by 3 days); then task B (Overdue by 3 days).");
  });

  it("[rank 2/6] items with identical rounded dueDescription are still correctly ordered by their exact dueAt (the exact Turn 3 production tie)", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(RANK_GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockResolvedValue({
      responseIntent: "rank",
      selectedEvidenceIds: ["r2", "r3", "r1"],
      rankedEvidenceIds: ["r2", "r3", "r1"],
    });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...rankActiveContext, transcript: "Which one should I do first?" });

    // r1 (14:14:23) < r2 (14:51:07) < r3 (16:18:40) — despite all three
    // sharing the identical "Overdue by 3 days" display string.
    expect(result.ownerResult).toBe(
      "In order: call Loulya (Overdue by 3 days); then my mailbox (Overdue by 3 days); then my email (Overdue by 3 days).",
    );
  });

  it("[rank 3/6] only the model-selected authorized subset is sorted — an earlier-dueAt item that was never selected is not pulled into the order", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(RANK_GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockResolvedValue({
      responseIntent: "rank",
      selectedEvidenceIds: ["r1", "r2"],
      rankedEvidenceIds: ["r1", "r2"],
    });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...rankActiveContext, transcript: "Which one should I do first?" });

    expect(result.ownerResult).toBe("In order: call Loulya (Overdue by 3 days); then my mailbox (Overdue by 3 days).");
    expect(result.ownerResult).not.toContain("Grace");
    expect(result.ownerResult).not.toContain("my email");
  });

  it("[rank 4/6] an invented evidence id inside a rank decision is still rejected by existing validation — falls back to the deterministic full render, never a fabricated order", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(RANK_GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockResolvedValue({
      responseIntent: "rank",
      selectedEvidenceIds: ["r1", "invented-id"],
      rankedEvidenceIds: ["r1", "invented-id"],
    });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...rankActiveContext, transcript: "Which one should I do first?" });

    // An invented id anywhere in selectedEvidenceIds rejects the WHOLE
    // decision (not just that id) — falls back to the deterministic full
    // render, same as the non-rank fallback behavior tested elsewhere.
    expect(result.ownerResult).toBe(
      "Nothing needs your direct decision right now. You do have 3 overdue reminders and 1 thing you're waiting on.",
    );
  });

  it("[rank 5/6] a selected item with no comparable dueAt is never force-ranked — Carson states the honest limitation instead of inventing an order", async () => {
    const mixedEvidence = {
      ...RANK_EVIDENCE,
      needsYou: [
        { id: "n1", label: "sign the lease", type: "decision", status: "pending", dueAt: null, dueDescription: null, assignee: null, category: "needsYou" },
      ],
    };
    const fetchEvidence = vi.fn().mockResolvedValue({ evidence: mixedEvidence, text: "..." });
    const reasonOverEvidence = vi.fn().mockResolvedValue({
      responseIntent: "rank",
      selectedEvidenceIds: ["n1", "r1"],
      rankedEvidenceIds: ["n1", "r1"],
    });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...rankActiveContext, transcript: "Which one should I do first?" });

    expect(result.ownerResult).toBe(
      "I don't have a reliable way to put those in order — here's what's active: Needs your decision: sign the lease. Overdue: call Loulya (Overdue by 3 days).",
    );
  });

  it("[rank 6/6] list/contrast/explain/nothing_new rendering is unaffected by the ranking fix", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(RANK_GROUNDED_RESULT);

    const listCoordinate = createAttentionReadCoordinator({
      fetchEvidence,
      reasonOverEvidence: vi.fn().mockResolvedValue({ responseIntent: "list", selectedEvidenceIds: ["r1"] }),
    });
    const listResult = await listCoordinate({ ...rankActiveContext, transcript: "What else?" });
    expect(listResult.ownerResult).toBe("Overdue: call Loulya (Overdue by 3 days).");

    const explainCoordinate = createAttentionReadCoordinator({
      fetchEvidence,
      reasonOverEvidence: vi.fn().mockResolvedValue({ responseIntent: "explain", selectedEvidenceIds: ["r1"] }),
    });
    const explainResult = await explainCoordinate({ ...rankActiveContext, transcript: "Why does that need me?" });
    expect(explainResult.ownerResult).toBe("call Loulya is in Overdue — Overdue by 3 days.");

    const nothingNewCoordinate = createAttentionReadCoordinator({
      fetchEvidence,
      reasonOverEvidence: vi.fn().mockResolvedValue({ responseIntent: "nothing_new", selectedEvidenceIds: [] }),
    });
    const nothingNewResult = await nothingNewCoordinate({ ...rankActiveContext, transcript: "Okay, and after that?" });
    expect(nothingNewResult.ownerResult).toBe("Nothing else needs your attention beyond what I already mentioned.");

    const contrastCoordinate = createAttentionReadCoordinator({
      fetchEvidence,
      reasonOverEvidence: vi.fn().mockResolvedValue({
        responseIntent: "contrast",
        selectedEvidenceIds: ["r1"],
        contrastedEvidenceIds: ["r-not-selected"],
      }),
    });
    const contrastResult = await contrastCoordinate({ ...rankActiveContext, transcript: "What can wait?" });
    expect(contrastResult.ownerResult).toBe(
      "Overdue: call Loulya (Overdue by 3 days). Waiting on others: Grace: kitchen (Overdue by a long time).",
    );
  });
});

describe("Carson bounded one-retry structural reliability for a Stage 2 decision that fails validation (2026-08-29 Turn 4 canary fix)", () => {
  const RETRY_EVIDENCE = {
    ok: true,
    code: "attention_read_succeeded",
    completeness: "full",
    needsYou: [],
    overdueReminders: [
      { id: "r1", label: "call Loulya", type: "reminder", status: "pending", dueAt: "2026-08-28T08:48:21.59Z", dueDescription: "Overdue by 1 day", assignee: null, category: "overdueReminders" },
    ],
    upcomingReminders: [],
    waiting: [],
    later: [],
    unresolvedCaptures: [],
  };
  const RETRY_GROUNDED_RESULT = { evidence: RETRY_EVIDENCE, text: "Needs your attention: call Loulya." };
  const retryActiveContext = {
    accountId: "account-a",
    authorization: "Bearer session-a",
    turnId: "turn-retry-1",
    previousCapability: "attention_summary_read",
    previousGroundingStatus: "grounded",
    previouslySurfacedEvidenceIds: ["r1"],
    priorObjective: "reviewing overdue reminders",
  };

  it("[structural-retry 1/6] a valid first decision never triggers a retry — exactly 1 provider call", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(RETRY_GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockResolvedValue({ responseIntent: "list", selectedEvidenceIds: ["r1"] });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...retryActiveContext, transcript: "What else?" });

    expect(reasonOverEvidence).toHaveBeenCalledTimes(1);
    expect(result.ownerResult).toContain("call Loulya");
  });

  it("[structural-retry 2/6] an invalid first decision followed by a valid second decision succeeds — exactly 2 calls, the retry's answer is used", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(RETRY_GROUNDED_RESULT);
    const reasonOverEvidence = vi
      .fn()
      .mockResolvedValueOnce({ responseIntent: "list" }) // missing selectedEvidenceIds -> invalid
      .mockResolvedValueOnce({ responseIntent: "list", selectedEvidenceIds: ["r1"] });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...retryActiveContext, transcript: "What else?" });

    expect(reasonOverEvidence).toHaveBeenCalledTimes(2);
    expect(result.ownerResult).toContain("call Loulya");
    expect(result.ownerResult).not.toBe(
      "Nothing needs your direct decision right now. You do have 1 overdue reminder.",
    );
  });

  it("[structural-retry 3/6] an invalid first decision followed by a still-invalid second decision falls back — exactly 2 calls, existing deterministic fallback", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(RETRY_GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockResolvedValue({ nonsense: true });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...retryActiveContext, transcript: "What else?" });

    expect(reasonOverEvidence).toHaveBeenCalledTimes(2);
    expect(result.ownerResult).toBe("Nothing needs your direct decision right now. You do have 1 overdue reminder.");
  });

  it("[structural-retry 4/6] an invalid first decision followed by the retry itself throwing falls back safely — exactly 2 calls, no unhandled rejection", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(RETRY_GROUNDED_RESULT);
    const reasonOverEvidence = vi
      .fn()
      .mockResolvedValueOnce({ responseIntent: "list" }) // missing selectedEvidenceIds -> invalid
      .mockRejectedValueOnce(new Error("provider unavailable on retry"));
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...retryActiveContext, transcript: "What else?" });

    expect(reasonOverEvidence).toHaveBeenCalledTimes(2);
    expect(result.ownerResult).toBe("Nothing needs your direct decision right now. You do have 1 overdue reminder.");
  });

  it("[structural-retry 5/6] the initial provider throw is unaffected — no structural retry, existing behavior unchanged (see also test [10] above)", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(RETRY_GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...retryActiveContext, transcript: "What else?" });

    expect(reasonOverEvidence).toHaveBeenCalledTimes(1);
    expect(result.ownerResult).toBe("Nothing needs your direct decision right now. You do have 1 overdue reminder.");
  });

  it("[structural-retry 6/6] no path exceeds 2 total reasoning calls per turn, across every combination", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(RETRY_GROUNDED_RESULT);
    const scenarios = [
      () => vi.fn().mockResolvedValue({ responseIntent: "list", selectedEvidenceIds: ["r1"] }),
      () => vi.fn().mockRejectedValue(new Error("boom")),
      () =>
        vi
          .fn()
          .mockResolvedValueOnce({ responseIntent: "list" })
          .mockResolvedValueOnce({ responseIntent: "list", selectedEvidenceIds: ["r1"] }),
      () => vi.fn().mockResolvedValue({ nonsense: true }),
      () =>
        vi
          .fn()
          .mockResolvedValueOnce({ responseIntent: "list" })
          .mockRejectedValueOnce(new Error("boom on retry")),
    ];
    for (const makeReasonOverEvidence of scenarios) {
      const reasonOverEvidence = makeReasonOverEvidence();
      const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });
      await coordinate({ ...retryActiveContext, transcript: "What else?" });
      expect(reasonOverEvidence.mock.calls.length).toBeLessThanOrEqual(2);
    }
  });
});

describe("Carson deferral/timing semantics are derived deterministically from dueAt, never from category (2026-08-29 Turn 4 fix)", () => {
  // generatedAt anchors "now" for every timing test below. Deliberately
  // includes an overdue item filed under `later` (type "action", not
  // "reminder") — production evidence showed overdue non-reminder actions
  // can and do land in `later`, so `later` membership must never be used
  // as a proxy for "can wait."
  const DEFER_EVIDENCE = {
    ok: true,
    code: "attention_read_succeeded",
    generatedAt: "2026-08-29T12:00:00.000Z",
    completeness: "full",
    needsYou: [],
    overdueReminders: [
      { id: "od1", label: "call the dentist", type: "reminder", status: "pending", dueAt: "2026-08-28T10:00:00.000Z", dueDescription: "Overdue by 1 day", assignee: null, category: "overdueReminders" },
    ],
    upcomingReminders: [
      { id: "up1", label: "pay the electricity bill", type: "reminder", status: "pending", dueAt: "2026-09-01T10:00:00.000Z", dueDescription: "Due in 3 days", assignee: null, category: "upcomingReminders" },
    ],
    waiting: [],
    later: [
      { id: "la-overdue", label: "update the master plan", type: "action", status: "pending", dueAt: "2026-08-29T09:00:00.000Z", dueDescription: "Overdue by 3 hours", assignee: null, category: "later" },
      { id: "la-undated", label: "read that book", type: "reminder", status: "pending", dueAt: null, dueDescription: null, assignee: null, category: "later" },
    ],
    unresolvedCaptures: [],
  };
  const DEFER_GROUNDED_RESULT = { evidence: DEFER_EVIDENCE, text: "..." };
  const deferActiveContext = {
    accountId: "account-a",
    authorization: "Bearer session-a",
    turnId: "turn-defer-1",
    previousCapability: "attention_summary_read",
    previousGroundingStatus: "grounded",
    previouslySurfacedEvidenceIds: ["od1", "up1", "la-overdue", "la-undated"],
    priorObjective: "reviewing what can wait",
  };

  it("[defer 1/6] overdue items are identified from exact dueAt, regardless of canonical category — a `later`-filed overdue action is grouped with an `overdueReminders` item", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(DEFER_GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockResolvedValue({
      responseIntent: "defer_timing",
      selectedEvidenceIds: ["od1", "la-overdue"],
    });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...deferActiveContext, transcript: "What can wait?" });

    expect(result.ownerResult).toContain(
      "Overdue: call the dentist (Overdue by 1 day); update the master plan (Overdue by 3 hours).",
    );
  });

  it("[defer 2/6] a future-due item is identified as not-yet-due from exact dueAt", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(DEFER_GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockResolvedValue({
      responseIntent: "defer_timing",
      selectedEvidenceIds: ["up1"],
    });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...deferActiveContext, transcript: "What can wait?" });

    expect(result.ownerResult).toContain("Not due yet: pay the electricity bill (Due in 3 days).");
  });

  it("[defer 3/6] an undated item is surfaced factually with no invented priority or urgency claim", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(DEFER_GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockResolvedValue({
      responseIntent: "defer_timing",
      selectedEvidenceIds: ["la-undated"],
    });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...deferActiveContext, transcript: "What doesn't need doing yet?" });

    expect(result.ownerResult).toContain("No due date set: read that book.");
    // The honest caveat itself legitimately mentions "safe"/"unimportant" in
    // a negated sense ("doesn't tell me what's ... safe") — this checks no
    // *affirmative* priority/safety claim is made about this specific item.
    expect(result.ownerResult).not.toMatch(/\bis (safe|unimportant|low priority)\b/i);
  });

  it("[defer 4/6] an overdue non-reminder action filed under `later` is never mislabeled as not-due-yet or safe to wait, merely because its category is `later`", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(DEFER_GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockResolvedValue({
      responseIntent: "defer_timing",
      selectedEvidenceIds: ["la-overdue"],
    });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...deferActiveContext, transcript: "What can wait?" });

    expect(result.ownerResult).toContain("Overdue: update the master plan (Overdue by 3 hours).");
    expect(result.ownerResult).not.toContain("Not due yet");
  });

  it("[defer 5/6] a future-due item may be called 'not due yet' but the response never asserts it is safe, unimportant, or definitely can wait — and always states the timing-only limitation", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(DEFER_GROUNDED_RESULT);
    const reasonOverEvidence = vi.fn().mockResolvedValue({
      responseIntent: "defer_timing",
      selectedEvidenceIds: ["od1", "up1", "la-overdue", "la-undated"],
    });
    const coordinate = createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence });

    const result = await coordinate({ ...deferActiveContext, transcript: "What can wait?" });

    expect(result.ownerResult).toContain("Overdue: call the dentist (Overdue by 1 day); update the master plan (Overdue by 3 hours).");
    expect(result.ownerResult).toContain("Not due yet: pay the electricity bill (Due in 3 days).");
    expect(result.ownerResult).toContain("No due date set: read that book.");
    expect(result.ownerResult).toContain(
      "Due timing alone doesn't tell me what's truly safe to postpone or unimportant — just what's overdue and what isn't due yet.",
    );
    // Same distinction: the caveat's own negated wording is expected and
    // asserted above — this checks no affirmative "X is safe/definitely can
    // wait" claim is made about any specific item.
    expect(result.ownerResult).not.toMatch(/\bis safe to (defer|postpone|wait)\b|\bcan definitely wait\b/i);
  });

  it("[defer 6/6] list/rank/contrast/nothing_new rendering outside deferral questions is unaffected by the defer_timing intent", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(DEFER_GROUNDED_RESULT);

    const listCoordinate = createAttentionReadCoordinator({
      fetchEvidence,
      reasonOverEvidence: vi.fn().mockResolvedValue({ responseIntent: "list", selectedEvidenceIds: ["od1"] }),
    });
    const listResult = await listCoordinate({ ...deferActiveContext, transcript: "What else?" });
    expect(listResult.ownerResult).toBe("Overdue: call the dentist (Overdue by 1 day).");

    const rankCoordinate = createAttentionReadCoordinator({
      fetchEvidence,
      reasonOverEvidence: vi
        .fn()
        .mockResolvedValue({ responseIntent: "rank", selectedEvidenceIds: ["od1", "up1"], rankedEvidenceIds: ["up1", "od1"] }),
    });
    const rankResult = await rankCoordinate({ ...deferActiveContext, transcript: "Which one first?" });
    expect(rankResult.ownerResult).toBe(
      "In order: call the dentist (Overdue by 1 day); then pay the electricity bill (Due in 3 days).",
    );
  });
});
