import { describe, expect, it } from "vitest";
import {
  getSocialAcknowledgementReply,
  isSocialAcknowledgement,
  sanitizeCarsonReplyText,
  sanitizeSocialAcknowledgementReply,
  shouldSuppressCarsonIdlePrompt,
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

  it.each([
    ["One moment. Anytime.", "Anytime."],
    ["Got it. You're welcome.", "You're welcome."],
    ["Hold on. Of course.", "Of course."],
    ["Just a second. Of course.", "Of course."],
    ["One moment, got it — Anytime.", "Anytime."],
  ])("strips execution filler from social replies: '%s'", (input, expected) => {
    const reply = sanitizeSocialAcknowledgementReply(input);
    expect(reply).toBe(expected);
    expect(reply).not.toMatch(/one moment|hold on|got it/i);
  });

  it("falls back to a natural social reply if a social reply is only filler", () => {
    expect(sanitizeSocialAcknowledgementReply("One moment.")).toBe("Anytime.");
  });
});

describe("Carson global reply text sanitation", () => {
  it.each([
    ["One moment. Anytime.", "Anytime."],
    ["One moment. Still there?", "Still there?"],
    ["Got it. Done.", "Done."],
    ["Hold on. Done.", "Done."],
    ["Just a second. Done.", "Done."],
  ])("strips filler prefixes globally: '%s'", (input, expected) => {
    expect(sanitizeCarsonReplyText(input)).toBe(expected);
  });

  it("leaves normal Carson sentences unchanged", () => {
    expect(sanitizeCarsonReplyText("Done. I asked Grace to send the photos.")).toBe(
      "Done. I asked Grace to send the photos.",
    );
  });

  it.each([
    "One moment. Still there?",
    "Still there, سيدتي الجميلة?",
    "Are you there?",
  ])("detects idle nag prompts for suppression: '%s'", (text) => {
    expect(shouldSuppressCarsonIdlePrompt(text)).toBe(true);
  });
});
