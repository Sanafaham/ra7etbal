import { describe, expect, it } from "vitest";
import { resolveCarsonDisplayMessage, type DirectToolSuccessResult } from "./carson-direct-tool-override";

const NOW = Date.parse("2026-06-28T00:02:20.000Z");

function successResult(overrides: Partial<DirectToolSuccessResult> = {}): DirectToolSuccessResult {
  return {
    toolName: "create_todo",
    resultText: "Added to your to-do list.",
    at: "2026-06-28T00:02:18.943Z",
    ...overrides,
  };
}

describe("resolveCarsonDisplayMessage", () => {
  it("overrides a contradictory failure message with the successful create_todo result", () => {
    const result = resolveCarsonDisplayMessage(
      "I wasn't able to save that. Please try again.",
      successResult(),
      NOW,
    );
    expect(result).toBe("Added to your to-do list.");
  });

  it("overrides a contradictory failure message with the successful complete_todo result", () => {
    const result = resolveCarsonDisplayMessage(
      "I couldn't complete that. Please try again.",
      successResult({ toolName: "complete_todo", resultText: "Done. I've marked that complete." }),
      NOW,
    );
    expect(result).toBe("Done. I've marked that complete.");
  });

  it("does not override a normal, non-contradictory agent message", () => {
    const result = resolveCarsonDisplayMessage(
      "Anything else I can help with?",
      successResult(),
      NOW,
    );
    expect(result).toBe("Anything else I can help with?");
  });

  it("does not override when there is no recent successful tool result", () => {
    const result = resolveCarsonDisplayMessage(
      "I wasn't able to save that. Please try again.",
      null,
      NOW,
    );
    expect(result).toBe("I wasn't able to save that. Please try again.");
  });

  it("does not override for tools outside the allow-list", () => {
    const result = resolveCarsonDisplayMessage(
      "I wasn't able to save that. Please try again.",
      successResult({ toolName: "save_note", resultText: "Saved." }),
      NOW,
    );
    expect(result).toBe("I wasn't able to save that. Please try again.");
  });

  it("does not override once the success result is outside the time window", () => {
    const result = resolveCarsonDisplayMessage(
      "I wasn't able to save that. Please try again.",
      successResult({ at: "2026-06-28T00:01:00.000Z" }),
      NOW,
    );
    expect(result).toBe("I wasn't able to save that. Please try again.");
  });

  it.each([
    "I wasn't able to save that.",
    "I wasn’t able to do that.",
    "I couldn't complete that.",
    "Please try again.",
    "There seems to be a technical issue.",
    "Please contact support.",
  ])("recognizes failure language: '%s'", (failureMessage) => {
    expect(resolveCarsonDisplayMessage(failureMessage, successResult(), NOW)).toBe(
      "Added to your to-do list.",
    );
  });
});
