/**
 * carson-notes.ts
 *
 * Explicit user captures saved via Carson voice:
 *   "Save this note", "Remember this idea", "Hold this thought"
 *
 * Distinct from:
 *   - carson_memory   — session summaries (implicit, auto-generated)
 *   - carson_facts    — inferred key/value data
 *   - tasks           — action-oriented items
 */

import { supabase } from "./supabase";

/**
 * Save a note for the currently signed-in user.
 * Throws on failure so the caller (client tool) can return an honest error.
 */
export async function saveCarsonNote(
  note: string,
  category = "general",
  source = "voice",
): Promise<void> {
  const trimmed = note.trim();
  if (!trimmed) return;

  const trimmedCategory = category.trim() || "general";
  const trimmedSource = source.trim() || "voice";

  const { error } = await supabase
    .from("carson_notes")
    .insert({
      note: trimmed,
      category: trimmedCategory,
      source: trimmedSource,
    });

  if (error) {
    console.error("[carson-notes] saveCarsonNote failed:", error.message);
    throw error;
  }
}

export interface CarsonNote {
  id: string;
  note: string;
  category: string;
  source: string;
  created_at: string;
  updated_at: string;
}

/**
 * Load recent notes for the currently signed-in user.
 * Returns empty array on error — never throws.
 */
export async function loadRecentNotes(limit = 20): Promise<CarsonNote[]> {
  const { data, error } = await supabase
    .from("carson_notes")
    .select("id, note, category, source, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[carson-notes] loadRecentNotes failed:", error.message);
    return [];
  }

  return (data ?? []) as CarsonNote[];
}

/**
 * Delete a single note for the signed-in user.
 * RLS guarantees users can only delete their own rows.
 */
export async function deleteCarsonNote(id: string): Promise<void> {
  const trimmed = id.trim();
  if (!trimmed) return;

  const { error } = await supabase
    .from("carson_notes")
    .delete()
    .eq("id", trimmed);

  if (error) {
    console.error("[carson-notes] deleteCarsonNote failed:", error.message);
    throw error;
  }
}

/**
 * Case-insensitive substring match against note text. Mirrors
 * carson-todos.ts's findTodoMatches — matches either direction (note contains
 * the query, or the query contains the note) so a slightly reworded duplicate
 * is still caught.
 */
export function findNoteMatches(notes: CarsonNote[], query: string): CarsonNote[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  return notes.filter((n) => {
    const note = n.note.trim().toLowerCase();
    if (!note) return false;
    return note.includes(q) || q.includes(note);
  });
}

/**
 * Format notes for injection into ra7etbal_state / buildCarsonContext.
 * Returns empty string when there are no notes.
 */
export function formatNotesForContext(notes: CarsonNote[]): string {
  if (notes.length === 0) return "";

  const lines = notes.map((n) => {
    const date = new Date(n.created_at).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    const category = n.category && n.category !== "general" ? ` (${n.category})` : "";
    return `- [${date}]${category} ${n.note}`;
  });

  return [
    "SAVED NOTES (user-authored ideas/thoughts; not tasks or reminders):",
    ...lines,
  ].join("\n");
}
