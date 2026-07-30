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

  it.each([
    [
      "Ask Christopher to reply yes if he can come tomorrow, then tell Grace to order more chairs.",
      "Christopher",
      "yes if he can come tomorrow, then tell Grace to order more chairs",
      "Please reply yes if he can come tomorrow.",
    ],
    [
      "Tell Sana to confirm she received it, and ask Christopher to check the delivery.",
      "Sana",
      "she received it, and ask Christopher to check the delivery",
      "Please confirm she received it.",
    ],
    [
      "Have Sana respond with the delivery time and tell Grace the supplier called.",
      "Sana",
      "with the delivery time and tell Grace the supplier called",
      "Please respond with the delivery time.",
    ],
    [
      "Get Sana to say whether she approves, then have Christopher place the order.",
      "Sana",
      "whether she approves, then have Christopher place the order",
      "Please say whether she approves.",
    ],
  ])("stops before a second named-person instruction: %s", (utterance, recipient, payload, expected) => {
    expect(preserveDirectCommunicationMeaning(utterance, recipient, payload)).toBe(expected);
  });

  it("preserves an ordinary single-clause confirmation request", () => {
    expect(
      preserveDirectCommunicationMeaning(
        "Ask Christopher to confirm he's done and let me know once it's finished.",
        "Christopher",
        "he's done and let me know once it's finished",
      ),
    ).toBe("Please confirm he's done and let me know once it's finished.");
  });
});
