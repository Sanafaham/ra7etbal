import { describe, expect, it } from "vitest";
import {
  getSocialAcknowledgementReply,
  isSocialAcknowledgement,
} from "./carson-social";

describe("Carson social acknowledgement detection", () => {
  it.each([
    "thank you",
    "thanks",
    "okay thanks",
    "perfect thanks",
    "thank you Carson",
    "Thanks, Carson.",
  ])("treats '%s' as social acknowledgement only", (text) => {
    expect(isSocialAcknowledgement(text)).toBe(true);
  });

  it.each([
    "Text Christopher saying thank you",
    "Tell Grace thank you",
    "Ask Grace to bring flowers and tell her thank you",
    "thanks, remind me tomorrow",
  ])("does not treat work-containing text as social-only: '%s'", (text) => {
    expect(isSocialAcknowledgement(text)).toBe(false);
  });

  it("returns a short natural reply without execution preamble", () => {
    const reply = getSocialAcknowledgementReply("thank you");
    expect(["You're welcome.", "Of course.", "Anytime."]).toContain(reply);
    expect(reply).not.toMatch(/one moment|hold on|got it/i);
  });
});
