import { describe, expect, it } from "vitest";
import { preserveDirectMessageReplyIntent } from "./direct-message-reply-intent";

describe("preserveDirectMessageReplyIntent", () => {
  it("preserves the exact production reply request instead of turning it into a factual statement", () => {
    expect(
      preserveDirectMessageReplyIntent(
        `Ask Christopher to reply, "I'll be there in five minutes."`,
        "Christopher",
        "I'll be there in five minutes.",
      ),
    ).toBe(`Please reply: "I'll be there in five minutes."`);
  });

  it("uses the owner's quoted wording when the tool paraphrases it", () => {
    expect(
      preserveDirectMessageReplyIntent(
        "Ask Christopher to reply that we will proceed.",
        "Christopher",
        "We are proceeding.",
      ),
    ).toBe(`Please reply: "we will proceed."`);
  });

  it("reconstructs an already reply-prefixed tool message from the owner transcript", () => {
    expect(
      preserveDirectMessageReplyIntent(
        "Ask Christopher to reply yes.",
        "Christopher",
        "Please reply yes.",
      ),
    ).toBe(`Please reply: "yes."`);
  });

  it("replaces a reply-prefixed model rewrite with the owner's verbatim quoted reply", () => {
    expect(
      preserveDirectMessageReplyIntent(
        `Ask Christopher to reply, "I'll be there in 10 minutes."`,
        "Christopher",
        "Please reply — Sana will be there in 10 minutes.",
      ),
    ).toBe(`Please reply: "I'll be there in 10 minutes."`);
  });

  it("does not alter unrelated direct communication", () => {
    expect(
      preserveDirectMessageReplyIntent(
        "Tell Christopher I'll be there in five minutes.",
        "Christopher",
        "I'll be there in five minutes.",
      ),
    ).toBe("I'll be there in five minutes.");
  });

  it("does not apply one recipient's instruction to another recipient", () => {
    expect(
      preserveDirectMessageReplyIntent(
        "Ask Christopher to reply yes.",
        "Grace",
        "yes",
      ),
    ).toBe("yes");
  });
});
