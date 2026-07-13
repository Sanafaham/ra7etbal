import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Carson Inbox Review V1 — regression guard for the two new client tools
 * (list_inbox_items, act_on_inbox_item) that let Carson read and, on
 * explicit user instruction, convert or delete Clear My Head Inbox items.
 *
 * Same rationale as ElevenLabsAgentWidget.todo-tools.test.ts: the ElevenLabs
 * SDK's clientTools type is a plain Record<string, handler>, so the only
 * code-side guarantee available is that the tool name is registered and
 * wired to the right implementation. These are source-scanning tests
 * (no React Testing Library / component-rendering harness in this project).
 */
const SOURCE = readFileSync(join(__dirname, "ElevenLabsAgentWidget.tsx"), "utf-8");

describe("ElevenLabsAgentWidget — Inbox client tool registration", () => {
  it("registers list_inbox_items in the clientTools map, wired to getInboxItems", () => {
    expect(SOURCE).toMatch(/list_inbox_items:\s*\(\)\s*=>\s*\{[\s\S]*guardCurrentToolInvocation\("list_inbox_items"\)[\s\S]*runDirectToolWithDiagnostic\("list_inbox_items",\s*\{\},\s*\(\)\s*=>\s*getInboxItems\(\)\)/);
  });

  it("registers act_on_inbox_item in the clientTools map, wired to actOnInboxItem", () => {
    expect(SOURCE).toMatch(/act_on_inbox_item:\s*\(params[^)]*\)\s*=>\s*\{[\s\S]*guardCurrentToolInvocation\("act_on_inbox_item"\)[\s\S]*runDirectToolWithDiagnostic\("act_on_inbox_item",\s*params,\s*\(\)\s*=>\s*actOnInboxItem\(params\)\)/);
  });

  it("imports the Clear My Head Inbox lib functions, not a new/duplicate storage module", () => {
    expect(SOURCE).toMatch(/from ["']\.\.\/\.\.\/lib\/clear-my-head-inbox["']/);
    expect(SOURCE).toContain("listClearMyHeadInboxItems");
    expect(SOURCE).toContain("deleteClearMyHeadInboxItem");
  });
});

function inboxToolsBlock(): string {
  const start = SOURCE.indexOf("const getInboxItems = useCallback(");
  const end = SOURCE.indexOf("const runDirectToolWithDiagnostic = useCallback(", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe("ElevenLabsAgentWidget — list_inbox_items is read-only", () => {
  it("only calls listClearMyHeadInboxItems — no save/create/delete call in its body", () => {
    const start = SOURCE.indexOf("const getInboxItems = useCallback(");
    const end = SOURCE.indexOf("const actOnInboxItem = useCallback(", start);
    const block = SOURCE.slice(start, end);
    expect(block).toContain("await listClearMyHeadInboxItems(20)");
    expect(block).not.toMatch(/saveCarsonNote|createTodo\(|createReminderTask|createAndSendDelegation|createAndSendDirectMessage|deleteClearMyHeadInboxItem/);
  });

  it("returns a numbered list plus a suggestion menu covering note/to-do/reminder/delegation/message/delete", () => {
    const block = inboxToolsBlock();
    expect(block).toMatch(/\$\{i \+ 1\}\. \$\{item\.text\}/);
    expect(block).toMatch(/note, to-do, reminder, delegation, message, or delete/);
  });

  it("handles an empty inbox without implying anything is broken", () => {
    const block = inboxToolsBlock();
    expect(block).toContain('return "Your inbox is empty."');
  });
});

describe("ElevenLabsAgentWidget — act_on_inbox_item requires explicit, matched instruction before any change", () => {
  it("requires a non-empty query before doing any lookup or action", () => {
    const block = inboxToolsBlock();
    const queryCheckIndex = block.indexOf("if (!q) {");
    const lookupIndex = block.indexOf("const items = await listClearMyHeadInboxItems(100)");
    expect(queryCheckIndex).toBeGreaterThan(-1);
    expect(lookupIndex).toBeGreaterThan(queryCheckIndex);
  });

  it("asks for disambiguation instead of guessing when multiple items match", () => {
    const block = inboxToolsBlock();
    expect(block).toMatch(/if \(matches\.length > 1\) \{[\s\S]{0,400}Ask the user which one they mean/);
  });

  it("never acts when nothing matches the query", () => {
    const block = inboxToolsBlock();
    expect(block).toMatch(/if \(matches\.length === 0\) \{[\s\S]{0,200}I couldn't find an inbox item matching/);
  });

  function actionBranch(block: string, action: string): string {
    const actionIndex = block.indexOf(`if (action === "${action}") {`);
    expect(actionIndex).toBeGreaterThan(-1);
    const nextActionIndex = block.indexOf('if (action ===', actionIndex + 1);
    return nextActionIndex > -1 ? block.slice(actionIndex, nextActionIndex) : block.slice(actionIndex);
  }

  // Reminder is deliberately excluded — see the dedicated "does not
  // auto-delete" test below. Reminder creation is not proof the underlying
  // thought is resolved, so the source item must stay.
  for (const action of ["note", "todo", "delegate", "message", "delete"] as const) {
    it(`only deletes the inbox item AFTER a successful ${action} action (never before, never on failure)`, () => {
      const block = inboxToolsBlock();
      const branch = actionBranch(block, action);

      const deleteIndex = branch.indexOf("await deleteClearMyHeadInboxItem(item.id)");
      const catchIndex = branch.indexOf("} catch (err) {");
      expect(deleteIndex).toBeGreaterThan(-1);
      // The delete call must appear before the catch block (i.e. inside try, after the create/send succeeded).
      expect(deleteIndex).toBeLessThan(catchIndex);
    });
  }

  it("reminder requires time_text and never creates or deletes anything without it", () => {
    const block = inboxToolsBlock();
    const branch = actionBranch(block, "reminder");
    const missingTimeIndex = branch.indexOf("I need to know when to remind you");
    const createIndex = branch.indexOf("await createReminderTask(");
    expect(missingTimeIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(missingTimeIndex);
  });

  it("reminder creates the reminder but does NOT delete the source inbox item — creation is not completion", () => {
    const block = inboxToolsBlock();
    const branch = actionBranch(block, "reminder");
    expect(branch).toContain("await createReminderTask(");
    expect(branch).not.toContain("await deleteClearMyHeadInboxItem(item.id)");
  });

  it("note checks for an existing duplicate before saving, and never deletes when a duplicate blocks it", () => {
    const block = inboxToolsBlock();
    const branch = actionBranch(block, "note");
    const dupeCheckIndex = branch.indexOf("findNoteMatches(existingNotes, item.text)");
    const dupeReturnIndex = branch.indexOf("You already have a note that says");
    const saveIndex = branch.indexOf("await saveCarsonNote(");
    expect(dupeCheckIndex).toBeGreaterThan(-1);
    expect(dupeReturnIndex).toBeGreaterThan(dupeCheckIndex);
    expect(saveIndex).toBeGreaterThan(dupeReturnIndex);

    // The duplicate-return branch must not fall through to a delete call —
    // scope strictly to the "if (dupes.length > 0)" block.
    const dupeBlockEnd = branch.indexOf("}", dupeReturnIndex);
    const dupeBlock = branch.slice(dupeCheckIndex, dupeBlockEnd);
    expect(dupeBlock).not.toContain("deleteClearMyHeadInboxItem");
  });

  it("todo checks for an existing duplicate before creating, and never deletes when a duplicate blocks it", () => {
    const block = inboxToolsBlock();
    const branch = actionBranch(block, "todo");
    const dupeCheckIndex = branch.indexOf("findTodoMatches(existingTodos, item.text)");
    const dupeReturnIndex = branch.indexOf("You already have");
    const createIndex = branch.indexOf("await createTodo(");
    expect(dupeCheckIndex).toBeGreaterThan(-1);
    expect(dupeReturnIndex).toBeGreaterThan(dupeCheckIndex);
    expect(createIndex).toBeGreaterThan(dupeReturnIndex);

    const dupeBlockEnd = branch.indexOf("}", dupeReturnIndex);
    const dupeBlock = branch.slice(dupeCheckIndex, dupeBlockEnd);
    expect(dupeBlock).not.toContain("deleteClearMyHeadInboxItem");
  });

  it("message refuses to silently send task-like text and asks instead — no send, no delete", () => {
    const block = inboxToolsBlock();
    const branch = actionBranch(block, "message");
    const guardIndex = branch.indexOf("looksLikeTaskInstruction(item.text)");
    const sendIndex = branch.indexOf("await createAndSendDirectMessage(");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(sendIndex).toBeGreaterThan(guardIndex);

    // The guard's own return must precede any send/delete call.
    const guardReturnIndex = branch.indexOf("reads like something you want done");
    expect(guardReturnIndex).toBeGreaterThan(guardIndex);
    expect(guardReturnIndex).toBeLessThan(sendIndex);
  });

  it("delegate requires a resolvable person with a phone number before sending anything", () => {
    const block = inboxToolsBlock();
    const delegateIndex = block.indexOf('if (action === "delegate") {');
    const nextActionIndex = block.indexOf('if (action ===', delegateIndex + 1);
    const branch = block.slice(delegateIndex, nextActionIndex);
    expect(branch).toMatch(/if \(!person\) \{[\s\S]{0,120}I couldn't find/);
    expect(branch).toMatch(/if \(!person\.phone\) \{[\s\S]{0,150}has no phone number saved/);
    const phoneCheckIndex = branch.indexOf("if (!person.phone)");
    const sendIndex = branch.indexOf("await createAndSendDelegation(");
    expect(sendIndex).toBeGreaterThan(phoneCheckIndex);
  });

  it("message requires WhatsApp consent before sending anything", () => {
    const block = inboxToolsBlock();
    const messageIndex = block.indexOf('if (action === "message") {');
    const branch = block.slice(messageIndex);
    const consentCheckIndex = branch.indexOf("whatsapp_opted_in !== true");
    const sendIndex = branch.indexOf("await createAndSendDirectMessage(");
    expect(consentCheckIndex).toBeGreaterThan(-1);
    expect(sendIndex).toBeGreaterThan(consentCheckIndex);
  });

  it("delete never calls any create/save/send function — only removes the inbox row", () => {
    const block = inboxToolsBlock();
    const deleteIndex = block.indexOf('if (action === "delete") {');
    const branch = block.slice(deleteIndex);
    const closeIndex = branch.indexOf("return \"I don't know how to perform that action on an inbox item");
    const deleteBranch = branch.slice(0, closeIndex);
    expect(deleteBranch).not.toMatch(/saveCarsonNote|createTodo\(|createReminderTask|createAndSendDelegation|createAndSendDirectMessage/);
    expect(deleteBranch).toContain("await deleteClearMyHeadInboxItem(item.id)");
  });

  it("delegate uses the existing delegation path (confirmation link + follow-up), never the plain direct-message path", () => {
    const block = inboxToolsBlock();
    const branch = actionBranch(block, "delegate");
    expect(branch).toContain("await createAndSendDelegation(");
    expect(branch).not.toContain("createAndSendDirectMessage(");
  });

  it("message uses the plain direct-message path, never the delegation/task path", () => {
    const block = inboxToolsBlock();
    const branch = actionBranch(block, "message");
    expect(branch).toContain("await createAndSendDirectMessage(");
    expect(branch).not.toContain("createAndSendDelegation(");
  });
});

describe("ElevenLabsAgentWidget — existing note/to-do/task tools are unchanged by the Inbox addition", () => {
  it("act_on_note is still registered and untouched", () => {
    expect(SOURCE).toMatch(/act_on_note:\s*\(params[^)]*\)\s*=>\s*\{[\s\S]*guardCurrentToolInvocation\("act_on_note"\)[\s\S]*runDirectToolWithDiagnostic\("act_on_note",\s*params,\s*\(\)\s*=>\s*actOnNote\(params\)\)/);
  });

  it("create_todo and complete_todo are still registered and untouched", () => {
    expect(SOURCE).toMatch(/create_todo:\s*\(params[^)]*\)\s*=>\s*\{[\s\S]*guardCurrentToolInvocation\("create_todo"\)[\s\S]*runDirectToolWithDiagnostic\("create_todo",\s*params,\s*\(\)\s*=>\s*createTodoTool\(params\)\)/);
    expect(SOURCE).toMatch(/complete_todo:\s*\(params[^)]*\)\s*=>\s*\{[\s\S]*guardCurrentToolInvocation\("complete_todo"\)[\s\S]*runDirectToolWithDiagnostic\("complete_todo",\s*params,\s*\(\)\s*=>\s*completeTodoTool\(params\)\)/);
  });

  it("save_note is still registered and untouched", () => {
    expect(SOURCE).toMatch(/save_note:\s*\(params[^)]*\)\s*=>\s*\{[\s\S]*guardCurrentToolInvocation\("save_note"\)[\s\S]*runDirectToolWithDiagnostic\("save_note",\s*params,\s*\(\)\s*=>\s*saveNote\(params\)\)/);
  });
});
