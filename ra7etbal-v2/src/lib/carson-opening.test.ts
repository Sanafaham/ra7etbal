import { describe, expect, it } from "vitest";
import { buildCarsonOpeningLine } from "./carson-opening";

describe("buildCarsonOpeningLine", () => {
  it("does not return the old robotic 'I'm here' opening", () => {
    const line = buildCarsonOpeningLine({
      isFirstSessionToday: false,
      displayName: "Sana",
      now: new Date("2026-06-29T10:00:00"),
      variantIndex: 0,
    });

    expect(line).toBe("Good morning, Sana.");
    expect(line).not.toMatch(/\bI(?:'|’)m here\b/i);
  });

  it("uses the user's name when available", () => {
    expect(
      buildCarsonOpeningLine({
        isFirstSessionToday: false,
        displayName: "Sana",
        now: new Date("2026-06-29T19:00:00"),
        variantIndex: 1,
      }),
    ).toBe("Welcome back, Sana.");
  });

  it("varies across calls when variantIndex changes", () => {
    const first = buildCarsonOpeningLine({
      isFirstSessionToday: false,
      displayName: "Sana",
      now: new Date("2026-06-29T19:00:00"),
      variantIndex: 0,
    });
    const second = buildCarsonOpeningLine({
      isFirstSessionToday: false,
      displayName: "Sana",
      now: new Date("2026-06-29T19:00:00"),
      variantIndex: 1,
    });
    const third = buildCarsonOpeningLine({
      isFirstSessionToday: false,
      displayName: "Sana",
      now: new Date("2026-06-29T19:00:00"),
      variantIndex: 2,
    });

    expect(new Set([first, second, third]).size).toBe(3);
  });

  it("does not include one moment or filler in first-session greetings", () => {
    const line = buildCarsonOpeningLine({
      isFirstSessionToday: true,
      displayName: "Sana",
      spokenBrief: "Good morning, Sana. One moment. Nothing urgent needs your attention.",
      now: new Date("2026-06-29T10:00:00"),
    });

    expect(line).toBe("Good morning, Sana. Nothing urgent needs your attention.");
    expect(line).not.toMatch(/one moment|i(?:'|’)m here/i);
  });

  it("keeps first-session opening short when no brief is available", () => {
    const line = buildCarsonOpeningLine({
      isFirstSessionToday: true,
      displayName: "Sana",
      spokenBrief: "",
      now: new Date("2026-06-29T19:00:00"),
    });

    expect(line).toBe("Good evening, Sana. I'm ready.");
  });
});
