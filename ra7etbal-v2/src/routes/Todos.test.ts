import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "Todos.tsx"), "utf-8");

/**
 * Regression fix (2026-07-10): completed to-dos in Updates > To-do > Done
 * only offered "Reopen" — there was no way to delete a finished to-do from
 * the list. The Done section renders a separate, simplified inline <li>
 * (not the full TodoCard used for active items, which already had a
 * working Delete action in its overflow menu). Added a Delete button next
 * to Reopen in that same Done <li>, wired to the existing handleDelete /
 * deleteTodo(carson_todos table only) path already used for active items —
 * no new deletion logic, no changes to tasks/delegations/Waiting/QI/
 * WhatsApp, which are all separate tables/systems from carson_todos.
 */
describe("Todos.tsx — Done list has both Reopen and Delete", () => {
  const doneListSource = SOURCE.slice(
    SOURCE.indexOf("completedTodos.map((todo)"),
    SOURCE.indexOf("</details>"),
  );

  it("still offers Reopen, wired to handleToggleDone", () => {
    expect(doneListSource).toMatch(/onClick=\{\(\) => void handleToggleDone\(todo\)\}/);
    expect(doneListSource).toMatch(/Reopen/);
  });

  it("now offers Delete, wired to the existing handleDelete (same path active to-dos already use)", () => {
    expect(doneListSource).toMatch(/onClick=\{\(\) => void handleDelete\(todo\)\}/);
    expect(doneListSource).toMatch(/"Delete"/);
  });

  it("Delete shows the same confirm-tap-again and in-flight states as the active-item Delete action", () => {
    expect(doneListSource).toMatch(/confirmingDeleteId === todo\.id/);
    expect(doneListSource).toMatch(/deletingId === todo\.id/);
    expect(doneListSource).toMatch(/Tap again to confirm/);
    expect(doneListSource).toMatch(/Deleting…/);
  });

  it("does not introduce a second deletion implementation — deleteTodo is only imported/used once", () => {
    const deleteTodoImportCount = (SOURCE.match(/\bdeleteTodo\b/g) ?? []).length;
    // 1 import + 1 call site inside handleDelete = 2 occurrences total,
    // regardless of how many places in the UI now trigger handleDelete.
    expect(deleteTodoImportCount).toBe(2);
  });
});
