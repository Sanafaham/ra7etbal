/**
 * carson-persistent-memory.ts
 *
 * Stores and retrieves explicit behavioral instructions the user has asked
 * Carson to follow permanently across all sessions.
 *
 * Distinct from carson_facts (inferred key/value data) and carson_memory
 * (session summaries). These rows are user-triggered imperatives:
 *   "always ask before delegating"
 *   "never use the word tasks"
 *   "from now on, keep responses under two sentences"
 *
 * Schema (supabase/migrations/20260611_create_carson_persistent_memory.sql):
 *   carson_persistent_memory (id, user_id, category, instruction, created_at, updated_at)
 *   RLS: authenticated users select / insert / delete their own rows only
 */

import { supabase } from "./supabase";

/**
 * Load all persistent instructions for the signed-in user, formatted as a
 * ready-to-inject string for the `persistent_instructions` dynamic variable.
 *
 * Returns an empty string when there are no instructions or on error —
 * the dynamic variable always has a safe value.
 */
export async function loadPersistentMemory(): Promise<string> {
  const { data, error } = await supabase
    .from("carson_persistent_memory")
    .select("category, instruction")
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[persistent-memory] loadPersistentMemory failed:", error.message);
    return "";
  }

  if (!data || data.length === 0) return "";

  const lines = data.map((row) => `- ${row.category}: ${row.instruction}`);
  return [
    "Persistent instructions (follow these always, silently, without announcing them):",
    ...lines,
  ].join("\n");
}

/**
 * Save a persistent behavioral instruction for the signed-in user.
 *
 * Throws on insert failure so the caller can surface an error to the user.
 */
export async function savePersistentInstruction(
  category: string,
  instruction: string,
): Promise<void> {
  const trimmedInstruction = instruction.trim();
  const trimmedCategory = (category ?? "general").trim() || "general";

  if (!trimmedInstruction) return;

  const { error } = await supabase
    .from("carson_persistent_memory")
    .insert({ category: trimmedCategory, instruction: trimmedInstruction });

  if (error) {
    console.error("[persistent-memory] savePersistentInstruction failed:", error.message);
    throw error;
  }
}
