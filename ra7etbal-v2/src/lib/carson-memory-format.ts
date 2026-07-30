/** Prefix marking a row as a session recap (the ACTUAL last conversation). */
export const RECAP_PREFIX = "• Session recap:";

export const SESSION_HISTORY_HEADER = [
  "SESSION HISTORY ONLY:",
  "For questions about last or previous sessions, use only these recaps.",
  "Never use durable memory, saved notes, people, tasks, routines, or completions as session history.",
].join("\n");

/** True when a summary row is a session recap rather than a durable fact. */
export function isRecapRow(summary: string): boolean {
  return summary.trimStart().startsWith(RECAP_PREFIX);
}

export interface CarsonMemoryRow {
  created_at: string;
  summary: string;
}

/**
 * Pure formatter for the `recent_memory` injection string:
 *
 *   • The newest recap row owns "[Most recent session — …]".
 *   • Older recap rows are "[Earlier session — …]".
 *   • Non-recap rows are excluded and can NEVER appear as session history.
 *
 * `rows` must be newest-first (created_at desc), as returned by the query.
 * Returns the routing header plus "No previous sessions." when no recaps exist.
 */
export function formatRecentMemory(rows: CarsonMemoryRow[]): string {
  const recaps = (rows ?? []).filter((row) => isRecapRow(row.summary));
  if (recaps.length === 0) {
    return `${SESSION_HISTORY_HEADER}\n\nNo previous sessions.`;
  }

  // newest-first input → the first recap row is the true latest session.
  const newestRecapAt = recaps[0].created_at;

  const labeled = recaps.map((row) => {
    // Local date AND time so Carson can answer "what time was that session?".
    const when = new Date(row.created_at).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    const summary = row.summary.trim().replace(/\n{3,}/g, "\n");
    const label =
      row.created_at === newestRecapAt
        ? `[Most recent session — ${when}]`
        : `[Earlier session — ${when}]`;
    return `${label}\n${summary}`;
  });

  // Reverse so Carson reads chronologically (oldest first); the explicit
  // "Most recent session" label still identifies the latest conversation.
  return `${SESSION_HISTORY_HEADER}\n\n${labeled.reverse().join("\n\n")}`;
}
