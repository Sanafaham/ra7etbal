/**
 * carson-memory.ts
 *
 * Persists deterministic session logs to Supabase (`carson_memory` table)
 * so Carson can recall what happened in previous conversations.
 *
 * No LLM summaries. No embeddings. No external services.
 * Each summary is a plain-text log of tool calls that succeeded during a
 * single voice session, e.g.:
 *   "Created reminder: call Loulya. Sent follow-up to Grace."
 *
 * Schema (created via SQL migration — no code migration needed):
 *   carson_memory (id, user_id, created_at, summary)
 *   RLS: user sees only their own rows
 */

import { supabase } from "./supabase";

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/**
 * Persist a session summary for the signed-in user.
 * Fire-and-forget safe — callers may `.catch(() => {})`.
 */
export async function saveSessionMemory(summary: string): Promise<void> {
  const trimmed = summary.trim();
  console.log(
    `[carson-memory] saveSessionMemory called — length=${trimmed.length} preview="${trimmed.slice(0, 80)}"`,
  );
  if (!trimmed) {
    console.warn("[carson-memory] saveSessionMemory — empty summary, skipping");
    return;
  }

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  console.log(
    `[carson-memory] auth check — user=${user?.id ?? "null"} authError=${authError?.message ?? "none"}`,
  );
  if (!user) {
    console.warn("[carson-memory] saveSessionMemory — no auth user, skipping");
    return; // not signed in — silently skip
  }

  const { error } = await supabase
    .from("carson_memory")
    .insert({ user_id: user.id, summary: trimmed });

  if (error) {
    console.error("[carson-memory] saveSessionMemory INSERT failed:", error.message, error.code);
  } else {
    console.log("[carson-memory] saveSessionMemory INSERT success ✓");
  }
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Load the last N session summaries for the signed-in user, formatted as a
 * ready-to-inject string for the `recent_memory` dynamic variable.
 *
 * Returns "No previous sessions." when the table is empty or on error so
 * the dynamic variable always has a safe value.
 */
export async function loadRecentMemory(limit = 5): Promise<string> {
  const { data, error } = await supabase
    .from("carson_memory")
    .select("created_at, summary")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[carson-memory] loadRecentMemory failed:", error.message);
    return "No previous sessions.";
  }

  if (!data || data.length === 0) return "No previous sessions.";

  return data
    .reverse() // oldest first so Carson reads chronologically
    .map((row) => {
      const date = new Date(row.created_at).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      return `[${date}] ${row.summary}`;
    })
    .join("\n");
}
