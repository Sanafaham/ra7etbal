import { describe, expect, it, vi } from "vitest";
import { reasonOverOperationalEvidenceWithClaude, validateAttentionDecision } from "./_carson-attention-reasoning.js";

const EVIDENCE = {
  ok: true,
  code: "attention_read_succeeded",
  completeness: "full",
  needsYou: [{ id: "task-1", label: "sign the lease", type: "decision", status: "pending", dueAt: null, dueDescription: null, assignee: null, category: "needsYou" }],
  overdueReminders: [{ id: "task-2", label: "call the dentist", type: "reminder", status: "pending", dueAt: "2026-08-25T10:00:00.000Z", dueDescription: "Overdue by 3 days", assignee: null, category: "overdueReminders" }],
  upcomingReminders: [{ id: "task-4", label: "pick up dry cleaning", type: "reminder", status: "pending", dueAt: "2026-09-05T10:00:00.000Z", dueDescription: "Friday at 10:00 AM", assignee: null, category: "upcomingReminders" }],
  waiting: [{ id: "task-5", label: "Grace: kitchen", type: "delegation", status: "pending", dueAt: null, dueDescription: null, assignee: "Grace", category: "waiting" }],
  later: [{ id: "task-6", label: "read that book", type: "reminder", status: "pending", dueAt: null, dueDescription: null, assignee: null, category: "later" }],
  unresolvedCaptures: [{ id: "task-3", label: "buy groceries", type: "todo", status: "pending", dueAt: null, dueDescription: null, assignee: null, category: "unresolvedCaptures" }],
};

function toolResponse(input) {
  return {
    ok: true,
    json: async () => ({ content: [{ type: "tool_use", name: "decide_attention_response", input }] }),
  };
}

