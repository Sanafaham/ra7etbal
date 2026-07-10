import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "TaskCard.tsx"), "utf-8");

/**
 * Phase 8.1 — Needs You substitute_review card (SubstituteReviewCard).
 * Follows this repo's existing source-scan test convention for React
 * components (see Todos.test.ts) rather than a full render harness, since
 * no component-rendering test infrastructure exists in this project.
 */
describe("TaskCard.tsx — substitute_review card wiring", () => {
  const cardSource = SOURCE.slice(
    SOURCE.indexOf("function SubstituteReviewCard"),
    SOURCE.length,
  );

  it("renders only for quality_review_status === 'substitute_review', parallel to the frozen uncertain block", () => {
    expect(SOURCE).toContain('task.quality_review_status === "uncertain" &&');
    expect(SOURCE).toContain('task.quality_review_status === "substitute_review" &&');
    expect(SOURCE).toContain("<SubstituteReviewCard task={task} assignedLabel={assignedLabel} />");
  });

  it("shows Carson's note and the worker's own reply", () => {
    expect(cardSource).toMatch(/task\.quality_review_note/);
    expect(cardSource).toMatch(/task\.worker_reply/);
  });

  it("offers exactly the three approved owner actions", () => {
    expect(cardSource).toContain("Approve Alternative");
    expect(cardSource).toContain("Reject Alternative");
    expect(cardSource).toContain("Custom Instruction");
  });

  it("wires all three actions through submitSubstituteDecision — the lease-fenced, idempotent endpoint, not a duplicate implementation", () => {
    expect(cardSource).toContain('runDecision("approved_alternative")');
    expect(cardSource).toContain('runDecision("rejected_alternative")');
    expect(cardSource).toContain('runDecision("custom_instruction"');
    const callCount = (cardSource.match(/submitSubstituteDecision\(/g) ?? []).length;
    expect(callCount).toBe(1); // single call site inside runDecision — no duplicate send paths
  });

  it("custom instruction requires non-empty text before sending", () => {
    expect(cardSource).toMatch(/const trimmed = customText\.trim\(\)/);
    expect(cardSource).toMatch(/if \(!trimmed\)/);
  });

  it("guards against double-submit while a decision is in flight", () => {
    expect(cardSource).toMatch(/if \(busyAction\) return;/);
    expect(cardSource).toMatch(/disabled=\{isBusy\}/);
  });

  it("surfaces errors inline instead of failing silently", () => {
    expect(cardSource).toMatch(/setError\(result\.error/);
    expect(cardSource).toContain("{error &&");
  });

  it("refreshes the tasks store after a successful decision so the card reflects the new state", () => {
    expect(cardSource).toContain("await refreshTasks()");
    expect(cardSource).toMatch(/useTasksStore\.getState\(\)\.loadFor/);
  });
});
