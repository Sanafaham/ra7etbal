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
 * Second Brain Phase 1 deduplication: when act_on_note converts a note into
 * a task/reminder/delegation/calendar event, the note must be dismissed
 * (dismissed_at set) only after that downstream creation has actually
 * succeeded — never before, and never on a failure path — so a failed
 * conversion always leaves the original note intact and a successful one
 * never leaves a duplicate unresolved representation behind. Follows this
 * repo's established source-scan test convention for React components (no
 * component-rendering harness exists in this project — see Inbox.test.ts).
 */
describe("ElevenLabsAgentWidget — act_on_note dedup (dismissCarsonNote after success)", () => {
  function actOnNoteSource(): string {
    return blockBetween(
      "const actOnNote = useCallback(",
      "const runDirectToolWithDiagnostic = useCallback(",
    );
  }

  it("task branch: dismisses the note strictly after createTask succeeds, inside the try block, before the success return", () => {
    const block = actOnNoteSource();
    const taskBranch = block.slice(block.indexOf('if (action === "task")'), block.indexOf('if (action === "reminder")'));
    const createIndex = taskBranch.indexOf("await createTask(");
    const dismissIndex = taskBranch.indexOf("dismissCarsonNote(note.id)");
    const returnIndex = taskBranch.indexOf('return finish("I\'ve got that on your list.", "success"');
    const catchIndex = taskBranch.indexOf("} catch (err) {");
    expect(createIndex).toBeGreaterThan(-1);
    expect(dismissIndex).toBeGreaterThan(createIndex);
    expect(returnIndex).toBeGreaterThan(dismissIndex);
    expect(dismissIndex).toBeLessThan(catchIndex);
  });

  it("reminder branch: dismisses the note strictly after createReminderTask succeeds, before the success return", () => {
    const block = actOnNoteSource();
    const reminderBranch = block.slice(
      block.indexOf('if (action === "reminder")'),
      block.indexOf('if (action === "delegate")'),
    );
    const createIndex = reminderBranch.indexOf("await createReminderTask(");
    const dismissIndex = reminderBranch.indexOf("dismissCarsonNote(note.id)");
    const returnIndex = reminderBranch.indexOf("return finish(`I'll remind you");
    expect(createIndex).toBeGreaterThan(-1);
    expect(dismissIndex).toBeGreaterThan(createIndex);
    expect(returnIndex).toBeGreaterThan(dismissIndex);
  });

  it("delegate branch: dismisses the note strictly after createAndSendDelegation succeeds, before the success return", () => {
    const block = actOnNoteSource();
    const delegateBranch = block.slice(
      block.indexOf('if (action === "delegate")'),
      block.indexOf('if (action === "calendar")'),
    );
    const createIndex = delegateBranch.indexOf("await createAndSendDelegation(");
    const dismissIndex = delegateBranch.indexOf("dismissCarsonNote(note.id)");
    const returnIndex = delegateBranch.indexOf("return finish(`${person.name} has it.");
    expect(createIndex).toBeGreaterThan(-1);
    expect(dismissIndex).toBeGreaterThan(createIndex);
    expect(returnIndex).toBeGreaterThan(dismissIndex);
  });

  it("calendar branch: only dismisses the note when createCalendarEvent actually recorded a new sessionActionsRef entry (its real success signal), never unconditionally on the returned string alone", () => {
    const block = actOnNoteSource();
    const calendarBranch = block.slice(block.indexOf('if (action === "calendar")'));
    expect(calendarBranch).toContain("const actionsBefore = sessionActionsRef.current.length;");
    const actionsBeforeIndex = calendarBranch.indexOf("const actionsBefore = sessionActionsRef.current.length;");
    const callIndex = calendarBranch.indexOf("await createCalendarEvent(");
    const guardIndex = calendarBranch.indexOf("if (sessionActionsRef.current.length > actionsBefore)");
    const dismissIndex = calendarBranch.indexOf("dismissCarsonNote(note.id)");
    expect(callIndex).toBeGreaterThan(actionsBeforeIndex);
    expect(guardIndex).toBeGreaterThan(callIndex);
    expect(dismissIndex).toBeGreaterThan(guardIndex);
  });

  it("no branch dismisses the note inside a catch block (a failed conversion must leave the note intact)", () => {
    const block = actOnNoteSource();
    // Every catch block in this function only returns an error string — none
    // of them may contain a dismissCarsonNote call.
    const catchBlocks = block.split("} catch (err) {").slice(1);
    for (const catchBlock of catchBlocks) {
      const nextBraceEnd = catchBlock.indexOf("\n      }");
      const body = catchBlock.slice(0, nextBraceEnd === -1 ? undefined : nextBraceEnd);
      expect(body).not.toContain("dismissCarsonNote");
    }
  });

  it("dismissCarsonNote is imported from carson-notes", () => {
    expect(SOURCE).toContain("dismissCarsonNote");
    expect(SOURCE).toMatch(/import \{[\s\S]*?saveCarsonNote,[\s\S]*?loadRecentNotes,[\s\S]*?dismissCarsonNote,[\s\S]*?\} from "\.\.\/\.\.\/lib\/carson-notes";/);
  });
});
