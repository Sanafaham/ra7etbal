import { SESSION_STALE_THRESHOLD_DAYS } from "./carson-epistemic-gate";
import {
  RECAP_PREFIX,
  SESSION_HISTORY_HEADER,
  isRecapRow as sharedIsRecapRow,
  formatSessionRecaps,
} from "../../shared/carson-memory-selection.js";

// Recap formatting is shared with WhatsApp Carson (api/_carson-agent-turn.js)
// through shared/carson-memory-selection.js so both channels read the same
// carson_memory columns (created_at, summary) the same way.
export { RECAP_PREFIX, SESSION_HISTORY_HEADER };

/** True when a summary row is a session recap rather than a durable fact. */
export function isRecapRow(summary: string): boolean {
  return sharedIsRecapRow(summary);
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
  return formatSessionRecaps(rows, { staleDays: SESSION_STALE_THRESHOLD_DAYS });
}
