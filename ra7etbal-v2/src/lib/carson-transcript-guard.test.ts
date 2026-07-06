import { describe, expect, it } from "vitest";
import {
  CARSON_REPEAT_PROMPT,
  evaluateCarsonTranscriptCapture,
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
});
