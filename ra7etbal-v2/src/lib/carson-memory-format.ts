/** Prefix marking a row as a session recap (the ACTUAL last conversation). */
export const RECAP_PREFIX = "• Session recap:";

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
 *   • Non-recap rows are "[Durable memory — …]" and can NEVER be mistaken for
 *     the last conversation, even when their timestamp is globally newest.
 *
 * `rows` must be newest-first (created_at desc), as returned by the query.
 * Returns "No previous sessions." for an empty list.
 */
export function formatRecentMemory(rows: CarsonMemoryRow[]): string {
  if (!rows || rows.length === 0) return "No previous sessions.";

  // newest-first input → the first recap row is the true latest session.
  const newestRecapAt = rows.find((r) => isRecapRow(r.summary))?.created_at ?? null;

  const labeled = rows.map((row) => {
    // Local date AND time so Carson can answer "what time was that session?".
    const when = new Date(row.created_at).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    const summary = row.summary.trim().replace(/\n{3,}/g, "\n");
    let label: string;
    if (isRecapRow(row.summary)) {
      label =
        row.created_at === newestRecapAt
          ? `[Most recent session — ${when}]`
          : `[Earlier session — ${when}]`;
    } else {
      label = `[Durable memory — ${when}]`;
    }
    return `${label}\n${summary}`;
  });

  // Reverse so Carson reads chronologically (oldest first); the explicit
  // "Most recent session" label still identifies the latest conversation.
  return labeled.reverse().join("\n\n");
}