describe("reasonOverOperationalEvidenceWithClaude", () => {
  it("forces a strict schema tool call, constrains selectable ids to the authorized evidence across all categories, and returns the structured input", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue(
      toolResponse({ responseIntent: "list", selectedEvidenceIds: ["task-5"] }),
    );

    const result = await reasonOverOperationalEvidenceWithClaude(
      {
        userMessage: "What am I waiting on?",
        conversationState: { priorCapability: "attention_summary_read", priorGroundingStatus: "grounded", previouslySurfacedEvidenceIds: ["task-1"], priorObjective: null },
        authorizedEvidence: EVIDENCE,
      },
      fetchMock,
    );

    expect(result).toEqual({ responseIntent: "list", selectedEvidenceIds: ["task-5"] });
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.tool_choice).toEqual({ type: "tool", name: "decide_attention_response" });
    expect(requestBody.tools[0]).toMatchObject({ name: "decide_attention_response", strict: true });
    const idEnum = requestBody.tools[0].input_schema.properties.selectedEvidenceIds.items.enum;
    expect(idEnum).toEqual(expect.arrayContaining(["task-1", "task-2", "task-3", "task-4", "task-5", "task-6"]));
    expect(idEnum).not.toContain("task-99");
  });

  it("marks every tool property as required, with the genuinely-optional ones typed nullable (2026-08-28 fix — Anthropic's strict mode did not reliably enforce a partial-required schema at this size, and the model was observed in production returning only {responseIntent:\"list\"})", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue(toolResponse({ responseIntent: "list", selectedEvidenceIds: ["task-1"] }));

    await reasonOverOperationalEvidenceWithClaude(
      { userMessage: "Anything overdue?", conversationState: {}, authorizedEvidence: EVIDENCE },
      fetchMock,
    );

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const schema = requestBody.tools[0].input_schema;
    expect(schema.required).toEqual(
      expect.arrayContaining([
        "responseIntent",
        "selectedEvidenceIds",
        "rankedEvidenceIds",
        "contrastedEvidenceIds",
        "needsClarification",
      ]),
    );
    expect(schema.required).toHaveLength(5);
    expect(schema.properties.rankedEvidenceIds.type).toEqual(["array", "null"]);
    expect(schema.properties.contrastedEvidenceIds.type).toEqual(["array", "null"]);
  });

  it("includes conversation state and the categorized authorized evidence in the prompt, and never includes accountId/authorization (not part of the input contract at all)", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue(toolResponse({ responseIntent: "not_attention", selectedEvidenceIds: [] }));

    await reasonOverOperationalEvidenceWithClaude(
      {
        userMessage: "Send Christopher a message.",
        conversationState: { priorCapability: "attention_summary_read", priorGroundingStatus: "grounded", previouslySurfacedEvidenceIds: [], priorObjective: "reviewing attention list" },
        authorizedEvidence: EVIDENCE,
      },
      fetchMock,
    );

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const promptText = requestBody.messages[0].content;
    expect(promptText).toContain("call the dentist");
    expect(promptText).toContain("Overdue by 3 days");
    expect(promptText).toContain("reviewing attention list");
    expect(promptText).toContain("Send Christopher a message.");
    expect(promptText).not.toMatch(/accountId|authorization|Bearer/i);
  });

  it("rejects model prose without a structured tool result", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ content: [{ type: "text", text: "Sure!" }] }) });
    await expect(
      reasonOverOperationalEvidenceWithClaude(
        { userMessage: "What else?", conversationState: {}, authorizedEvidence: EVIDENCE },
        fetchMock,
      ),
    ).rejects.toThrow("no structured decision");
  });

  it("throws when ANTHROPIC_API_KEY is not configured", async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    await expect(
      reasonOverOperationalEvidenceWithClaude({ userMessage: "x", conversationState: {}, authorizedEvidence: EVIDENCE }, vi.fn()),
    ).rejects.toThrow("Anthropic API key is not configured.");
    if (original) process.env.ANTHROPIC_API_KEY = original;
  });

  describe("Stage 2 request timeout (2026-08-30, Turn 4 canary FAIL — proven root cause: production requests exceeded the prior 8000ms budget and aborted)", () => {
    it("configures the abort timeout at exactly 15000ms, not the prior 8000ms", async () => {
      process.env.ANTHROPIC_API_KEY = "test-key";
      const fetchMock = vi.fn().mockResolvedValue(toolResponse({ responseIntent: "list", selectedEvidenceIds: ["task-1"] }));
      const setTimeoutSpy = vi.spyOn(global, "setTimeout");

      await reasonOverOperationalEvidenceWithClaude(
        { userMessage: "What can wait?", conversationState: {}, authorizedEvidence: EVIDENCE },
        fetchMock,
      );

      expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 15000)).toBe(true);
      expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 8000)).toBe(false);
      setTimeoutSpy.mockRestore();
    });

    it("does not abort a request that is still pending at 14999ms, and does abort once 15000ms elapses", async () => {
      vi.useFakeTimers();
      process.env.ANTHROPIC_API_KEY = "test-key";
      let capturedSignal;
      const fetchMock = vi.fn((_url, options) => {
        capturedSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            const err = new Error("The operation was aborted.");
            err.name = "AbortError";
            reject(err);
          });
        });
      });

      const promise = reasonOverOperationalEvidenceWithClaude(
        { userMessage: "What can wait?", conversationState: {}, authorizedEvidence: EVIDENCE },
        fetchMock,
      );
      // Attach a no-op catch immediately so the eventual rejection is never
      // "unhandled" while we assert the pre-abort state below.
      const guarded = promise.catch((err) => err);

      await vi.advanceTimersByTimeAsync(14999);
      expect(capturedSignal.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(2);
      expect(capturedSignal.aborted).toBe(true);
      const rejection = await guarded;
      expect(rejection.name).toBe("AbortError");

      vi.useRealTimers();
    });
  });

  describe("safe httpStatus attachment on thrown errors (2026-08-30, Turn 4 canary root-cause narrowing) — never the response body/headers, only a numeric status when an HTTP response actually arrived", () => {
    it("attaches the real numeric HTTP status when Anthropic returns a non-2xx response", async () => {
      process.env.ANTHROPIC_API_KEY = "test-key";
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({ error: { message: "rate limited — this text must never be logged" } }),
      });

      await expect(
        reasonOverOperationalEvidenceWithClaude(
          { userMessage: "What can wait?", conversationState: {}, authorizedEvidence: EVIDENCE },
          fetchMock,
        ),
      ).rejects.toMatchObject({ httpStatus: 429 });
    });

    it("attaches the real numeric HTTP status (200) when Anthropic responds 2xx but omits the expected tool-use block", async () => {
      process.env.ANTHROPIC_API_KEY = "test-key";
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "Sure!" }] }),
      });

      await expect(
        reasonOverOperationalEvidenceWithClaude(
          { userMessage: "What can wait?", conversationState: {}, authorizedEvidence: EVIDENCE },
          fetchMock,
        ),
      ).rejects.toMatchObject({ httpStatus: 200 });
    });

    it("has no httpStatus at all when there is no HTTP response (missing credential)", async () => {
      const original = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      let caught;
      try {
        await reasonOverOperationalEvidenceWithClaude({ userMessage: "x", conversationState: {}, authorizedEvidence: EVIDENCE }, vi.fn());
      } catch (err) {
        caught = err;
      }
      expect(caught.httpStatus).toBeUndefined();
      if (original) process.env.ANTHROPIC_API_KEY = original;
    });
  });
});

