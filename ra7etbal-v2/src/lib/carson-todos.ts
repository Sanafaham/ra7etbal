/**
 * carson-todos.ts
 *
 * Active personal commitments saved via Carson voice or the To-do tab:
 *   "Add buy flowers to my to-do list", "Mark buy flowers done"
 *
 * Distinct from:
 *   - carson_notes  — passive information, ideas, reference material (no
 *                      status, never auto-converted)
 *   - tasks         — delegations / reminders / calendar-linked actions
 *                      created when a to-do is converted
 */

import { supabase } from "./supabase";

export type TodoStatus = "active" | "completed" | "archived";

export interface CarsonTodo {
  id: string;
  title: string;
  description: string | null;
  status: TodoStatus;
  source: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

const COLUMNS = "id, title, description, status, source, created_at, updated_at, completed_at";

/**
 * Create a to-do for the currently signed-in user.
 * Throws on failure so the caller (client tool / UI) can return an honest error.
 */
export async function createTodo(
  title: string,
  description: string | null = null,
  source = "voice",
): Promise<CarsonTodo> {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) throw new Error("Cannot create a to-do without a title.");

  const { data, error } = await supabase
    .from("carson_todos")
    .insert({
      title: trimmedTitle,
      description: description?.trim() || null,
      source: source.trim() || "voice",
    })
    .select(COLUMNS)
    .single();

  if (error) {
    console.error("[carson-todos] createTodo failed:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw error;
  }
  console.error("[TODO_DEBUG] createTodo() insert succeeded, row id:", data?.id);
  return data as CarsonTodo;
}

/**
 * Load active (not completed/archived) to-dos for the signed-in user.
 * Returns empty array on error — never throws (read path mirrors carson-notes).
 */
export async function listActiveTodos(limit = 50): Promise<CarsonTodo[]> {
  const { data, error } = await supabase
    .from("carson_todos")
    .select(COLUMNS)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[carson-todos] listActiveTodos failed:", error.message);
    return [];
  }
  return (data ?? []) as CarsonTodo[];
}

/**
 * Load all to-dos (any status) for the signed-in user — used by the To-do UI
 * so completed items can still be shown/undone before being archived.
 * Returns empty array on error — never throws.
 */
export async function listAllTodos(limit = 100): Promise<CarsonTodo[]> {
  const { data, error } = await supabase
    .from("carson_todos")
    .select(COLUMNS)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[carson-todos] listAllTodos failed:", error.message);
    return [];
  }
  return (data ?? []) as CarsonTodo[];
}

/** Mark a to-do done. Sets status='completed' and stamps completed_at. */
export async function completeTodo(id: string): Promise<void> {
  const trimmed = id.trim();
  if (!trimmed) return;

  const { error } = await supabase
    .from("carson_todos")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", trimmed);

  if (error) {
    console.error("[carson-todos] completeTodo failed:", error.message);
    throw error;
  }
}

/** Reopen a completed to-do back to active. Clears completed_at. */
export async function reopenTodo(id: string): Promise<void> {
  const trimmed = id.trim();
  if (!trimmed) return;

  const { error } = await supabase
    .from("carson_todos")
    .update({ status: "active", completed_at: null })
    .eq("id", trimmed);

  if (error) {
    console.error("[carson-todos] reopenTodo failed:", error.message);
    throw error;
  }
}

/** Soft-archive a to-do (kept in history, hidden from the active list). */
export async function archiveTodo(id: string): Promise<void> {
  const trimmed = id.trim();
  if (!trimmed) return;

  const { error } = await supabase
    .from("carson_todos")
    .update({ status: "archived" })
    .eq("id", trimmed);

  if (error) {
    console.error("[carson-todos] archiveTodo failed:", error.message);
    throw error;
  }
}

/** Hard-delete a to-do. RLS guarantees users can only delete their own rows. */
export async function deleteTodo(id: string): Promise<void> {
  const trimmed = id.trim();
  if (!trimmed) return;

  const { error } = await supabase
    .from("carson_todos")
    .delete()
    .eq("id", trimmed);

  if (error) {
    console.error("[carson-todos] deleteTodo failed:", error.message);
    throw error;
  }
}

/** Update a to-do's title and/or description. */
export async function updateTodo(
  id: string,
  patch: { title?: string; description?: string | null },
): Promise<void> {
  const trimmed = id.trim();
  if (!trimmed) return;

  const update: Record<string, string | null> = {};
  if (patch.title !== undefined) {
    const t = patch.title.trim();
    if (!t) throw new Error("To-do title cannot be empty.");
    update.title = t;
  }
  if (patch.description !== undefined) {
    update.description = patch.description?.trim() || null;
  }
  if (Object.keys(update).length === 0) return;

  const { error } = await supabase
    .from("carson_todos")
    .update(update)
    .eq("id", trimmed);

  if (error) {
    console.error("[carson-todos] updateTodo failed:", error.message);
    throw error;
  }
}

/**
 * Format active to-dos for injection into ra7etbal_state / buildCarsonContext.
 * Returns empty string when there are no active to-dos.
 * Mirrors formatNotesForContext in carson-notes.ts.
 */
export function formatTodosForContext(todos: CarsonTodo[]): string {
  const active = todos.filter((t) => t.status === "active");
  if (active.length === 0) return "";

  const lines = active.map((t) => {
    const date = new Date(t.created_at).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    return `- [${date}] ${t.title}`;
  });

  return [
    "ACTIVE TO-DOS (personal commitments the user has not completed yet):",
    ...lines,
  ].join("\n");
}

/**
 * Case-insensitive substring match against to-do titles — shared by the
 * act_on_todo-style client tool and the UI's "find by query" affordances.
 * Pure function so it can be unit-tested without hitting Supabase.
 */
export function findTodoMatches(todos: CarsonTodo[], query: string): CarsonTodo[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return todos.filter(
    (t) =>
      t.title.toLowerCase().includes(q) ||
      (t.description ?? "").toLowerCase().includes(q),
  );
}
