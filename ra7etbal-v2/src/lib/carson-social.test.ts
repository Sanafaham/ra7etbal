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
    expect(["You're welcome.", "Anytime.", "I've got you."]).toContain(reply);
    expect(reply).not.toMatch(/one moment|hold on|got it|of course/i);
  });

  it.each([
    ["One moment. Anytime.", "Anytime."],
    ["Got it. You're welcome.", "You're welcome."],
    ["Hold on. Anytime.", "Anytime."],
    ["Just a second. I've got you.", "I've got you."],
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
    ["Got it. Grace has it.", "Grace has it."],
    ["Hold on. Grace has it.", "Grace has it."],
    ["Just a second. Grace has it.", "Grace has it."],
    ["Certainly. Grace has it.", "Grace has it."],
    ["I understand. Grace has it.", "Grace has it."],
    ["Processing. Grace has it.", "Grace has it."],
    ["I'll analyze that. Grace has it.", "Grace has it."],
    ["Let me check. Grace has it.", "Grace has it."],
    ["Done. Grace has it.", "Grace has it."],
    ["Of course. Grace has it.", "Grace has it."],
  ])("strips filler prefixes globally: '%s'", (input, expected) => {
    expect(sanitizeCarsonReplyText(input)).toBe(expected);
  });

  it.each([
    ["Based on the attached photo, I asked Grace to recreate it.", "I asked Grace to recreate it."],
    ["Based on your request, I sent it to Christopher.", "I sent it to Christopher."],
    ["It appears that Christopher confirmed.", "Christopher confirmed."],
    ["According to your Ra7etBal data, you're clear.", "you're clear."],
    ["The attached image shows receipts.", "receipts."],
  ])("strips reasoning prefixes globally: '%s'", (input, expected) => {
    expect(sanitizeCarsonReplyText(input)).toBe(expected);
  });

  it("leaves normal Carson sentences unchanged", () => {
    expect(sanitizeCarsonReplyText("Grace has it. I'll follow up if needed.")).toBe(
      "Grace has it. I'll follow up if needed.",
    );
  });

  it("removes internal operation sentences from displayed replies", () => {
    expect(
      sanitizeCarsonReplyText(
        "Grace has it. Photo context was available for this action. Do not mention it unless the user asks.",
      ),
    ).toBe("Grace has it.");
  });

  it.each([
    "One moment. Still there?",
    "Still there, سيدتي الجميلة?",
    "Are you there?",
  ])("detects idle nag prompts for suppression: '%s'", (text) => {
    expect(shouldSuppressCarsonIdlePrompt(text)).toBe(true);
  });
});
