import { describe, expect, it } from "vitest";
import { looksLikeTaskInstruction } from "./carson-inbox-action-quality";

describe("looksLikeTaskInstruction", () => {
  it("flags task-like instructions that should be delegated, not messaged", () => {
    expect(looksLikeTaskInstruction("Confirm the menu.")).toBe(true);
    expect(looksLikeTaskInstruction("Call Grace.")).toBe(true);
    expect(looksLikeTaskInstruction("Buy flowers for Grace.")).toBe(true);
    expect(looksLikeTaskInstruction("Compare Gemini plan with Claude plan.")).toBe(true);
  });

  it("allows greeting/FYI-style text through as a plain message", () => {
    expect(looksLikeTaskInstruction("Happy birthday Sarah!")).toBe(false);
    expect(looksLikeTaskInstruction("Thinking of you today.")).toBe(false);
    expect(looksLikeTaskInstruction("See you at 6.")).toBe(false);
    expect(looksLikeTaskInstruction("Thanks for yesterday.")).toBe(false);
  });

  it("strips a leading 'please' before checking the verb", () => {
    expect(looksLikeTaskInstruction("Please confirm the menu.")).toBe(true);
    expect(looksLikeTaskInstruction("Please say hi to Sarah.")).toBe(false);
  });

  it("is case-insensitive and tolerant of surrounding whitespace", () => {
    expect(looksLikeTaskInstruction("  CONFIRM the menu.  ")).toBe(true);
  });
});