describe("validateAttentionDecision", () => {
  it("accepts a well-formed decision referencing only authorized ids across categories", () => {
    const result = validateAttentionDecision({ responseIntent: "list", selectedEvidenceIds: ["task-1", "task-5"] }, EVIDENCE);
    expect(result).toEqual({
      ok: true,
      decision: {
        responseIntent: "list",
        selectedEvidenceIds: ["task-1", "task-5"],
        rankedEvidenceIds: undefined,
        contrastedEvidenceIds: undefined,
        needsClarification: null,
      },
    });
  });

  it("rejects a decision referencing any id not in the authorized evidence set", () => {
    const result = validateAttentionDecision({ responseIntent: "list", selectedEvidenceIds: ["task-1", "invented-id"] }, EVIDENCE);
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown responseIntent", () => {
    expect(validateAttentionDecision({ responseIntent: "delete_everything", selectedEvidenceIds: [] }, EVIDENCE).ok).toBe(false);
  });

  it("rejects malformed shapes (non-object, missing selectedEvidenceIds, wrong types)", () => {
    expect(validateAttentionDecision(null, EVIDENCE).ok).toBe(false);
    expect(validateAttentionDecision("not an object", EVIDENCE).ok).toBe(false);
    expect(validateAttentionDecision({ responseIntent: "list" }, EVIDENCE).ok).toBe(false);
    expect(validateAttentionDecision({ responseIntent: "list", selectedEvidenceIds: "task-1" }, EVIDENCE).ok).toBe(false);
  });

  it("requires a non-empty selection unless the intent is nothing_new/clarify/not_attention/a contrast with a contrasted set", () => {
    expect(validateAttentionDecision({ responseIntent: "list", selectedEvidenceIds: [] }, EVIDENCE).ok).toBe(false);
    expect(validateAttentionDecision({ responseIntent: "nothing_new", selectedEvidenceIds: [] }, EVIDENCE).ok).toBe(true);
    expect(validateAttentionDecision({ responseIntent: "clarify", selectedEvidenceIds: [], needsClarification: "Which ones?" }, EVIDENCE).ok).toBe(true);
    expect(validateAttentionDecision({ responseIntent: "not_attention", selectedEvidenceIds: [] }, EVIDENCE).ok).toBe(true);
    expect(
      validateAttentionDecision(
        { responseIntent: "contrast", selectedEvidenceIds: [], contrastedEvidenceIds: ["task-2"] },
        EVIDENCE,
      ).ok,
    ).toBe(true);
  });

  it("degrades a ranking that references an id outside the selection to no ranking, without rejecting the whole decision", () => {
    const result = validateAttentionDecision(
      { responseIntent: "rank", selectedEvidenceIds: ["task-1"], rankedEvidenceIds: ["task-1", "task-5"] },
      EVIDENCE,
    );
    expect(result.ok).toBe(true);
    expect(result.decision.rankedEvidenceIds).toBeUndefined();
  });

  it("accepts a valid ranking that is a subset of the selection", () => {
    const result = validateAttentionDecision(
      { responseIntent: "rank", selectedEvidenceIds: ["task-1", "task-2"], rankedEvidenceIds: ["task-2", "task-1"] },
      EVIDENCE,
    );
    expect(result.decision.rankedEvidenceIds).toEqual(["task-2", "task-1"]);
  });

  it("accepts a valid contrast decision — selected and contrasted ids drawn from the same authorized universe", () => {
    const result = validateAttentionDecision(
      { responseIntent: "contrast", selectedEvidenceIds: ["task-4", "task-6"], contrastedEvidenceIds: ["task-2"] },
      EVIDENCE,
    );
    expect(result.ok).toBe(true);
    expect(result.decision.selectedEvidenceIds).toEqual(["task-4", "task-6"]);
    expect(result.decision.contrastedEvidenceIds).toEqual(["task-2"]);
  });

  it("degrades an invented contrastedEvidenceIds id to no contrast, without rejecting the whole decision", () => {
    const result = validateAttentionDecision(
      { responseIntent: "contrast", selectedEvidenceIds: ["task-6"], contrastedEvidenceIds: ["invented-id"] },
      EVIDENCE,
    );
    expect(result.ok).toBe(true);
    expect(result.decision.contrastedEvidenceIds).toBeUndefined();
  });

  it("treats explicit null rankedEvidenceIds/contrastedEvidenceIds the same as absent (2026-08-28 fix — the strict schema now forces the model to always include these keys, often as null)", () => {
    const result = validateAttentionDecision(
      { responseIntent: "list", selectedEvidenceIds: ["task-1"], rankedEvidenceIds: null, contrastedEvidenceIds: null, needsClarification: null },
      EVIDENCE,
    );
    expect(result).toEqual({
      ok: true,
      decision: {
        responseIntent: "list",
        selectedEvidenceIds: ["task-1"],
        rankedEvidenceIds: undefined,
        contrastedEvidenceIds: undefined,
        needsClarification: null,
      },
    });
  });

  it("trims and bounds needsClarification, defaulting to null when absent or empty", () => {
    expect(
      validateAttentionDecision({ responseIntent: "clarify", selectedEvidenceIds: [], needsClarification: "  Which ones?  " }, EVIDENCE)
        .decision.needsClarification,
    ).toBe("Which ones?");
    expect(
      validateAttentionDecision({ responseIntent: "clarify", selectedEvidenceIds: [], needsClarification: "" }, EVIDENCE).decision
        .needsClarification,
    ).toBeNull();
  });

  describe("diagnostic-only reason codes (2026-08-29, Turn 4 production diagnostic — additive, never changes .ok)", () => {
    it("returns a machine-readable reason string for every failure case, without changing .ok", () => {
      const cases = [
        [null, "not_object"],
        [{ responseIntent: "delete_everything", selectedEvidenceIds: [] }, "invalid_response_intent"],
        [{ responseIntent: "list" }, "selected_ids_not_array"],
        [{ responseIntent: "list", selectedEvidenceIds: ["invented-id"] }, "selected_id_unauthorized_or_invalid_type"],
        [{ responseIntent: "list", selectedEvidenceIds: ["task-1"], rankedEvidenceIds: "not-an-array" }, "ranked_ids_not_array"],
        [{ responseIntent: "list", selectedEvidenceIds: ["task-1"], contrastedEvidenceIds: "not-an-array" }, "contrasted_ids_not_array"],
        [{ responseIntent: "list", selectedEvidenceIds: [] }, "empty_selection_for_intent"],
      ];
      for (const [decision, expectedReason] of cases) {
        const result = validateAttentionDecision(decision, EVIDENCE);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe(expectedReason);
      }
    });

    it("never includes a reason field when validation succeeds", () => {
      const result = validateAttentionDecision({ responseIntent: "list", selectedEvidenceIds: ["task-1"] }, EVIDENCE);
      expect(result.ok).toBe(true);
      expect(result.reason).toBeUndefined();
    });
  });
});
