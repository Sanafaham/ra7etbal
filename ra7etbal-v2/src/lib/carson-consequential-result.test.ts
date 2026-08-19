import { describe, expect, it } from "vitest";
import {
  buildCanonicalConsequentialSpeechPayload,
  createCanonicalConsequentialResult,
  resolveCanonicalConsequentialResult,
  resolveConsequentialOwnerMessage,
  resolveConsequentialInstructionSource,
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
});
