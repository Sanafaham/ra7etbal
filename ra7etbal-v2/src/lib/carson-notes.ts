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
): Promise<void> {
  const trimmed = note.trim();
  if (!trimmed) return;

  const trimmedCategory = category.trim() || "general";

  const { error } = await supabase
    .from("carson_notes")
    .insert({
      note: trimmed,
      category: trimmedCategory,
      source: "voice",
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
