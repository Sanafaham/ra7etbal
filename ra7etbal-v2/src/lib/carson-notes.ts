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
  dismissed_at?: string | null;
  last_surfaced_at?: string | null;
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
 * Unresolved notes for the currently signed-in user — dismissed_at IS NULL,
 * i.e. not yet converted into another operational object (task, reminder,
 * delegation, calendar event). Used by the Second Brain attention-retrieval
 * layer (carson-unresolved-captures.ts), not by the Notes screen (which
 * intentionally shows every note, dismissed or not — dismissal only removes
 * a note from *unresolved operational consideration*, it stays visible and
 * editable as historical data per product decision).
 * Returns empty array on error — never throws.
 */
export async function loadUnresolvedNotes(limit = 50): Promise<CarsonNote[]> {
  const { data, error } = await supabase
    .from("carson_notes")
    .select("id, note, category, source, created_at, updated_at, dismissed_at, last_surfaced_at")
    .is("dismissed_at", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[carson-notes] loadUnresolvedNotes failed:", error.message);
    return [];
  }

  return (data ?? []) as CarsonNote[];
}

/**
 * Marks a note dismissed — it has been converted into another operational
 * object (task, reminder, delegation, calendar event) and should no longer
 * be counted as an unresolved capture. Never deletes the row: the original
 * user-authored text remains visible in the Notes screen as historical
 * record. Swallows errors (logs only) — callers use this only after the
 * downstream conversion already succeeded, so a failed dismiss write must
 * not undo or fail that already-successful action; worst case the note is
 * retrieved again next time and (per the classifier) may resurface once
 * more, which is a safe failure mode, not data loss or a false success.
 */
export async function dismissCarsonNote(id: string): Promise<void> {
  const trimmed = id.trim();
  if (!trimmed) return;

  const { error } = await supabase
    .from("carson_notes")
    .update({ dismissed_at: new Date().toISOString() })
    .eq("id", trimmed);

  if (error) {
    console.error("[carson-notes] dismissCarsonNote failed:", error.message);
  }
}

/**
 * Marks a set of notes as surfaced — call this only for notes that actually
 * appear in a rendered response handed back to the user (never for notes
 * merely retrieved and then excluded by relevance classification; see
 * carson-unresolved-captures.ts). Best-effort: swallows errors, since a
 * failed write here only risks re-surfacing an already-seen note once more,
 * not losing data or falsely claiming something was shown.
 */
export async function markCarsonNotesSurfaced(ids: string[]): Promise<void> {
  const trimmed = ids.map((id) => id.trim()).filter(Boolean);
  if (trimmed.length === 0) return;

  const { error } = await supabase
    .from("carson_notes")
    .update({ last_surfaced_at: new Date().toISOString() })
    .in("id", trimmed);

  if (error) {
    console.error("[carson-notes] markCarsonNotesSurfaced failed:", error.message);
  }
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
