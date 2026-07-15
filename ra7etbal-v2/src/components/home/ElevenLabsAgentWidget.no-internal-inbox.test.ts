import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "ElevenLabsAgentWidget.tsx"), "utf-8");

/**
 * Clear My Head and the internal Inbox surface were removed from the
 * product. Carson must never create a new internal Inbox item — capture
 * always resolves to a Note (save_note) or a To-do (create_todo).
 */
describe("ElevenLabsAgentWidget — no internal Inbox creation", () => {
  it("does not import the removed Inbox storage modules", () => {
    expect(SOURCE).not.toMatch(/from ["'].*clear-my-head-inbox["']/);
    expect(SOURCE).not.toMatch(/from ["'].*\/lib\/inbox["']/);
    expect(SOURCE).not.toContain("carson-inbox-action-quality");
    expect(SOURCE).not.toContain("listClearMyHeadInboxItems");
    expect(SOURCE).not.toContain("deleteClearMyHeadInboxItem");
    expect(SOURCE).not.toContain("saveInboxItem");
  });

  it("does not register removed Inbox client tools", () => {
    expect(SOURCE).not.toContain("list_inbox_items");
    expect(SOURCE).not.toContain("act_on_inbox_item");
    expect(SOURCE).not.toContain("getInboxItems");
    expect(SOURCE).not.toContain("actOnInboxItem");
  });

  it("save_note and create_todo remain the only capture-decision tools, untouched", () => {
    expect(SOURCE).toContain("save_note: (params: Parameters<typeof saveNote>[0]) =>");
    expect(SOURCE).toContain("create_todo: (params: Parameters<typeof createTodoTool>[0]) =>");
  });
});
