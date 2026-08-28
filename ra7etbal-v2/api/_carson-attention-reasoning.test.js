import { describe, expect, it, vi } from "vitest";
import { reasonOverOperationalEvidenceWithClaude, validateAttentionDecision } from "./_carson-attention-reasoning.js";

const EVIDENCE = {
  ok: true,
  code: "attention_read_succeeded",
  completeness: "full",
  needsAttention: [{ id: "task-1", label: "call the dentist", reason: "overdue" }],
  waiting: [{ id: "task-2", label: "Grace: kitchen", reason: "awaiting confirmation" }],
  unresolvedCaptures: [{ id: "task-3", label: "buy groceries", reason: "on your to-do list" }],
};

function toolResponse(input) {
  return {
    ok: true,
    json: async () => ({ content: [{ type: "tool_use", name: "decide_attention_response", input }] }),
  };
}

describe("reasonOverOperationalEvidenceWithClaude", () => {
  it("forces a strict schema tool call, constrains selectable ids to the authorized evidence, and returns the structured input", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue(
      toolResponse({ responseIntent: "list", selectedEvidenceIds: ["task-2"] }),
    );

    const result = await reasonOverOperationalEvidenceWithClaude(
      {
        userMessage: "What else?",
        conversationState: { priorCapability: "attention_summary_read", priorGroundingStatus: "grounded", previouslySurfacedEvidenceIds: ["task-1"], priorObjective: null },
        authorizedEvidence: EVIDENCE,
      },
      fetchMock,
    );

    expect(result).toEqual({ responseIntent: "list", selectedEvidenceIds: ["task-2"] });
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.tool_choice).toEqual({ type: "tool", name: "decide_attention_response" });
    expect(requestBody.tools[0]).toMatchObject({ name: "decide_attention_response", strict: true });
    const idEnum = requestBody.tools[0].input_schema.properties.selectedEvidenceIds.items.enum;
    expect(idEnum).toEqual(expect.arrayContaining(["task-1", "task-2", "task-3"]));
    expect(idEnum).not.toContain("task-4");
  });

  it("includes conversation state and the authorized evidence in the prompt, and never includes accountId/authorization (not part of the input contract at all)", async () => {
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
});

describe("validateAttentionDecision", () => {
  it("accepts a well-formed decision referencing only authorized ids", () => {
    const result = validateAttentionDecision({ responseIntent: "list", selectedEvidenceIds: ["task-1", "task-2"] }, EVIDENCE);
    expect(result).toEqual({
      ok: true,
      decision: { responseIntent: "list", selectedEvidenceIds: ["task-1", "task-2"], rankedEvidenceIds: undefined, needsClarification: null },
    });
  });

  it("rejects a decision referencing any id not in the authorized evidence set", () => {
    const result = validateAttentionDecision({ responseIntent: "list", selectedEvidenceIds: ["task-1", "invented-id"] }, EVIDENCE);
    expect(result).toEqual({ ok: false });
  });

  it("rejects an unknown responseIntent", () => {
    expect(validateAttentionDecision({ responseIntent: "delete_everything", selectedEvidenceIds: [] }, EVIDENCE)).toEqual({ ok: false });
  });

  it("rejects malformed shapes (non-object, missing selectedEvidenceIds, wrong types)", () => {
    expect(validateAttentionDecision(null, EVIDENCE)).toEqual({ ok: false });
    expect(validateAttentionDecision("not an object", EVIDENCE)).toEqual({ ok: false });
    expect(validateAttentionDecision({ responseIntent: "list" }, EVIDENCE)).toEqual({ ok: false });
    expect(validateAttentionDecision({ responseIntent: "list", selectedEvidenceIds: "task-1" }, EVIDENCE)).toEqual({ ok: false });
  });

  it("requires a non-empty selection unless the intent is nothing_new/clarify/not_attention", () => {
    expect(validateAttentionDecision({ responseIntent: "list", selectedEvidenceIds: [] }, EVIDENCE)).toEqual({ ok: false });
    expect(validateAttentionDecision({ responseIntent: "nothing_new", selectedEvidenceIds: [] }, EVIDENCE).ok).toBe(true);
    expect(validateAttentionDecision({ responseIntent: "clarify", selectedEvidenceIds: [], needsClarification: "Which ones?" }, EVIDENCE).ok).toBe(true);
    expect(validateAttentionDecision({ responseIntent: "not_attention", selectedEvidenceIds: [] }, EVIDENCE).ok).toBe(true);
  });

  it("degrades a ranking that references an id outside the selection to no ranking, without rejecting the whole decision", () => {
    const result = validateAttentionDecision(
      { responseIntent: "prioritize", selectedEvidenceIds: ["task-1"], rankedEvidenceIds: ["task-1", "task-2"] },
      EVIDENCE,
    );
    expect(result.ok).toBe(true);
    expect(result.decision.rankedEvidenceIds).toBeUndefined();
  });

  it("accepts a valid ranking that is a subset of the selection", () => {
    const result = validateAttentionDecision(
      { responseIntent: "prioritize", selectedEvidenceIds: ["task-1", "task-2"], rankedEvidenceIds: ["task-2", "task-1"] },
      EVIDENCE,
    );
    expect(result.decision.rankedEvidenceIds).toEqual(["task-2", "task-1"]);
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
});
