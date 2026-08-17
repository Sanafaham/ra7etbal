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

  it("follow-up session with no new material stays short (regression — the original PR #24 acceptance failure)", () => {
    const line = buildCarsonOpeningLine({
      isFirstSessionToday: false,
      displayName: "Sana",
      now: new Date("2026-08-17T17:41:00"),
      variantIndex: 0,
      newOrChangedMaterialText: [],
    });

    expect(line).toBe("Good evening, Sana.");
  });

  it("follow-up session with a new/changed material item appends it — this is the actual fix", () => {
    const line = buildCarsonOpeningLine({
      isFirstSessionToday: false,
      displayName: "Sana",
      now: new Date("2026-08-17T17:41:00"),
      variantIndex: 0,
      newOrChangedMaterialText: ["You have a reminder scheduled — Daily reminder test."],
    });

    expect(line).toBe("Good evening, Sana. You have a reminder scheduled — Daily reminder test.");
  });

  it("follow-up session caps appended material items and summarizes the rest", () => {
    const line = buildCarsonOpeningLine({
      isFirstSessionToday: false,
      displayName: "Sana",
      now: new Date("2026-08-17T17:41:00"),
      variantIndex: 0,
      newOrChangedMaterialText: ["Item one.", "Item two.", "Item three.", "Item four."],
    });

    expect(line).toBe("Good evening, Sana. Item one. Item two. Item three. And 1 more thing to cover.");
  });

  it("first-session opening ignores newOrChangedMaterialText — the full brief already covers everything", () => {
    const line = buildCarsonOpeningLine({
      isFirstSessionToday: true,
      displayName: "Sana",
      spokenBrief: "Good evening, Sana. Nothing urgent needs your attention.",
      now: new Date("2026-08-17T17:41:00"),
      newOrChangedMaterialText: ["Should never appear."],
    });

    expect(line).not.toContain("Should never appear.");
  });

  // Production incident (2026-08-18, 01:58 local): a post-midnight Night
  // Sweep continuation session correctly spoke Night Sweep content ("You
  // can close the day", "tonight") but still opened with "Good morning" —
  // the greeting was independently re-derived from a raw hour<12 check with
  // no awareness of the already-resolved Night Sweep classification.
  // briefKind is now the single source of truth for the greeting word.
  describe("briefKind consolidates the greeting — no independent hour<12 re-derivation", () => {
    it("at 01:58 with briefKind='night', a first-session opening says 'Good evening', never 'Good morning'", () => {
      const line = buildCarsonOpeningLine({
        isFirstSessionToday: true,
        displayName: "Sana",
        spokenBrief: "You can close the day. 4 reminders are still waiting for confirmation tonight.",
        now: new Date("2026-08-18T01:58:00"),
        briefKind: "night",
      });

      expect(line).toMatch(/^Good evening, Sana\./);
      expect(line).not.toContain("Good morning");
    });

    it("at 01:58 with briefKind='night', a follow-up-session opening says 'Good evening', never 'Good morning'", () => {
      const line = buildCarsonOpeningLine({
        isFirstSessionToday: false,
        displayName: "Sana",
        now: new Date("2026-08-18T01:58:00"),
        variantIndex: 0,
        briefKind: "night",
      });

      expect(line).toBe("Good evening, Sana.");
      expect(line).not.toContain("Good morning");
    });

    it("at 06:00 (Morning Brief eligible) with briefKind='morning', the greeting is unaffected — still 'Good morning'", () => {
      const line = buildCarsonOpeningLine({
        isFirstSessionToday: true,
        displayName: "Sana",
        spokenBrief: "Nothing urgent needs your attention.",
        now: new Date("2026-08-18T06:00:00"),
        briefKind: "morning",
      });

      expect(line).toMatch(/^Good morning, Sana\./);
    });

    it("with no briefKind supplied (legacy fallback path), raw-hour behavior is unchanged", () => {
      const line = buildCarsonOpeningLine({
        isFirstSessionToday: false,
        displayName: "Sana",
        now: new Date("2026-06-29T19:00:00"),
        variantIndex: 1,
      });

      expect(line).toBe("Welcome back, Sana.");
    });
  });
});
