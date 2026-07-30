import { describe, expect, it } from "vitest";
import { preserveDirectCommunicationMeaning } from "./communication-vs-delegation";

describe("preserveDirectCommunicationMeaning", () => {
  it.each([
    [
      "Ask Sana to reply yes on WhatsApp.",
      "yes",
      "Please reply yes on WhatsApp.",
    ],
    [
      "Tell Sana to confirm she received it.",
      "she received it",
      "Please confirm she received it.",
    ],
    [
      "Have Sana respond with the delivery time.",
      "the delivery time",
      "Please respond with the delivery time.",
    ],
    [
      "Get Sana to say whether she approves.",
      "whether she approves",
      "Please say whether she approves.",
    ],
  ])("preserves the requested communication meaning for %s", (utterance, modelMessage, expected) => {
    expect(preserveDirectCommunicationMeaning(utterance, "Sana", modelMessage)).toBe(expected);
  });

  it("does not alter ordinary direct-message content", () => {
    expect(
      preserveDirectCommunicationMeaning(
        "Tell Sana the delivery is approved.",
        "Sana",
        "The delivery is approved.",
      ),
    ).toBe("The delivery is approved.");
  });

  it("does not reinterpret genuine work as communication", () => {
    expect(
      preserveDirectCommunicationMeaning(
        "Ask Sana to buy olive oil tomorrow.",
        "Sana",
        "Buy olive oil tomorrow.",
      ),
    ).toBe("Buy olive oil tomorrow.");
  });
});
