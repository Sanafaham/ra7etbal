import { describe, expect, it } from "vitest";
import {
  buildCanonicalConsequentialSpeechPayload,
  createCanonicalConsequentialResult,
  resolveCanonicalConsequentialResult,
  resolveConsequentialOwnerMessage,
  resolveConsequentialInstructionSource,
  shouldReplaceProvisionalConsequentialSegment,
  type CanonicalConsequentialResult,
} from "./carson-consequential-result";

describe("canonical consequential owner results", () => {
  it("binds spoken hosting truth to the exact validated owner result", () => {
    const ownerResult = "How many guests are coming?";
    expect(JSON.parse(buildCanonicalConsequentialSpeechPayload(ownerResult))).toEqual({
      response_contract: "speak_owner_result_exactly_without_additions_or_changes",
      owner_result: ownerResult,
    });
  });

  it("keeps the captured verbatim hosting authority when the model tool argument drops it", () => {
    expect(resolveConsequentialInstructionSource({
      capturedOwnerMessage: "I have dinner tomorrow at home. Handle it.",
      lastUserMessage: "I have dinner tomorrow at home. Handle it.",
      toolInstruction: "Dinner tomorrow at home.",
      lastUserIsVague: false,
      isHostingTurn: true,
    })).toBe("I have dinner tomorrow at home. Handle it.");
  });

  it("does not globally replace the existing vague-turn fallback outside hosting", () => {
    expect(resolveConsequentialInstructionSource({
      capturedOwnerMessage: "Yes.",
      lastUserMessage: "Yes.",
      toolInstruction: "Send the approved message to Christopher.",
      lastUserIsVague: true,
      isHostingTurn: false,
    })).toBe("Send the approved message to Christopher.");
  });
  it("renders the validated result for the current owner turn", () => {
    const result = createCanonicalConsequentialResult({
      turnOperationId: "dinner-turn",
      domainOperationId: "dinner-operation",
      toolName: "execute_instruction",
      kind: "executed",
      resultText: "Christopher has the dinner plan. Saeed was not assigned.",
      outcome: "success",
    });

    expect(resolveCanonicalConsequentialResult(result, "dinner-turn")).toBe(
      "Christopher has the dinner plan. Saeed was not assigned.",
    );
  });

  it("rejects a late result from an earlier hosting turn", () => {
    const tea = createCanonicalConsequentialResult({
      turnOperationId: "tea-turn",
      domainOperationId: "tea-operation",
      toolName: "execute_instruction",
      kind: "proposal",
      resultText: "Tea proposal.",
      outcome: "success",
    });

    expect(resolveCanonicalConsequentialResult(tea, "dinner-turn")).toBeNull();
  });

  it("does not replace ordinary conversation when no consequential result exists", () => {
    expect(resolveCanonicalConsequentialResult(null, "ordinary-turn")).toBeNull();
    expect(resolveConsequentialOwnerMessage("How can I help?", null, "ordinary-turn")).toBe(
      "How can I help?",
    );
  });

  it("cannot re-add an eligibility-rejected family recipient from the model reply", () => {
    const result = createCanonicalConsequentialResult({
      turnOperationId: "dinner-turn",
      domainOperationId: "dinner-operation",
      toolName: "execute_instruction",
      kind: "executed",
      resultText: "Christopher has the dinner plan.",
      outcome: "success",
    });

    expect(
      resolveConsequentialOwnerMessage(
        "Christopher and Saeed have the dinner plan.",
        result,
        "dinner-turn",
      ),
    ).toBe("Christopher has the dinner plan.");
  });

  it("accepts the widened outcome union (unclear) and calendar tool names without a type error", () => {
    const result = createCanonicalConsequentialResult({
      turnOperationId: "calendar-turn",
      toolName: "create_calendar_event",
      kind: "rejected",
      resultText: "Could not process that. Network error.",
      outcome: "unclear",
    });
    expect(result.outcome).toBe("unclear");
    expect(result.toolName).toBe("create_calendar_event");
  });
});

describe("shouldReplaceProvisionalConsequentialSegment — one execution, one final confirmation", () => {
  const baseResult: CanonicalConsequentialResult = createCanonicalConsequentialResult({
    turnOperationId: "grace-turn",
    toolName: "execute_instruction",
    kind: "executed",
    resultText: "Grace has it.",
    outcome: "success",
    at: "2026-09-13T10:00:00.000Z",
  });

  it("replaces on the first reveal of a result for the current turn", () => {
    expect(shouldReplaceProvisionalConsequentialSegment(baseResult, "grace-turn", null)).toBe(true);
  });

  it("does not replace again once that exact result has already been shown", () => {
    expect(
      shouldReplaceProvisionalConsequentialSegment(baseResult, "grace-turn", baseResult.at),
    ).toBe(false);
  });

  it("replaces again for a genuinely new result (a retry gets its own execution)", () => {
    const retry = createCanonicalConsequentialResult({
      ...baseResult,
      resultText: "I couldn't send that message to Grace. Please try again.",
      outcome: "failure",
      at: "2026-09-13T10:00:05.000Z",
    });
    expect(
      shouldReplaceProvisionalConsequentialSegment(retry, "grace-turn", baseResult.at),
    ).toBe(true);
  });

  it("never replaces across a turn boundary — no result, no id, or a stale turn", () => {
    expect(shouldReplaceProvisionalConsequentialSegment(null, "grace-turn", null)).toBe(false);
    expect(shouldReplaceProvisionalConsequentialSegment(baseResult, null, null)).toBe(false);
    expect(shouldReplaceProvisionalConsequentialSegment(baseResult, "later-turn", null)).toBe(false);
  });

  it("holds identically for Arabic result text — the decision is keyed on result identity, never on language", () => {
    const arabicSuccess = createCanonicalConsequentialResult({
      turnOperationId: "grace-turn-ar",
      toolName: "send_direct_whatsapp_message",
      kind: "direct_message",
      resultText: "أرسلت الرسالة إلى كريستوفر.", // "I sent the message to Christopher."
      outcome: "success",
      at: "2026-09-13T11:00:00.000Z",
    });
    expect(
      shouldReplaceProvisionalConsequentialSegment(arabicSuccess, "grace-turn-ar", null),
    ).toBe(true);
    // Same result shown again (e.g. a third onMessage segment) must not
    // trigger a second replace — exactly one confirmation, regardless of script.
    expect(
      shouldReplaceProvisionalConsequentialSegment(arabicSuccess, "grace-turn-ar", arabicSuccess.at),
    ).toBe(false);

    const arabicFailure = createCanonicalConsequentialResult({
      turnOperationId: "grace-turn-ar-2",
      toolName: "send_direct_whatsapp_message",
      kind: "direct_message",
      resultText: "لم أتمكن من إرسال الرسالة. حاول مرة أخرى.", // "I couldn't send the message. Try again."
      outcome: "failure",
      at: "2026-09-13T11:05:00.000Z",
    });
    expect(
      shouldReplaceProvisionalConsequentialSegment(arabicFailure, "grace-turn-ar-2", null),
    ).toBe(true);
  });
});
