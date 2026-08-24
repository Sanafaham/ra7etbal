import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "Inbox.tsx"), "utf-8");

function blockBetween(startNeedle: string, endNeedle: string): string {
  const start = SOURCE.indexOf(startNeedle);
  const end = SOURCE.indexOf(endNeedle, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

/**
 * "Send to Carson" on Note cards (2026-07-26): opens Talk to Carson in text
 * mode with the note's exact text queued for the typed input, via
 * pendingTypedDraft on useCarsonStore (see stores/carson.test.ts and the
 * insertion effect covered in ElevenLabsAgentWidget.typed-mode.test.ts).
 * Follows this repo's established source-scan test convention for React
 * components — no component-rendering harness exists in this project.
 */
describe("Inbox.tsx — Send to Carson (Note cards)", () => {
  function handlerSource(): string {
    return blockBetween(
      "function handleSendToCarson(note: CarsonNote) {",
      "// ── Delegate handlers",
    );
  }

  it("queues the note's exact text via pendingTypedDraft, switches channel to text, and opens the sheet", () => {
    const block = handlerSource();
    expect(block).toContain("carson.setChannel(\"text\");");
    expect(block).toContain("carson.setPendingTypedDraft(note.note);");
    expect(block).toContain("carson.setOpen(true);");
  });

  it("never mutates, saves, or deletes the note — reads note.note only", () => {
    const block = handlerSource();
    expect(block).not.toContain("saveCarsonNote");
    expect(block).not.toContain("deleteCarsonNote");
    expect(block).not.toMatch(/setNotes\(/);
  });

  it("never calls a Carson execution path directly — sending only happens if/when the owner taps Send inside the normal typed chat", () => {
    const block = handlerSource();
    expect(block).not.toContain("sendTypedMessage");
    expect(block).not.toContain("createTask(");
    expect(block).not.toContain("createReminderTask");
    expect(block).not.toContain("createDelegationTaskAndMessage");
    expect(block).not.toContain("sendWhatsAppTask");
  });

  it("Remind Me and Delegate actions are unchanged (kept, not touched by this task)", () => {
    expect(SOURCE).toContain("Remind Me");
    expect(SOURCE).toContain("onClick={() => onRemindMe(note)}");
    expect(SOURCE).toMatch(/>\s*Delegate\s*</);
    expect(SOURCE).toContain("onClick={() => void onDelegate(note)}");
  });

  it("does not add a Convert to To-do action (explicitly out of scope for this task)", () => {
    expect(SOURCE).not.toContain("Convert to To-do");
    expect(SOURCE).not.toMatch(/handleConvertToTodo/);
  });

  it("the Discuss with Carson button (renamed from Send to Carson, Second Brain Phase 1) is wired to the handler and disabled while another inline note action is in progress", () => {
    const buttonBlock = blockBetween(
      "{/* Discuss with Carson",
      "{/* Overflow",
    );
    expect(buttonBlock).toContain("onClick={() => onSendToCarson(note)}");
    expect(buttonBlock).toMatch(/disabled=\{busy \|\| reminding \|\| delegating \|\| addingToCalendar\}/);
    expect(buttonBlock).toContain("Discuss with Carson");
    expect(buttonBlock).not.toContain(">Send to Carson<");
  });

  it("NoteCard receives and forwards onSendToCarson from the parent's handleSendToCarson", () => {
    expect(SOURCE).toContain("onSendToCarson={handleSendToCarson}");
    expect(SOURCE).toMatch(/onSendToCarson: \(note: CarsonNote\) => void;/);
  });
});

/**
 * Second Brain Phase 1 deduplication: each of Inbox.tsx's four UI-side note
 * conversion paths (Make Task, Delegate, Add to Calendar, Remind Me) must
 * dismiss the source note only after its own downstream creation actually
 * succeeded — never before, never on a failure path — so a duplicate
 * unresolved representation (note + independently created task/reminder/
 * delegation/event) never persists, and a failed conversion never loses the
 * original note.
 */
describe("Inbox.tsx — dismissCarsonNote wiring on each conversion path", () => {
  it("imports dismissCarsonNote", () => {
    expect(SOURCE).toMatch(/import \{[\s\S]*dismissCarsonNote,?[\s\S]*\} from "\.\.\/lib\/carson-notes";/);
  });

  it("handleMakeTask dismisses the note strictly after createTask succeeds, before madeTaskIds is updated", () => {
    const block = blockBetween("async function handleMakeTask(note: CarsonNote) {", "// ── Discuss with Carson");
    const createIndex = block.indexOf("await createTask(");
    const dismissIndex = block.indexOf("dismissCarsonNote(note.id)");
    const markedIndex = block.indexOf("setMadeTaskIds(");
    expect(createIndex).toBeGreaterThan(-1);
    expect(dismissIndex).toBeGreaterThan(createIndex);
    expect(markedIndex).toBeGreaterThan(dismissIndex);
  });

  it("handleDelegateSubmit dismisses the note strictly after the delegation is created and sent, before delegatedMap is updated", () => {
    const block = blockBetween(
      "async function handleDelegateSubmit(note: CarsonNote) {",
      "// ── Calendar handlers",
    );
    const sendIndex = block.indexOf("await sendWhatsAppTask(");
    const dismissIndex = block.indexOf("dismissCarsonNote(note.id)");
    const markedIndex = block.indexOf("setDelegatedMap(");
    expect(sendIndex).toBeGreaterThan(-1);
    expect(dismissIndex).toBeGreaterThan(sendIndex);
    expect(markedIndex).toBeGreaterThan(dismissIndex);
  });

  it("handleCalendarSubmit dismisses the note only after result.ok is confirmed true, before calendarAddedIds is updated", () => {
    const block = blockBetween(
      "async function handleCalendarSubmit(note: CarsonNote) {",
      "// ── Remind Me handlers",
    );
    const okCheckIndex = block.indexOf("if (!result.ok)");
    const dismissIndex = block.indexOf("dismissCarsonNote(note.id)");
    const markedIndex = block.indexOf("setCalendarAddedIds(");
    expect(okCheckIndex).toBeGreaterThan(-1);
    expect(dismissIndex).toBeGreaterThan(okCheckIndex);
    expect(markedIndex).toBeGreaterThan(dismissIndex);
  });

  it("handleRemindSubmit dismisses the note strictly after createReminderTask succeeds, before reminderSetIds is updated", () => {
    const block = blockBetween(
      "async function handleRemindSubmit(note: CarsonNote) {",
      "return (\n    <section",
    );
    const createIndex = block.indexOf("await createReminderTask(");
    const dismissIndex = block.indexOf("dismissCarsonNote(note.id)");
    const markedIndex = block.indexOf("setReminderSetIds(");
    expect(createIndex).toBeGreaterThan(-1);
    expect(dismissIndex).toBeGreaterThan(createIndex);
    expect(markedIndex).toBeGreaterThan(dismissIndex);
  });

  it("none of the four handlers call dismissCarsonNote inside a catch block", () => {
    for (const [name, start, end] of [
      ["handleMakeTask", "async function handleMakeTask(note: CarsonNote) {", "// ── Discuss with Carson"],
      ["handleDelegateSubmit", "async function handleDelegateSubmit(note: CarsonNote) {", "// ── Calendar handlers"],
      ["handleCalendarSubmit", "async function handleCalendarSubmit(note: CarsonNote) {", "// ── Remind Me handlers"],
      ["handleRemindSubmit", "async function handleRemindSubmit(note: CarsonNote) {", "return (\n    <section"],
    ] as const) {
      const block = blockBetween(start, end);
      const catchIndex = block.indexOf("} catch (err) {");
      expect(catchIndex, `${name} should have a catch block`).toBeGreaterThan(-1);
      const catchBody = block.slice(catchIndex);
      expect(catchBody, `${name} must not dismiss the note in its catch block`).not.toContain("dismissCarsonNote");
    }
  });
});
