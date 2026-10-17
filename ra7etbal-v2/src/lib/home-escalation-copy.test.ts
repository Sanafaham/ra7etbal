import { describe, expect, it } from "vitest";
import {
  buildEscalatedWaitingSentence,
  countEscalatedWaiting,
  ESCALATED_WAITING_HEADLINE,
} from "./home-escalation-copy";

describe("Home copy for escalated, unanswered delegations", () => {
  it("counts only waiting tasks Carson has escalated", () => {
    expect(countEscalatedWaiting([{ escalated_at: "2026-10-17T20:26:52Z" }, { escalated_at: null }])).toBe(1);
    expect(countEscalatedWaiting([])).toBe(0);
  });

  it("acknowledges the unconfirmed task without an all-clear and without asking the owner to act", () => {
    const copy = [
      ESCALATED_WAITING_HEADLINE,
      buildEscalatedWaitingSentence(1, 1),
      buildEscalatedWaitingSentence(3, 3),
      buildEscalatedWaitingSentence(3, 1),
    ];
    expect(copy).toEqual([
      "Carson is following up.",
      "One item hasn't been confirmed yet.",
      "3 items haven't been confirmed yet.",
      "3 items are waiting on others; 1 not confirmed yet.",
    ]);
    for (const line of copy) {
      expect(line).not.toMatch(/under control|clear|nothing/i);
      expect(line).not.toMatch(/\b(you need|needs you|your decision|action needed|review|reply|call|contact)\b/i);
    }
  });
});
