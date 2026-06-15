/**
 * Pending Items — the open loops Carson tracks and surfaces.
 *
 * A pending item is any active task that is unresolved: delegated but not
 * confirmed, waiting on someone, overdue, or stale for 48+ hours. Derived
 * entirely from the existing `tasks` table — no new table or migration needed.
 *
 * Used by:
 *   - buildCarsonContext()  → `ra7etbal_state` voice variable
 *   - buildMorningBriefSpoken() → spoken risks/stale section
 */

import type { Task } from "../types/task";
import { isReminderOverdue } from "./reminder-time";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PendingStaleness = "fresh" | "stale_48h" | "stale_72h";

export interface PendingItem {
  task: Task;
  /** Why this item is pending — shown to Carson. */
  reason: string;
  /** Age in ms since created_at. */
  ageMs: number;
  staleness: PendingStaleness;
  /** True when follow-up WhatsApp has already been sent. */
  followupSent: boolean;
  /** True when owner escalation push has already been fired. */
  escalated: boolean;
}

// ---------------------------------------------------------------------------
// derivePendingItems
// ---------------------------------------------------------------------------

const MS_48H = 48 * 60 * 60 * 1000;
const MS_72H = 72 * 60 * 60 * 1000;

/**
 * Derive all open loops from a task list.
 *
 * Includes:
 *   - Delegations waiting for recipient confirmation
 *   - Follow-up tasks not yet confirmed
 *   - Overdue reminders
 *   - Any pending task assigned to someone that has needs_follow_up=true
 *
 * Excludes:
 *   - Archived tasks
 *   - Completed (status=done) tasks
 *   - Cancelled tasks
 */
export function derivePendingItems(tasks: Task[], now = new Date()): PendingItem[] {
  const nowMs = now.getTime();

  return tasks
    .filter((t) => {
      if (t.archived_at != null) return false;
      if (t.status !== "pending") return false;
      return isPendingLoop(t, now);
    })
    .map((t) => {
      const ageMs = nowMs - new Date(t.created_at).getTime();
      const staleness: PendingStaleness =
        ageMs >= MS_72H ? "stale_72h" : ageMs >= MS_48H ? "stale_48h" : "fresh";

      return {
        task: t,
        reason: buildReason(t, now),
        ageMs,
        staleness,
        followupSent: t.followup_sent_at != null,
        escalated: t.escalated_at != null,
      };
    })
    .sort((a, b) => {
      // Escalated first, then by staleness descending, then by age
      if (a.escalated !== b.escalated) return a.escalated ? -1 : 1;
      if (a.staleness !== b.staleness) {
        const rank = { stale_72h: 0, stale_48h: 1, fresh: 2 };
        return rank[a.staleness] - rank[b.staleness];
      }
      return b.ageMs - a.ageMs;
    });
}

// ---------------------------------------------------------------------------
// formatPendingItemsForCarson
// ---------------------------------------------------------------------------

/**
 * Formats pending items as a labeled text block for Carson's context.
 *
 * Example output:
 *   PENDING LOOPS (open, unconfirmed, waiting):
 *   - delegation, 3 days, escalated — Khaled: review the contract
 *   - reminder, overdue — call the accountant
 *   - delegation, 2 days — Nasira: prep the guest room
 */
export function formatPendingItemsForCarson(
  items: PendingItem[],
  now = new Date(),
): string {
  if (items.length === 0) return "PENDING LOOPS: none";

  const lines: string[] = ["PENDING LOOPS (open, unconfirmed, waiting):"];
  const shown = items.slice(0, 10); // cap for context length

  for (const item of shown) {
    const { task: t, staleness, escalated } = item;
    const who = t.assigned_to?.trim() ? `${t.assigned_to.trim()}: ` : "";
    const age = formatAge(item.ageMs);
    const flags: string[] = [t.type, age];
    if (staleness === "stale_72h") flags.push("STALE 3+ days");
    else if (staleness === "stale_48h") flags.push("STALE 2+ days");
    if (escalated) flags.push("escalated — no response yet");
    if (t.type === "reminder" && isReminderOverdue(t.due_at, now)) flags.push("OVERDUE");
    lines.push(`- ${flags.join(", ")} — ${who}${t.description.trim()}`);
  }

  if (items.length > 10) {
    lines.push(`(${items.length - 10} more pending items not shown)`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPendingLoop(t: Task, now: Date): boolean {
  // Overdue reminder
  if (t.type === "reminder") return isReminderOverdue(t.due_at, now);
  // Delegation or follow-up waiting on someone
  if (t.type === "delegation" && t.assigned_to) return true;
  if (t.type === "followup") return true;
  if (t.needs_follow_up && t.assigned_to) return true;
  return false;
}

function buildReason(t: Task, now: Date): string {
  if (t.type === "reminder" && isReminderOverdue(t.due_at, now)) {
    return "overdue reminder";
  }
  if (t.escalated_at) return `escalated — ${t.assigned_to} has not responded`;
  if (t.followup_sent_at) return `follow-up sent — waiting on ${t.assigned_to}`;
  if (t.assigned_to) return `waiting on ${t.assigned_to}`;
  return "unresolved";
}

function formatAge(ms: number): string {
  const hours = ms / (60 * 60 * 1000);
  if (hours < 1) return "< 1 hour";
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}
