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

  it("renders only from the active lifecycle state, so completed tasks cannot keep owner-decision buttons", () => {
    expect(SOURCE).toContain('const showUncertainReview = qualityLifecycle.state === "needs_owner_review"');
    expect(SOURCE).toContain('const showSubstituteReview = qualityLifecycle.state === "needs_owner_decision"');
    expect(SOURCE).toContain("{showUncertainReview &&");
    expect(SOURCE).toContain("{showSubstituteReview &&");
    expect(SOURCE).not.toContain('task.quality_review_status === "substitute_review" &&');
    expect(SOURCE).toContain("<SubstituteReviewCard task={task} assignedLabel={assignedLabel} />");
  });

  it("shows Carson's note and the worker's own reply", () => {
    expect(cardSource).toMatch(/task\.quality_review_note/);
    expect(cardSource).toMatch(/task\.worker_reply/);
  });

  it("uses the approved dark review surface and gold/neutral status accents", () => {
    expect(cardSource).toContain("border border-gold/30 bg-surface-subtle");
    expect(cardSource).toContain("text-sm text-ink");
    expect(cardSource).toContain("text-text-soft");
    expect(cardSource).not.toContain("bg-rose-50");
    expect(SOURCE).not.toContain("bg-sky-400/10");
    expect(SOURCE).not.toContain("bg-emerald-50");
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

/**
 * Reminder card creation-time display. UI-only addition — reuses the
 * existing task.created_at field and a new pure helper
 * (formatReminderCreatedTime, tested separately in reminder-time.test.ts).
 * Placed inside the same reminderDue block as the due date, so it only
 * appears alongside it (never for a completed reminder, matching the due
 * date's own visibility rule) and never on followup/delegation cards.
 */
describe("TaskCard.tsx — reminder card creation-time display", () => {
  function reminderDueBlock(): string {
    const start = SOURCE.indexOf("{reminderDue && !isDone && (");
    const end = SOURCE.indexOf("<footer", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return SOURCE.slice(start, end);
  }

  it("imports formatReminderCreatedTime from the shared reminder-time helper, not a new formatter", () => {
    expect(SOURCE).toContain("formatReminderCreatedTime");
    expect(SOURCE).toMatch(/from "\.\.\/\.\.\/lib\/reminder-time"/);
  });

  it("computes the label once (task.type === reminder, guarded by the formatted value itself so an invalid/missing created_at renders nothing, not an empty row) and passes the shared now prop for consistency with getReminderDue", () => {
    expect(SOURCE).toContain(
      'const reminderCreatedLabel =\n    task.type === "reminder" ? formatReminderCreatedTime(task.created_at, now) : null;',
    );
    const block = reminderDueBlock();
    expect(block).toContain("{reminderCreatedLabel && (");
    expect(block).not.toContain("task.created_at && (");
  });

  it("does not touch the followup/delegation \"Sent ...\" line or its formatter", () => {
    expect(SOURCE).toContain('(task.type === "followup" || task.type === "delegation") && task.created_at && (');
    expect(SOURCE).toContain("formatFollowUpSentTime(task.created_at)");
    // The two created_at displays are independent — neither block references
    // the other's formatter.
    const followUpBlock = SOURCE.slice(
      SOURCE.indexOf('(task.type === "followup" || task.type === "delegation") && task.created_at && ('),
      SOURCE.indexOf("{showNeedsYouTimestamp"),
    );
    expect(followUpBlock).not.toContain("formatReminderCreatedTime");
  });

  it("does not change reminder scheduling, due-date computation, or the due-date rendering already in place", () => {
    const block = reminderDueBlock();
    expect(block).toContain("{reminderDue.dueTime}");
    expect(block).toContain('reminderDue.overdue ? "text-danger" : "text-gold-soft"');
    // getReminderDue / reminderDue itself is computed once, above this
    // block, and is untouched by this change.
    expect(SOURCE).toContain('const reminderDue = task.type === "reminder" ? getReminderDue(task.due_at, isDone, now) : null;');
  });
});

/**
 * What's Happening -> History completion timestamp. UI-only addition —
 * reuses the pure formatHistoryCompletedAt helper (tested directly in
 * history-timestamp.test.ts) and the same confirmed_at -> archived_at ->
 * created_at fallback chain History.tsx/HistoryCard.tsx already use.
 */
describe("TaskCard.tsx — History completion timestamp display", () => {
  it("imports formatHistoryCompletedAt from the shared history-timestamp helper", () => {
    expect(SOURCE).toContain("formatHistoryCompletedAt");
    expect(SOURCE).toMatch(/from "\.\.\/\.\.\/lib\/history-timestamp"/);
  });

  it("only computes a completion label when the task is done, in confirmed_at -> archived_at -> created_at order", () => {
    expect(SOURCE).toContain(
      "const completedAtLabel = isDone\n"
        + "    ? formatHistoryCompletedAt(task.confirmed_at, task.archived_at, task.created_at)\n"
        + "    : null;",
    );
  });

  it("renders the label only when present, so an active (not-done) card never gains a completion stamp", () => {
    expect(SOURCE).toContain("{completedAtLabel && (");
    const start = SOURCE.indexOf("{completedAtLabel && (");
    const end = SOURCE.indexOf(")}", start) + 2;
    const block = SOURCE.slice(start, end);
    expect(block).toContain("{completedAtLabel}");
  });

  it("does not touch the followup/delegation \"Sent ...\" line, the needs-you timestamp, or their formatters", () => {
    expect(SOURCE).toContain('(task.type === "followup" || task.type === "delegation") && task.created_at && (');
    expect(SOURCE).toContain("formatFollowUpSentTime(task.created_at)");
    expect(SOURCE).toContain("{showNeedsYouTimestamp && (");
    const completedBlock = SOURCE.slice(
      SOURCE.indexOf("{completedAtLabel && ("),
      SOURCE.indexOf("{showNeedsYouTimestamp"),
    );
    expect(completedBlock).not.toContain("formatFollowUpSentTime");
    expect(completedBlock).not.toContain("needsYouTimestampLabel");
  });

  it("does not alter the Reopen/Mark done or Delete actions", () => {
    expect(SOURCE).toContain('<span>{isDone ? "Reopen" : "Mark done"}</span>');
    expect(SOURCE).toContain('<span>{confirmingDelete ? "Tap to confirm" : "Delete"}</span>');
  });
});
