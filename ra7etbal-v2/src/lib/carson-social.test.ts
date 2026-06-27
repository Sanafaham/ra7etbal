import { describe, expect, it } from "vitest";
import {
  CARSON_RETRY_FALLBACK_REPLY,
  containsTechnicalSupportDeflection,
  getSocialAcknowledgementReply,
  isSocialAcknowledgement,
  sanitizeCarsonErrorDetail,
  sanitizeCarsonReplyText,
  sanitizeSocialAcknowledgementReply,
  shouldSuppressCarsonIdlePrompt,
  stripIdentityCorrections,
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
    ["One moment. Grace has it.", "Grace has it."],
    ["One moment while I check that. Grace has it.", "Grace has it."],
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

  it.each([
    ["Grace has it. Are you there?", "Grace has it"],
    ["Still there, Sana? Grace has it.", "Grace has it."],
    ["Grace has it. Are you still there?", "Grace has it"],
    ["Grace has it. Still there?", "Grace has it"],
  ])("removes idle prompts from mixed Carson replies: '%s'", (input, expected) => {
    expect(sanitizeCarsonReplyText(input)).toBe(expected);
    expect(sanitizeCarsonReplyText(input)).not.toMatch(/are you there|are you still there|still there/i);
  });

  it.each([
    ["Would you like me to send that?", ""],
    ["Do you want me to message Christopher?", ""],
    ["Should I send it to Grace?", ""],
    ["Shall I add that to your calendar?", ""],
  ])("removes low-value permission questions: '%s'", (input, expected) => {
    expect(sanitizeCarsonReplyText(input)).toBe(expected);
  });

  it("removes internal operation sentences from displayed replies", () => {
    expect(
      sanitizeCarsonReplyText(
        "Grace has it. Photo context was available for this action. Do not mention it unless the user asks.",
      ),
    ).toBe("Grace has it.");
  });

  it.each([
    "One moment.",
    "One moment. Still there?",
    "Still there, سيدتي الجميلة?",
    "Are you there?",
    "Are you still there?",
  ])("detects idle nag prompts for suppression: '%s'", (text) => {
    expect(shouldSuppressCarsonIdlePrompt(text)).toBe(true);
  });

  it("does not suppress useful replies after removing an idle sentence", () => {
    const text = "Grace has it. Are you there?";
    expect(sanitizeCarsonReplyText(text)).toBe("Grace has it");
    expect(shouldSuppressCarsonIdlePrompt(text)).toBe(false);
  });
});

// Chief of Staff Behavior Policy regressions ---------------------------------
// Carson must execute on clear intent and ignore misheard/garbled words
// around it, rather than correcting the user's name, wording, or the
// transcript itself. Live example: a misheard "remind me" became "Rimaan,
// will you call Loulya" and Carson replied "Your name is Sana, not Rimaan —
// I'm Carson" instead of confirming the reminder it had already created.
describe("stripIdentityCorrections — misheard name does not trigger correction", () => {
  it("strips a name-correction sentence while keeping the action confirmation", () => {
    const text = "Your name is Sana, not Rimaan — I'm Carson, your Chief of Staff. Done. I'll remind you in one minute.";
    expect(stripIdentityCorrections(text)).toBe("Done. I'll remind you in one minute.");
  });

  it.each([
    ["I'm Carson, not Rimaan. Sent to Grace.", "Sent to Grace."],
    ["You called me the wrong name. Saved.", "Saved."],
    ["That's not my name. Added to your calendar.", "Added to your calendar."],
    ["I think you meant Carson. I'll follow up tomorrow.", "I'll follow up tomorrow."],
  ])("strips identity-correction phrasing: '%s'", (input, expected) => {
    expect(stripIdentityCorrections(input)).toBe(expected);
  });

  it("leaves a clean confirmation completely unchanged", () => {
    expect(stripIdentityCorrections("Done. I'll remind you in one minute.")).toBe(
      "Done. I'll remind you in one minute.",
    );
  });

  it("is wired into the main reply sanitizer used for both voice and text replies", () => {
    const text = "Your name is Sana, not Rimaan — I'm Carson, your Chief of Staff. Done. I'll remind you in one minute.";
    expect(sanitizeCarsonReplyText(text)).toBe("Done. I'll remind you in one minute.");
  });
});

