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

  it("the Send to Carson button is wired to the handler and disabled while another inline note action is in progress", () => {
    const buttonBlock = blockBetween(
      "{/* Send to Carson",
      "{/* Overflow",
    );
    expect(buttonBlock).toContain("onClick={() => onSendToCarson(note)}");
    expect(buttonBlock).toMatch(/disabled=\{busy \|\| reminding \|\| delegating \|\| addingToCalendar\}/);
    expect(buttonBlock).toContain("Send to Carson");
  });

  it("NoteCard receives and forwards onSendToCarson from the parent's handleSendToCarson", () => {
    expect(SOURCE).toContain("onSendToCarson={handleSendToCarson}");
    expect(SOURCE).toMatch(/onSendToCarson: \(note: CarsonNote\) => void;/);
  });
});
