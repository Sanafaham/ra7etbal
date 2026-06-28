import { describe, expect, it } from "vitest";
import {
  resolveCarsonDisplayMessage,
  resolveSanitizedCarsonDisplayMessage,
  type DirectToolSuccessResult,
} from "./carson-direct-tool-override";

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

  it("overrides an unrelated agent reply with the successful create_reminder result", () => {
    const result = resolveCarsonDisplayMessage(
      "That sounds like a question about insurance providers.",
      successResult({
        toolName: "create_reminder",
        resultText: "I'll remind you tomorrow at 10:00 AM.",
      }),
      NOW,
    );

    expect(result).toBe("I'll remind you tomorrow at 10:00 AM.");
  });

  it("overrides a generic knowledge answer with the successful create_reminder result", () => {
    const result = resolveCarsonDisplayMessage(
      "As for your question — insurance companies provide financial protection against losses.",
      successResult({
        toolName: "create_reminder",
        resultText: "I'll remind you tomorrow at 10:00 AM.",
      }),
      NOW,
    );

    expect(result).toBe("I'll remind you tomorrow at 10:00 AM.");
  });

  it("overrides a contradictory reminder failure with the successful create_reminder result", () => {
    const result = resolveCarsonDisplayMessage(
      "I wasn't able to create that reminder. Please try again.",
      successResult({
        toolName: "create_reminder",
        resultText: "I'll remind you tomorrow at 10:00 AM.",
      }),
      NOW,
    );

    expect(result).toBe("I'll remind you tomorrow at 10:00 AM.");
  });

  it("does not override a normal, non-contradictory agent message", () => {
    const result = resolveCarsonDisplayMessage(
      "Anything else I can help with?",
      successResult(),
      NOW,
    );
    expect(result).toBe("Anything else I can help with?");
  });

  it("does not override a normal reminder confirmation", () => {
    const result = resolveCarsonDisplayMessage(
      "Reminder created for tomorrow at 10:00 AM.",
      successResult({
        toolName: "create_reminder",
        resultText: "I'll remind you tomorrow at 10:00 AM.",
      }),
      NOW,
    );

    expect(result).toBe("Reminder created for tomorrow at 10:00 AM.");
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

describe("resolveSanitizedCarsonDisplayMessage", () => {
  it("sanitizes an agent message starting with one moment", () => {
    const result = resolveSanitizedCarsonDisplayMessage({
      agentMessage: "One moment. Added to your to-do list.",
      lastSuccess: null,
      now: NOW,
    });

    expect(result).toBe("Added to your to-do list.");
  });

  it("sanitizes an agent message where one moment is the whole reply", () => {
    const result = resolveSanitizedCarsonDisplayMessage({
      agentMessage: "One moment",
      lastSuccess: null,
      now: NOW,
    });

    expect(result).toBe("");
  });

  it("does not let a direct-tool success override bypass Carson reply sanitation", () => {
    const result = resolveSanitizedCarsonDisplayMessage({
      agentMessage: "I wasn't able to save that. Please try again.",
      lastSuccess: successResult({ resultText: "One moment. Added to your to-do list." }),
      now: NOW,
    });

    expect(result).toBe("Added to your to-do list.");
  });

  it("sanitizes the successful create_reminder override before display", () => {
    const result = resolveSanitizedCarsonDisplayMessage({
      agentMessage: "As for your question — insurance companies provide financial protection.",
      lastSuccess: successResult({
        toolName: "create_reminder",
        resultText: "One moment. I'll remind you tomorrow at 10:00 AM.",
      }),
      now: NOW,
    });

    expect(result).toBe("I'll remind you tomorrow at 10:00 AM.");
  });

  it("keeps social acknowledgement fallback natural when the agent reply is only filler", () => {
    const result = resolveSanitizedCarsonDisplayMessage({
      agentMessage: "One moment.",
      previousUserMessage: "thank you",
      lastSuccess: null,
      now: NOW,
    });

    expect(result).toBe("Anytime.");
  });
});
