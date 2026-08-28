import { describe, expect, it } from "vitest";
import {
  deriveCarsonVisualState,
  shouldShowCarsonVoiceTranscript,
  type CarsonVisualSignals,
} from "./carson-visual-state";

const base: CarsonVisualSignals = {
  status: "connected",
  channel: "voice",
  mode: "listening",
  turnPhase: "idle",
  outcome: "none",
};

describe("deriveCarsonVisualState", () => {
  it("maps real conversation and tool signals with truthful precedence", () => {
    expect(deriveCarsonVisualState(base)).toBe("listening");
    expect(deriveCarsonVisualState({ ...base, turnPhase: "thinking" })).toBe("thinking");
    expect(deriveCarsonVisualState({ ...base, turnPhase: "acting" })).toBe("working");
    expect(deriveCarsonVisualState({ ...base, mode: "speaking", turnPhase: "acting" })).toBe("speaking");
    expect(deriveCarsonVisualState({ ...base, outcome: "complete" })).toBe("complete");
  });

  it("never lets a completion signal override an error", () => {
    expect(deriveCarsonVisualState({ ...base, status: "error", outcome: "complete" })).toBe("error");
    expect(deriveCarsonVisualState({ ...base, outcome: "error" })).toBe("error");
  });

  it("keeps disconnected and text sessions visually idle", () => {
    expect(deriveCarsonVisualState({ ...base, status: "idle" })).toBe("idle");
    expect(deriveCarsonVisualState({ ...base, channel: "text", turnPhase: "acting" })).toBe("idle");
  });
});

describe("shouldShowCarsonVoiceTranscript", () => {
  it("keeps the Carson Core primary during an active voice session", () => {
    expect(
      shouldShowCarsonVoiceTranscript({
        status: "connected",
        channel: "voice",
        hasMessage: true,
      }),
    ).toBe(false);
  });

  it("restores the finalized response after the voice session ends", () => {
    expect(
      shouldShowCarsonVoiceTranscript({ status: "idle", channel: "voice", hasMessage: true }),
    ).toBe(true);
    expect(
      shouldShowCarsonVoiceTranscript({ status: "error", channel: "voice", hasMessage: true }),
    ).toBe(true);
  });

  it("does not affect typed chat or render an empty response", () => {
    expect(
      shouldShowCarsonVoiceTranscript({ status: "idle", channel: "text", hasMessage: true }),
    ).toBe(false);
    expect(
      shouldShowCarsonVoiceTranscript({ status: "idle", channel: "voice", hasMessage: false }),
    ).toBe(false);
  });
});
