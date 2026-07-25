import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "ElevenLabsAgentWidget.tsx"), "utf-8");

function blockBetween(startNeedle: string, endNeedle: string): string {
  const start = SOURCE.indexOf(startNeedle);
  const end = SOURCE.indexOf(endNeedle, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

/**
 * Confirmed production regression: Talk to Carson created a 9:00 AM reminder,
 * the owner corrected it to 5:00 PM, Carson said "changed to 5:00 PM", but
 * production showed BOTH reminders active — the original 9:00 AM job was
 * never cancelled. create_reminder is the only reminder tool exposed to the
 * model, so a correction necessarily arrives as another create_reminder call
 * with the same description, not a distinct "update" call. This locks the
 * fix: lastCreatedReminderRef detects a same-description follow-up within
 * this session and replaces the reminder instead of creating a duplicate.
 */
describe("ElevenLabsAgentWidget — reminder replacement on correction (2026-07-25 fix)", () => {
  function reminderBlock(): string {
    return blockBetween(
      "const createReminder = useCallback(",
      "  function recordCreateAutomationFailure(",
    );
  }

  it("tracks the last created one-time reminder (with timestamp) in a session-scoped ref, reset at every session boundary", () => {
    expect(SOURCE).toContain(
      "const lastCreatedReminderRef = useRef<{ id: string; normalizedDescription: string; createdAt: number } | null>(null);",
    );
    // Same three reset points as createdReminderKeysRef.current.clear() —
    // session end (x2) and new-session start — so a correction can never be
    // detected against a reminder from an unrelated, earlier session. Two
    // more resets (control_task delete/mark_done, tested separately below)
    // bring the total to five.
    const resetCount = SOURCE.split("lastCreatedReminderRef.current = null;").length - 1;
    expect(resetCount).toBe(5);
  });

  it("detects a correction only by BOTH exact normalized-description match AND a short time window since the prior reminder", () => {
    const block = reminderBlock();
    expect(block).toContain(
      'const normalizedDescription = text.toLowerCase().replace(/\\s+/g, " ").trim();',
    );
    expect(block).toContain("candidatePriorReminder?.normalizedDescription === normalizedDescription");
    // Independent review finding (2026-07-25): description equality ALONE
    // would silently delete an active reminder the owner intentionally
    // repeated later in the session for something unrelated — the time
    // window is what distinguishes a live correction from that case.
    expect(block).toContain(
      "Date.now() - candidatePriorReminder.createdAt <= REMINDER_CORRECTION_WINDOW_MS",
    );
    expect(SOURCE).toContain("const REMINDER_CORRECTION_WINDOW_MS = 2 * 60 * 1000;");
  });

  it("stamps createdAt on every reminder creation, correction or not, so the window is always measured from the most recent one", () => {
    const block = reminderBlock();
    expect(block).toContain(
      "lastCreatedReminderRef.current = { id: task.id, normalizedDescription, createdAt: Date.now() };",
    );
  });

  it("creates the corrected reminder before cancelling the original — never zero active reminders on a transient failure", () => {
    const block = reminderBlock();
    const createIndex = block.indexOf("task = await createReminderTask({");
    const removeIndex = block.indexOf("await useTasksStore.getState().remove(priorReminder.id);");
    expect(createIndex).toBeGreaterThan(-1);
    expect(removeIndex).toBeGreaterThan(createIndex);
  });

  it("calls the create path exactly once per call, whether it is a fresh reminder or a correction", () => {
    const block = reminderBlock();
    const createCallCount = block.split("await createReminderTask({").length - 1;
    expect(createCallCount).toBe(1);
  });

  it("cancels the original reminder task through the existing protected delete+QStash-cancel path, not a new mechanism", () => {
    const block = reminderBlock();
    // Reuses useTasksStore.remove(), the same function control_task's delete
    // action already uses — remove() itself (untouched, in stores/tasks.ts)
    // is what cancels the QStash push job. No new scheduler code here.
    expect(block).toContain("useTasksStore.getState().remove(priorReminder.id)");
    expect(SOURCE).not.toContain("cancelReminderPush(priorReminder.id)");
  });

  it("only reports \"changed\" after both the new reminder is created and the old one is confirmed cancelled", () => {
    const block = reminderBlock();
    const removeIndex = block.indexOf("await useTasksStore.getState().remove(priorReminder.id);");
    const replyIndex = block.indexOf("const reply = priorReminder");
    const changedTextIndex = block.indexOf('`I\'ve changed that reminder to');
    expect(removeIndex).toBeGreaterThan(-1);
    expect(replyIndex).toBeGreaterThan(removeIndex);
    expect(changedTextIndex).toBeGreaterThan(removeIndex);
  });

  it("never claims success when cancelling the original reminder fails after the new one was created", () => {
    const catchBlock = blockBetween(
      "await useTasksStore.getState().remove(priorReminder.id);",
      "const reply = priorReminder",
    );
    expect(catchBlock).toContain("} catch (err) {");
    expect(catchBlock).toContain("mixedStateText");
    expect(catchBlock).toContain("recordCreateReminderFailure(mixedStateText, text);");
    expect(catchBlock).toContain("return mixedStateText;");
    // The failure message must not itself claim the reminder was changed.
    expect(catchBlock).not.toMatch(/`I've changed/);
  });

  it("is idempotent: an exact repeat of the same correction is caught by the existing dedup cache before create/cancel run again", () => {
    const block = reminderBlock();
    const dedupIndex = block.indexOf("const existingReminderReply = createdReminderKeysRef.current.get(reminderKey);");
    const correctionIndex = block.indexOf("const candidatePriorReminder = lastCreatedReminderRef.current;");
    const createIndex = block.indexOf("task = await createReminderTask({");
    expect(dedupIndex).toBeGreaterThan(-1);
    expect(correctionIndex).toBeGreaterThan(dedupIndex);
    expect(createIndex).toBeGreaterThan(correctionIndex);
    // The dedup return (for an exact repeat, description+time both matching a
    // prior cached reply) happens before the correction/create logic is ever
    // reached — a repeated identical correction never re-creates or re-cancels.
    expect(block.indexOf("if (existingReminderReply) {")).toBeLessThan(correctionIndex);
  });

  it("preserves the original creation reply and reminder key caching for a non-correction reminder", () => {
    const block = reminderBlock();
    expect(block).toContain('`I\'ll remind you ${dateLabel} at ${timeStr}.`');
    expect(block).toContain("createdReminderKeysRef.current.set(reminderKey, reply);");
    const replyIndex = block.indexOf("const reply = priorReminder");
    const cacheIndex = block.indexOf("createdReminderKeysRef.current.set(reminderKey, reply);");
    expect(cacheIndex).toBeGreaterThan(replyIndex);
  });

  it("leaves the recurring-reminder path completely untouched by the replacement logic", () => {
    const block = reminderBlock();
    const recurringIndex = block.indexOf("RECURRING_DETECTED");
    const hardBlockIndex = block.indexOf("HARD_BLOCK");
    const correctionIndex = block.indexOf("const candidatePriorReminder = lastCreatedReminderRef.current;");
    expect(recurringIndex).toBeGreaterThan(-1);
    expect(hardBlockIndex).toBeGreaterThan(recurringIndex);
    // The one-time replacement logic is reached only after every recurring
    // branch has already returned.
    expect(correctionIndex).toBeGreaterThan(hardBlockIndex);
  });

  it("still schedules the QStash push for the corrected reminder through the same unmodified createReminderTask boundary", () => {
    const block = reminderBlock();
    expect(block).toContain("source: \"create_reminder\"");
    expect(block).toContain("createTaskFn: useTasksStore.getState().add");
    // createReminderTask itself (src/lib/reminders.ts) is untouched — it
    // unconditionally calls scheduleReminderPush when due_at is present,
    // for every call, correction or not.
  });

  it("keeps create_reminder's client-tool wiring and diagnostic wrapper unchanged", () => {
    expect(SOURCE).toContain("create_reminder: (params: Parameters<typeof createReminder>[0]) => {");
    expect(SOURCE).toContain('guardCurrentToolInvocation("create_reminder")');
  });

  // CodeRabbit finding (2026-07-25): without this, deleting or marking done
  // the reminder create_reminder just created (via control_task) left
  // lastCreatedReminderRef pointing at an already-gone task — a later
  // same-wording create_reminder within the window would then be mislabeled
  // "changed" when it was really a fresh creation.
  it("clears lastCreatedReminderRef when control_task deletes or marks done the reminder it points at", () => {
    const controlTaskBlock = blockBetween(
      "const controlTaskTool = useCallback(",
      "  // ------------------------------------------------------------------\n  // Client tool: get_calendar_events",
    );
    const deleteBlock = blockBetween(
      'if (result.action === "delete" && result.task) {',
      'if (result.action === "mark_done" && result.task) {',
    );
    const markDoneBlock = blockBetween(
      'if (result.action === "mark_done" && result.task) {',
      "return result.reply;",
    );
    expect(controlTaskBlock).toContain('if (result.action === "delete" && result.task) {');
    for (const block of [deleteBlock, markDoneBlock]) {
      expect(block).toContain("lastCreatedReminderRef.current?.id === result.task.id");
      expect(block).toContain("lastCreatedReminderRef.current = null;");
    }
  });
});
