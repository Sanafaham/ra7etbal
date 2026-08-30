import { describe, it, expect } from "vitest";
import {
  buildToolExecutionResult,
  enforceNoSemanticUpgrade,
  finalizeCarsonResponse,
  finalizeOrdinaryResponse,
} from "./_carson-tool-execution-result.js";

describe("buildToolExecutionResult", () => {
  it("does not infer success from an unclassified/uncertain tool's text", () => {
    const result = buildToolExecutionResult({
      toolName: "send_followup",
      rawText: "Done! Followed up with Christopher.",
      deterministicOutcome: undefined,
    });
    expect(result.outcome).toBe("uncertain");
  });

  it("trusts a genuinely deterministic outcome when supplied", () => {
    const result = buildToolExecutionResult({
      toolName: "create_calendar_event",
      rawText: "Dentist is on your calendar Tuesday at 3 PM.",
      deterministicOutcome: "success",
    });
    expect(result.outcome).toBe("success");
  });

  it("never sets response_mode exact unless the tool is exact-capable AND the caller declares exact", () => {
    const a = buildToolExecutionResult({ toolName: "create_calendar_event", rawText: "x", exact: true });
    expect(a.response_mode).toBe("natural"); // calendar cannot be exact
    const b = buildToolExecutionResult({ toolName: "execute_instruction", rawText: "Shall I send the plan?", exact: false });
    expect(b.response_mode).toBe("natural"); // not declared exact
    const c = buildToolExecutionResult({ toolName: "execute_instruction", rawText: "Shall I send the plan?", exact: true });
    expect(c.response_mode).toBe("exact");
  });
});

describe("enforceNoSemanticUpgrade — the C-03 failure-injection acceptance test", () => {
  it("CASE A: verified failure, model draft claims success -> false success never emitted", () => {
    const toolResult = buildToolExecutionResult({
      toolName: "create_calendar_event",
      rawText: "I couldn't add the event to your calendar. Please try again.",
      deterministicOutcome: "failure",
    });
    const draft = "Done! I've added the dentist appointment to your calendar.";
    const { text, wasRejected } = enforceNoSemanticUpgrade(toolResult, draft);
    expect(wasRejected).toBe(true);
    expect(text).not.toContain("Done!");
    expect(text).toBe(toolResult.text);
  });

  it("CASE B: verified success, model draft claims failure -> false failure never emitted", () => {
    const toolResult = buildToolExecutionResult({
      toolName: "create_todo",
      rawText: "Added to your to-do list.",
      deterministicOutcome: "success",
    });
    const draft = "I wasn't able to save that.";
    const { text, wasRejected } = enforceNoSemanticUpgrade(toolResult, draft);
    expect(wasRejected).toBe(true);
    expect(text).not.toMatch(/wasn't able/i);
  });

  it("uncertain outcome rejects a confident 'confirmed' draft", () => {
    const toolResult = buildToolExecutionResult({
      toolName: "send_followup",
      rawText: "Followed up with Christopher.",
      deterministicOutcome: undefined, // -> uncertain
    });
    const { wasRejected } = enforceNoSemanticUpgrade(toolResult, "Confirmed, done.");
    expect(wasRejected).toBe(true);
  });

  it("a truthful draft that matches the verified outcome passes through unchanged", () => {
    const toolResult = buildToolExecutionResult({
      toolName: "create_calendar_event",
      rawText: "Dentist is on your calendar Tuesday at 3 PM.",
      deterministicOutcome: "success",
    });
    const { text, wasRejected } = enforceNoSemanticUpgrade(toolResult, toolResult.text);
    expect(wasRejected).toBe(false);
    expect(text).toBe(toolResult.text);
  });
});

describe("finalizeCarsonResponse", () => {
  it("exact mode bypasses generation and validation entirely — same string, untouched", () => {
    const toolResult = buildToolExecutionResult({
      toolName: "execute_instruction",
      rawText: "You already have a meeting at 3. Add the dentist anyway?",
      exact: true,
      deterministicOutcome: "success",
    });
    const final = finalizeCarsonResponse({
      toolResult,
      candidateDraft: "Something different the model might have said",
      turnId: "t1",
    });
    expect(final.response_mode).toBe("exact");
    expect(final.text).toBe("You already have a meeting at 3. Add the dentist anyway?");
  });

  it("natural mode applies the no-upgrade check", () => {
    const toolResult = buildToolExecutionResult({
      toolName: "create_calendar_event",
      rawText: "I couldn't add the event to your calendar. Please try again.",
      deterministicOutcome: "failure",
    });
    const final = finalizeCarsonResponse({ toolResult, candidateDraft: "Done, added!", turnId: "t2" });
    expect(final.response_mode).toBe("natural");
    expect(final.text).not.toMatch(/Done, added/);
    expect(final.execution_status.outcome).toBe("failure");
  });

  it("carries turn_id through for persistence/dedup", () => {
    const toolResult = buildToolExecutionResult({ toolName: "create_todo", rawText: "Added.", deterministicOutcome: "success" });
    const final = finalizeCarsonResponse({ toolResult, candidateDraft: "Added.", turnId: "abc123" });
    expect(final.turn_id).toBe("abc123");
  });
});

describe("finalizeOrdinaryResponse", () => {
  it("passes non-tool conversational text through as the one final response", () => {
    const final = finalizeOrdinaryResponse({ text: "Sure, I can help with that.", turnId: "t3" });
    expect(final).toEqual({ text: "Sure, I can help with that.", response_mode: "natural", turn_id: "t3" });
  });
});
