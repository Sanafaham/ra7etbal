import { describe, expect, it } from "vitest";
import {
  createCanonicalConsequentialResult,
  resolveCanonicalConsequentialResult,
  resolveConsequentialOwnerMessage,
} from "./carson-consequential-result";

describe("canonical consequential owner results", () => {
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
