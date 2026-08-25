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

  it("still schedules the QStash push for the corrected reminder through the canonical createReminderTask boundary", () => {
    const block = reminderBlock();
    expect(block).toContain("source: \"voice\"");
    expect(block).toContain("routingEvidence: params.routingEvidence");
    // createReminderTask remains the one boundary for both legacy reminders
    // and authoritative routed reminders; correction calls use it too.
  });

  it("keeps genuine reminders behind the client-tool guard and diagnostic wrapper", () => {
    expect(SOURCE).toContain("create_reminder: async (params: Parameters<typeof createReminder>[0]) => {");
    expect(SOURCE).toContain('const routedToolName = routing.kind === "automation" ? "create_automation" : "create_reminder";');
    expect(SOURCE).toMatch(/guardCurrentToolInvocation\(\s*routedToolName,\s*routing\.kind === "automation" \? routing\.params : params,\s*\)/);
    expect(SOURCE).toContain('runDirectToolWithDiagnostic("create_reminder", params');
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

/**
 * Confirmed production regression: "I must pay the electricity bill on
 * Monday." made Carson call create_reminder before asking for the missing
 * time (parseVoiceTime silently defaults a bare day name to 09:00). Carson
 * then asked "What time on Monday works for you?"; the owner answered
 * "4:30 PM"; the follow-up create_reminder call resolved that time-only
 * phrase against `now` (today/tomorrow), producing "Tomorrow at 4:30 PM"
 * instead of Monday. Fixed with parseVoiceTime's new `dayOnly` flag (day
 * named, no clock time → ask instead of creating) and
 * pendingReminderTimeClarificationRef, which remembers the named day so the
 * time-only follow-up is combined with it instead of resolved against `now`.
 */
describe("ElevenLabsAgentWidget — reminder day-then-time two-turn flow (2026-07-25 fix)", () => {
  function reminderBlock(): string {
    return blockBetween(
      "const createReminder = useCallback(",
      "  function recordCreateAutomationFailure(",
    );
  }

  it("declares a session-scoped ref remembering a day named without a time, separate from lastCreatedReminderRef", () => {
    expect(SOURCE).toContain("const pendingReminderTimeClarificationRef = useRef<{");
    expect(SOURCE).toContain("normalizedDescription: string;");
    expect(SOURCE).toContain("dayOnlyDueAt: string;");
  });

  it("asks for the time instead of creating anything when parseVoiceTime reports dayOnly", () => {
    const block = reminderBlock();
    const dayOnlyIndex = block.indexOf("if (parsed.dayOnly) {");
    const createIndex = block.indexOf("task = await createReminderTask({");
    expect(dayOnlyIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(dayOnlyIndex); // the day-only branch returns first
    const dayOnlyBranch = blockBetween("if (parsed.dayOnly) {", "// A pure clock time with no day word");
    expect(dayOnlyBranch).toContain("pendingReminderTimeClarificationRef.current = {");
    expect(dayOnlyBranch).toContain("dayOnlyDueAt: parsed.dueAt,");
    expect(dayOnlyBranch).toContain("recordCreateReminderFailure(clarifyText, text);");
    expect(dayOnlyBranch).toContain("return clarifyText;");
    expect(dayOnlyBranch).not.toContain("createReminderTask(");
  });

  it("combines a time-only follow-up with the previously named day, not with `now`", () => {
    const block = reminderBlock();
    expect(block).toContain('/day="auto"/.test(parsed.parsedAs)');
    expect(block).toContain("pendingClarification?.normalizedDescription === normalizedDescription");
    expect(block).toContain(
      "Date.now() - pendingClarification.at <= REMINDER_CORRECTION_WINDOW_MS",
    );
    const mergeBlock = blockBetween(
      "if (answersOpenDayClarification && pendingClarification) {",
      "} else {\n          resolvedDueAt = parsed.dueAt;",
    );
    // Takes the named day's calendar date, but the newly answered time.
    expect(mergeBlock).toContain("namedDay.getFullYear(),");
    expect(mergeBlock).toContain("namedDay.getMonth(),");
    expect(mergeBlock).toContain("namedDay.getDate(),");
    expect(mergeBlock).toContain("resolvedTime.getHours(),");
    expect(mergeBlock).toContain("resolvedTime.getMinutes(),");
  });

  it("consumes (clears) the pending day-only clarification once a due time is resolved, so it cannot leak into an unrelated later reminder", () => {
    const block = reminderBlock();
    const timeTextBranchEnd = block.indexOf("} else if (due_at) {");
    const clearIndex = block.lastIndexOf("pendingReminderTimeClarificationRef.current = null;", timeTextBranchEnd);
    const mergeIndex = block.indexOf("if (answersOpenDayClarification && pendingClarification) {");
    expect(clearIndex).toBeGreaterThan(mergeIndex);
  });

  it("only triggers the day-only ask for a genuinely day-only phrase — an explicit day+time in one turn still resolves and creates normally", () => {
    // parseVoiceTime itself is covered by dedicated unit tests in
    // parse-voice-time.test.ts; this just confirms the widget only special-
    // cases parsed.dayOnly, not every named-day phrase.
    const block = reminderBlock();
    expect(block).toContain("if (parsed.dayOnly) {");
    expect(block).not.toMatch(/if \(parsed\.parsedAs\.includes\("named"\)\)/);
  });

  // Protects PR #72/#73/#74 together: "Monday at 5:00 PM" (and the other
  // supported weekday formats — "next Monday at 5:00 PM", "Monday at
  // 17:00", "Monday at 5" — all proven dayOnly:false by the dedicated
  // parse-voice-time.test.ts unit tests) must reach a real, single
  // creation immediately, with no clarification question and no merge
  // against a stale pending day-only ref.
  it("an explicit weekday+time in one turn skips both the dayOnly-ask branch and the pending-clarification merge, creating exactly one reminder with no clarification", () => {
    const block = reminderBlock();
    const timeTextBranch = blockBetween(
      "if (time_text?.trim()) {",
      '} else if (due_at) {',
    );
    // Exactly one plain assignment fallback for an already-complete
    // day+time phrase (parsed.dayOnly false, no pending clarification to
    // merge against) — the same resolvedDueAt the create call below uses.
    expect(timeTextBranch).toContain("resolvedDueAt = parsed.dueAt;");
    expect(block).toContain("task = await createReminderTask({");
    expect(block).toContain("dueAt: resolvedDueAt,");
    // Single create call site for the one-time reminder path — no
    // duplicate/alternate creation path exists for the explicit-phrase case.
    const createCallCount = (block.match(/await createReminderTask\(/g) ?? []).length;
    expect(createCallCount).toBe(1);
  });
});
