import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "ClearMyHeadInbox.tsx"), "utf-8");

/**
 * Clear My Head Inbox V1: read-only thoughts moved here by "Leave here for
 * now". No editing, no conversion actions (Remind Me / Delegate / Task) like
 * the separate Home-screen capture inbox has — only Delete. Source-scanning
 * regression guard, the established pattern in this project (no React
 * Testing Library / component-rendering harness).
 */
describe("ClearMyHeadInbox.tsx — read-only thoughts, delete only", () => {
  it("reads from clear-my-head-inbox.ts, not the unrelated inbox_items capture queue", () => {
    expect(SOURCE).toMatch(/from ["']\.\.\/lib\/clear-my-head-inbox["']/);
    expect(SOURCE).not.toMatch(/from ["']\.\.\/lib\/inbox["']/);
  });

  it("lists and can delete items", () => {
    expect(SOURCE).toMatch(/listClearMyHeadInboxItems/);
    expect(SOURCE).toMatch(/deleteClearMyHeadInboxItem/);
  });

  it("does not save/create new items — only Review's 'Leave here for now' does", () => {
    expect(SOURCE).not.toMatch(/saveClearMyHeadInboxItem/);
  });

  it("has no editable text input for the thought itself (read-only)", () => {
    expect(SOURCE).not.toMatch(/<textarea/);
    expect(SOURCE).not.toMatch(/onChange/);
  });

  it("has no conversion actions (Remind Me / Delegate / Task) — unlike the separate capture inbox", () => {
    expect(SOURCE).not.toMatch(/Remind Me/i);
    expect(SOURCE).not.toMatch(/Delegate/i);
    expect(SOURCE).not.toMatch(/createReminderTask|createDelegationTaskAndMessage|sendWhatsAppTask/);
  });

  it("does not import or call any Carson/Notes/To-do/Message creation functions", () => {
    expect(SOURCE).not.toMatch(/savePending|saveCarsonNote|createTodo|createDirectMessageRecord|sendDirectMessageRecord/);
  });
});
