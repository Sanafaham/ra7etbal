/**
 * carson-memory.ts
 *
 * Persists session summaries to Supabase (`carson_memory` table)
 * so Carson can recall what happened in previous conversations.
 *
 * V3: summaries are LLM-generated bullet points from the full session
 * transcript, plus a deterministic action log when tools were used.
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
  if (!trimmed) return;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return; // not signed in — silently skip

  const { error } = await supabase
    .from("carson_memory")
    .insert({ user_id: user.id, summary: trimmed });

  if (error) {
    console.error("[carson-memory] saveSessionMemory failed:", error.message);
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
export async function loadRecentMemory(limit = 20): Promise<string> {
  const { data, error } = await supabase
    .from("carson_memory")
    .select("created_at, summary")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[carson-memory] loadRecentMemory failed:", error.message);
    return "No previous sessions.";
  }

  if (!data || data.length === 0) {
    if (import.meta.env.DEV) {
      console.info("[carson-memory] loaded rows=0 textLength=0");
    }
    return "No previous sessions.";
  }

  // Two kinds of rows live here:
  //   • "Session recap" rows (prefix below) = the ACTUAL previous session,
  //     saved every disconnect regardless of durability.
  //   • Durable memory rows (Routine/Correction/Preference/Person/…) = stable
  //     facts, saved only when the durable gate passes.
  // Label them distinctly so Carson never mistakes a 2-day-old durable fact
  // for "our last conversation". The newest recap row owns "Most recent
  // session"; everything else is labelled by kind.
  const RECAP_PREFIX = "• Session recap:";
  const isRecap = (s: string) => s.trimStart().startsWith(RECAP_PREFIX);
  // data arrives newest-first; the first recap row is the true latest session.
  const newestRecapAt = data.find((r) => isRecap(r.summary))?.created_at ?? null;

  const labeled = data.map((row) => {
    // Local date AND time so Carson can answer "what time was that session?".
    const when = new Date(row.created_at).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    const summary = row.summary.trim().replace(/\n{3,}/g, "\n");
    let label: string;
    if (isRecap(row.summary)) {
      label =
        row.created_at === newestRecapAt
          ? `[Most recent session — ${when}]`
          : `[Earlier session — ${when}]`;
    } else {
      label = `[Durable memory — ${when}]`;
    }
    return `${label}\n${summary}`;
  });

  // Reverse so Carson reads chronologically (oldest first), but the label
  // "Most recent session" still clearly identifies the latest entry at the end.
  const memoryText = labeled.reverse().join("\n\n");

  if (import.meta.env.DEV) {
    console.info(
      `[carson-memory] loaded rows=${data.length} textLength=${memoryText.length}`,
    );
  }

  return memoryText;
}
