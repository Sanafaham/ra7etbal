import { describe, expect, it } from "vitest";
import { deriveCarsonVisualState, type CarsonVisualSignals } from "./carson-visual-state";

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
