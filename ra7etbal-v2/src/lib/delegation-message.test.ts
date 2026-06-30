import { describe, expect, it } from "vitest";
import { buildDelegationMessage } from "./delegation-message";

// Helper — no personality notes, no owner
function build(taskText: string, personNotes?: string): string {
  return buildDelegationMessage({ personName: "Christopher", taskText, personNotes: personNotes ?? null });
}

describe("please deduplication", () => {
  it("does not add please when user omits it", () => {
    const msg = build("make lunch");
    expect(msg).not.toMatch(/please/i);
    expect(msg).toContain("make lunch");
  });

  it("keeps exactly one please when task starts with please", () => {
    const msg = build("please make lunch");
    expect(msg).toMatch(/please/i);
    expect(msg).not.toMatch(/please\s+please/i);
    expect(msg).toContain("make lunch");
  });

  it("keeps exactly one please when AI-generated text starts with please", () => {
    const msg = build("please make a sushi/poke bowl for dinner");
    const matches = (msg.match(/please/gi) ?? []).length;
    expect(matches).toBe(1);
    expect(msg).not.toMatch(/please\s+please/i);
  });

  it("never produces double please regardless of casing", () => {
    for (const prefix of ["Please ", "PLEASE ", "please "]) {
      const msg = build(`${prefix}set the table`);
      expect(msg).not.toMatch(/please\s+please/i);
    }
  });

  it("expected output without please — direct and natural", () => {
    const msg = build("make a sushi/poke bowl for dinner");
    expect(msg).toBe("Hi Christopher, could you make a sushi/poke bowl for dinner? Let Sana know when done.");
  });

  it("expected output with please — one please preserved", () => {
    const msg = build("please make a sushi/poke bowl for dinner");
    expect(msg).toBe("Hi Christopher, could you please make a sushi/poke bowl for dinner? Let Sana know when done.");
  });
});

describe("please deduplication — personality branches", () => {
  it("no please added for reliable note when task has no please", () => {
    const msg = build("make lunch", "reliable");
    expect(msg).not.toMatch(/please/i);
    expect(msg).toContain("make lunch");
  });

  it("one please kept for reliable note when task has please", () => {
    const msg = build("please make lunch", "reliable");
    expect(msg).not.toMatch(/please\s+please/i);
    const matches = (msg.match(/please/gi) ?? []).length;
    expect(matches).toBe(1);
  });

  it("no please added for clear instructions note when task has no please", () => {
    const msg = build("clean the kitchen", "needs clear instructions");
    expect(msg).not.toMatch(/please\s+clean/i);
  });

  it("one please kept for clear instructions note when task has please", () => {
    const msg = build("please clean the kitchen", "needs clear instructions");
    expect(msg).not.toMatch(/please\s+please/i);
  });

  it("no please added for menu/misses details note when task has no please", () => {
    const msg = build("prepare dinner", "miss details");
    expect(msg).not.toMatch(/please\s+prepare/i);
  });
});
