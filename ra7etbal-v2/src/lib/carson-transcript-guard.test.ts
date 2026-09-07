import { describe, expect, it } from "vitest";
import {
  CARSON_REPEAT_PROMPT,
  evaluateCarsonTranscriptCapture,
  matchCarsonSocialAcknowledgment,
} from "./carson-transcript-guard";

describe("evaluateCarsonTranscriptCapture", () => {
  it("rejects empty transcript capture", () => {
    expect(evaluateCarsonTranscriptCapture("")).toEqual({
      valid: false,
      reason: "empty",
    });
  });

  it("rejects junk ellipsis capture", () => {
    expect(evaluateCarsonTranscriptCapture("...")).toEqual({
      valid: false,
      reason: "ellipsis",
    });
  });

  it("rejects punctuation-only capture", () => {
    expect(evaluateCarsonTranscriptCapture("?! ,")).toEqual({
      valid: false,
      reason: "punctuation_only",
    });
  });

  it("rejects clipped call fragments so Carson does not ask from stale or missing recipient context", () => {
    expect(evaluateCarsonTranscriptCapture("Call me")).toEqual({
      valid: false,
      reason: "clipped_call_fragment",
    });
  });

  it("allows valid delegation, reminder, and inbox thought language", () => {
    expect(evaluateCarsonTranscriptCapture("Ask Nasira to call me").valid).toBe(true);
    expect(evaluateCarsonTranscriptCapture("Remind me to call Nasira tomorrow at 9").valid).toBe(true);
    expect(evaluateCarsonTranscriptCapture("Remember this idea for the garden").valid).toBe(true);
  });

  it("uses the repeat prompt required for failed capture", () => {
    expect(CARSON_REPEAT_PROMPT).toBe("I didn't catch that. Please say it again.");
  });

  it("still treats short social phrases as validly heard turns (evaluateCarsonTranscriptCapture itself never rejects them)", () => {
    expect(evaluateCarsonTranscriptCapture("Thank you.").valid).toBe(true);
    expect(evaluateCarsonTranscriptCapture("Okay.").valid).toBe(true);
    expect(evaluateCarsonTranscriptCapture("Good night.").valid).toBe(true);
  });
});

// Production bug: "Thank you." was correctly heard, but the tool the LLM
// called on it ended up with an invalid/empty instruction and the capture
// guard answered "I didn't catch that. Please say it again." — misleading,
// since the transcript was heard fine; there was just nothing to act on.
describe("matchCarsonSocialAcknowledgment", () => {
  it("recognizes gratitude phrases with a warm reply", () => {
    expect(matchCarsonSocialAcknowledgment("Thank you.")).toBe("You're welcome!");
    expect(matchCarsonSocialAcknowledgment("Thanks")).toBe("You're welcome!");
    expect(matchCarsonSocialAcknowledgment("Thanks so much!")).toBe("You're welcome!");
    expect(matchCarsonSocialAcknowledgment("thank you very much.")).toBe("You're welcome!");
  });

  it("recognizes closing acknowledgments required by spec (Okay, Got it, That's all)", () => {
    expect(matchCarsonSocialAcknowledgment("Okay.")).toBe("Got it.");
    expect(matchCarsonSocialAcknowledgment("Got it")).toBe("Got it.");
    expect(matchCarsonSocialAcknowledgment("That's all.")).toBe("Got it.");
    expect(matchCarsonSocialAcknowledgment("Alright")).toBe("Got it.");
  });

  it("recognizes a good-night sign-off", () => {
    expect(matchCarsonSocialAcknowledgment("Good night.")).toBe("Good night!");
    expect(matchCarsonSocialAcknowledgment("Goodnight")).toBe("Good night!");
  });

  it("is case-insensitive and tolerant of trailing punctuation/whitespace", () => {
    expect(matchCarsonSocialAcknowledgment("  THANK YOU!  ")).toBe("You're welcome!");
  });

  it("does not match real instructions, so noise/garble protection is not weakened", () => {
    expect(matchCarsonSocialAcknowledgment("Ask Nasira to call me")).toBeNull();
    expect(matchCarsonSocialAcknowledgment("Remind me to call Ghulam tomorrow")).toBeNull();
    expect(matchCarsonSocialAcknowledgment("...")).toBeNull();
    expect(matchCarsonSocialAcknowledgment("Call me")).toBeNull();
    expect(matchCarsonSocialAcknowledgment("")).toBeNull();
    expect(matchCarsonSocialAcknowledgment(null)).toBeNull();
  });

  // Second confirmed production bug: "Thank you. Look." (owner spoke a
  // recognized acknowledgment immediately followed by a harmless
  // conversational fragment) still produced CARSON_REPEAT_PROMPT, because
  // the original regexes were anchored to the ENTIRE string, not just the
  // acknowledgment lead. Four categories, per the incident brief:
  describe("acknowledgment followed by more speech (confirmed production regression)", () => {
    it('pure acknowledgment — exact regression phrase "Thank you. Look."', () => {
      expect(matchCarsonSocialAcknowledgment("Thank you. Look.")).toBe(
        "You're welcome!",
      );
    });

    it("acknowledgment followed by another short, non-actionable conversational fragment", () => {
      expect(matchCarsonSocialAcknowledgment("Thanks. Yeah.")).toBe(
        "You're welcome!",
      );
      expect(matchCarsonSocialAcknowledgment("Okay. Hmm, anyway.")).toBe(
        "Got it.",
      );
    });

    it("acknowledgment followed by an actionable request is NOT swallowed — returns null so the real instruction still reaches normal handling", () => {
      expect(
        matchCarsonSocialAcknowledgment("Thank you, can you call Grace?"),
      ).toBeNull();
      expect(
        matchCarsonSocialAcknowledgment(
          "Thanks. Also remind me to buy milk tomorrow.",
        ),
      ).toBeNull();
      expect(
        matchCarsonSocialAcknowledgment("Okay, please schedule the meeting."),
      ).toBeNull();
    });

    it("acknowledgment followed by a long, genuinely-unclear-length remainder is NOT treated as a pure ack (falls through to normal capture handling instead of guessing)", () => {
      expect(
        matchCarsonSocialAcknowledgment(
          "Thanks so much for that, it really means a lot to me today",
        ),
      ).toBeNull();
    });

    it("genuinely unintelligible/incomplete speech is still rejected upstream by evaluateCarsonTranscriptCapture, unaffected by this widening", () => {
      expect(evaluateCarsonTranscriptCapture("...").valid).toBe(false);
      expect(evaluateCarsonTranscriptCapture("").valid).toBe(false);
      expect(matchCarsonSocialAcknowledgment("...")).toBeNull();
    });
  });
});
