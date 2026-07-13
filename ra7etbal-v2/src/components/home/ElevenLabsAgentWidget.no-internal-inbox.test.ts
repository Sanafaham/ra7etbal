import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "ElevenLabsAgentWidget.tsx"), "utf-8");

/**
 * Clear My Head and the internal Inbox surface were removed from the
 * product. Carson must never create a new internal Inbox item — capture
 * always resolves to a Note (save_note) or a To-do (create_todo). The
 * list_inbox_items/act_on_inbox_item tool names are kept registered as
 * harmless stubs only because the ElevenLabs agent's tool schema lives in
 * the dashboard, outside this repo, and may still reference them.
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

  it("list_inbox_items and act_on_inbox_item are harmless stubs, not wired to any table", () => {
    const start = SOURCE.indexOf("const getInboxItems = useCallback(");
    const end = SOURCE.indexOf("const runDirectToolWithDiagnostic = useCallback(");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = SOURCE.slice(start, end);
    expect(block).toContain("no separate inbox anymore");
    expect(block).not.toContain("supabase");
    expect(block).not.toContain(".insert(");
    expect(block).not.toContain(".delete(");
  });

  it("still registers list_inbox_items and act_on_inbox_item tool names for dashboard compatibility", () => {
    expect(SOURCE).toContain("list_inbox_items: () =>");
    expect(SOURCE).toContain("act_on_inbox_item: () =>");
  });

  it("save_note and create_todo remain the only capture-decision tools, untouched", () => {
    expect(SOURCE).toContain("save_note: (params: Parameters<typeof saveNote>[0]) =>");
    expect(SOURCE).toContain("create_todo: (params: Parameters<typeof createTodoTool>[0]) =>");
  });
});
