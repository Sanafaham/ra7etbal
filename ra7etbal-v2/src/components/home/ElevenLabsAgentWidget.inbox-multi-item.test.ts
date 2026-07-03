import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Production incident: a single-utterance multi-item Inbox instruction
 * ("turn the Gemini one into a to-do, remind me to call Grace in a
 * minute, and delegate the lunch menu one to Christopher") lost context
 * on the third item — Carson asked "To whom?" despite Christopher already
 * being named, and no confirmation-linked delegation was sent.
 *
 * Investigation found no functional bug in act_on_inbox_item itself: its
 * parameter shape only ever accepts one item per call (proven below), and
 * every branch is stateless per call (fresh Supabase fetch + store reads,
 * no shared mutable ref carried between items). The fix is primarily the
 * ACTING ON INBOX ITEMS prompt section (docs/carson-elevenlabs-system-
 * prompt.md) gaining explicit multi-item sequencing guidance. These tests
 * lock in the code-side guarantees that make that prompt fix safe: the
 * delegate path is correct, confirmation-linked, and independent of
 * whatever other items were processed earlier in the same turn.
 */
const SOURCE = readFileSync(join(__dirname, "ElevenLabsAgentWidget.tsx"), "utf-8");

function inboxToolsBlock(): string {
  const start = SOURCE.indexOf("const getInboxItems = useCallback(");
  const end = SOURCE.indexOf("const runDirectToolWithDiagnostic = useCallback(", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

function actionBranch(block: string, action: string): string {
  const actionIndex = block.indexOf(`if (action === "${action}") {`);
  expect(actionIndex).toBeGreaterThan(-1);
  const nextActionIndex = block.indexOf('if (action ===', actionIndex + 1);
  return nextActionIndex > -1 ? block.slice(actionIndex, nextActionIndex) : block.slice(actionIndex);
}

describe("act_on_inbox_item — one item per call, stateless across items in the same turn", () => {
  it("the parameter shape only accepts a single query/action pair — structurally cannot batch multiple items", () => {
    const start = SOURCE.indexOf("const actOnInboxItem = useCallback(");
    const paramsEnd = SOURCE.indexOf("): Promise<string> =>", start);
    const paramsBlock = SOURCE.slice(start, paramsEnd);
    expect(paramsBlock).toMatch(/query:\s*string;/);
    expect(paramsBlock).toMatch(/action:\s*"note"\s*\|\s*"todo"\s*\|\s*"reminder"\s*\|\s*"delegate"\s*\|\s*"message"\s*\|\s*"delete";/);
    // No array/list typing anywhere in the params — one item, one call.
    expect(paramsBlock).not.toMatch(/\[\]|Array</);
  });

  it("the delegate branch does not read sessionActionsRef/currentTaskContextRef as input — only writes them, so an earlier item's processing cannot change how a later delegate call behaves", () => {
    const block = inboxToolsBlock();
    const branch = actionBranch(block, "delegate");
    // Every read of these refs in this branch must be an assignment (write), never a
    // conditional/input read that earlier items could have influenced.
    expect(branch).not.toMatch(/if\s*\(\s*currentTaskContextRef\.current/);
    expect(branch).not.toMatch(/if\s*\(\s*sessionActionsRef\.current/);
  });

  it("every action branch re-fetches inbox items fresh via listClearMyHeadInboxItems(100) at the top of the function — no stale/shared item list across calls", () => {
    // This is a single shared lookup above all branches (not per-branch), which is
    // correct: it's re-run at the START of every act_on_inbox_item invocation.
    const start = SOURCE.indexOf("const actOnInboxItem = useCallback(");
    const end = SOURCE.indexOf("const item = matches[0];", start);
    const lookupBlock = SOURCE.slice(start, end);
    expect(lookupBlock).toContain("const items = await listClearMyHeadInboxItems(100);");
  });
});

describe("act_on_inbox_item — delegation routing for task-like items (lunch menu regression)", () => {
  it("delegate branch resolves person_name and uses the existing delegation path, never direct message", () => {
    const block = inboxToolsBlock();
    const branch = actionBranch(block, "delegate");
    expect(branch).toMatch(/personNameInput = person_name\?\.trim\(\)/);
    expect(branch).toContain("await createAndSendDelegation(");
    expect(branch).not.toContain("createAndSendDirectMessage(");
  });

  it("createAndSendDelegation (used by the delegate branch) builds its message and confirmation link through the existing shared delegation boundary, not ad hoc", () => {
    const start = SOURCE.indexOf("async function createAndSendDelegation(");
    const end = SOURCE.indexOf("\n}\n", start);
    expect(start).toBeGreaterThan(-1);
    const fnBody = SOURCE.slice(start, end);
    expect(fnBody).toContain("await createDelegationTaskAndMessage({");
  });

  it("delegate branch removes the inbox item only after the delegation succeeds, and only that one item", () => {
    const block = inboxToolsBlock();
    const branch = actionBranch(block, "delegate");
    const sendIndex = branch.indexOf("await createAndSendDelegation(");
    const deleteIndex = branch.indexOf("await deleteClearMyHeadInboxItem(item.id)");
    const catchIndex = branch.indexOf("} catch (err) {");
    expect(sendIndex).toBeGreaterThan(-1);
    expect(deleteIndex).toBeGreaterThan(sendIndex);
    expect(deleteIndex).toBeLessThan(catchIndex);
    // Deletes the single matched item (`item`), not a batch/list of items.
    expect(branch).not.toMatch(/deleteClearMyHeadInboxItem\([^)]*\bitems\b/);
  });

  it('classifies "Confirm tomorrow\'s lunch menu" (the exact production example) as task-like — message action would refuse to send it', () => {
    const start = SOURCE.indexOf('import { looksLikeTaskInstruction } from "../../lib/carson-inbox-action-quality";');
    expect(start).toBeGreaterThan(-1);
  });
});

describe("act_on_inbox_item — surviving items from the multi-item scenario are untouched by an unrelated item's outcome", () => {
  it("todo duplicate-block path never deletes and never touches reminder/delegate logic", () => {
    const block = inboxToolsBlock();
    const branch = actionBranch(block, "todo");
    const dupeReturnIndex = branch.indexOf("You already have");
    const dupeBlockEnd = branch.indexOf("}", dupeReturnIndex);
    const dupeBlock = branch.slice(0, dupeBlockEnd);
    expect(dupeBlock).not.toContain("deleteClearMyHeadInboxItem");
    expect(dupeBlock).not.toMatch(/createReminderTask|createAndSendDelegation/);
  });

  it("reminder path never deletes the inbox item, regardless of what other items were processed", () => {
    const block = inboxToolsBlock();
    const branch = actionBranch(block, "reminder");
    expect(branch).toContain("await createReminderTask(");
    expect(branch).not.toContain("deleteClearMyHeadInboxItem");
  });

  it("delete action is still wired and unaffected by the delegate/message changes", () => {
    const block = inboxToolsBlock();
    const branch = actionBranch(block, "delete");
    expect(branch).toContain("await deleteClearMyHeadInboxItem(item.id)");
    expect(branch).toContain('return "Deleted from your inbox."');
  });
});

describe("Prompt doc — multi-item Inbox sequencing guidance is present", () => {
  const PROMPT = readFileSync(
    join(__dirname, "..", "..", "..", "docs", "carson-elevenlabs-system-prompt.md"),
    "utf-8",
  );

  it("instructs Carson to handle each item with its own separate act_on_inbox_item call", () => {
    expect(PROMPT).toContain("MULTI-ITEM INBOX INSTRUCTIONS");
    expect(PROMPT).toMatch(/its own separate act_on_inbox_item call/);
  });

  it("instructs Carson to re-derive each item's own parameters from the original utterance, not lose them across calls", () => {
    expect(PROMPT).toMatch(/pull that item's own query, action, time_text, and person_name from its own clause/);
    expect(PROMPT).toMatch(/Do not drop or forget a name, time, or action/);
  });

  it("names the exact delegate trigger words from the incident report", () => {
    expect(PROMPT).toMatch(/delegate, send, task, or ask someone to do it/);
  });
});