describe("successful action replies stay short confirmations only", () => {
  it.each([
    "I'll remind you in one minute.",
    "Sent to Grace.",
    "Added to your calendar.",
    "I'll follow up tomorrow.",
    "Saved.",
  ])("passes a clean short confirmation through unchanged: '%s'", (reply) => {
    expect(sanitizeCarsonReplyText(reply)).toBe(reply);
  });

  it("a successful WhatsApp send confirmation never contains failure language", () => {
    const reply = sanitizeCarsonReplyText("Sent to Grace.");
    expect(reply).not.toMatch(/not delivered|failed|couldn't complete|try again/i);
  });
});

// P0 live bug — Voice Carson To-do creation. User asked Carson to add a
// to-do; it did not complete, and Carson freelanced a tech-support
// deflection instead of asking the user to repeat the request.
describe("containsTechnicalSupportDeflection / CARSON_RETRY_FALLBACK_REPLY — P0 To-do fallback fix", () => {
  it("detects the exact live transcript that triggered this fix", () => {
    const liveTranscript =
      "I don't have visibility into technical issues with the To-Do feature itself — that's something the Rahet Bal team would need to look into. You can report it through the app's support or settings, and I can help you draft that message if you'd like.";
    expect(containsTechnicalSupportDeflection(liveTranscript)).toBe(true);
    expect(sanitizeCarsonReplyText(liveTranscript)).toBe(CARSON_RETRY_FALLBACK_REPLY);
  });

  it.each([
    "There seems to be a technical issue. Please contact support.",
    "You may want to reach out to support about this.",
    "I'd recommend reaching out to the support team.",
    "I don't have visibility into that — the Rahet Bal team would need to look into it.",
    "You can report this through the app's support or settings.",
  ])("replaces tech-support deflection with the clean retry line: '%s'", (input) => {
    expect(sanitizeCarsonReplyText(input)).toBe(CARSON_RETRY_FALLBACK_REPLY);
  });

  it("never offers to save the request as a note instead, once flagged as a deflection", () => {
    const liveTranscript =
      "There's a technical issue with that feature. I can save this as a note instead, if you'd like.";
    const result = sanitizeCarsonReplyText(liveTranscript);
    expect(result).toBe(CARSON_RETRY_FALLBACK_REPLY);
    expect(result).not.toMatch(/save.*as a note/i);
  });

  it("leaves a clean retry message completely unchanged", () => {
    expect(sanitizeCarsonReplyText("I wasn't able to save that. Please say the to-do again.")).toBe(
      "I wasn't able to save that. Please say the to-do again.",
    );
  });

  it("does not flag normal successful confirmations", () => {
    expect(containsTechnicalSupportDeflection("Added to your to-do list.")).toBe(false);
    expect(containsTechnicalSupportDeflection("Grace has it.")).toBe(false);
  });
});

describe("sanitizeCarsonErrorDetail — internal error language is sanitized", () => {
  it.each([
    new Error("(#132000) Number of parameters does not match the expected number of params"),
    new Error("Meta API request failed with status 400"),
    new Error("Request to backend pipeline timed out while retrying"),
    new Error("fetch failed: connect ECONNREFUSED"),
    "a raw string thrown instead of an Error",
    undefined,
  ])("never echoes internal system detail for: %#", (err) => {
    const detail = sanitizeCarsonErrorDetail(err);
    expect(detail).toMatch(/^(Please try again\.|Please check your connection\.)$/);
    expect(detail).not.toMatch(/meta|api|backend|pipeline|retry|retrying|timeout|timed out|econnrefused|132000/i);
  });

  it("returns a connection-specific phrase only for genuine network/TypeError failures", () => {
    expect(sanitizeCarsonErrorDetail(new TypeError("Failed to fetch"))).toBe(
      "Please check your connection.",
    );
  });

  it("returns the generic fallback for non-network errors", () => {
    expect(sanitizeCarsonErrorDetail(new Error("Could not save the reminder"))).toBe(
      "Please try again.",
    );
  });
});
