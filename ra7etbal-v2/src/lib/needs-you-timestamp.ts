import { isQualityOwnerReviewStatus } from "./quality-lifecycle";
import {
  formatDate,
  formatReminderDueTime,
  formatTime,
  isSameLocalDay,
  isYesterday,
} from "./reminder-time";
import type { Task } from "../types/task";

/**
 * A truthful label for why/when a Needs You task became the owner's action.
 * Ra7etBal does not persist a dedicated "entered Needs You" event, so this
 * never labels created_at as "Needs You since" — it only reuses an existing
 * timestamp that genuinely represents the triggering event, and falls back
 * to a plain "Created ..." label (never invented) when no more specific
 * event timestamp exists.
 *
 * Priority mirrors why a task actually qualifies as Needs You in
 * isNeedsYouTask() (daily-brief.ts), most specific reason first — this file
 * does not read or change that classification, only presents evidence for
 * it.
 */
export function getNeedsYouTimestampLabel(task: Task, now: Date = new Date()): string | null {
  if (isQualityOwnerReviewStatus(task.quality_review_status)) {
    const label = formatEventLabel("Reviewed", task.quality_reviewed_at, now);
    if (label) return label;
  }

  const escalatedLabel = formatEventLabel("Escalated", task.escalated_at, now);
  if (escalatedLabel) return escalatedLabel;

  if (task.type === "reminder") {
    const dueLabel = formatReminderDueTime(task.due_at, now);
    if (dueLabel) return dueLabel;
  }

  return formatEventLabel("Created", task.created_at, now);
}

function formatEventLabel(prefix: string, iso: string | null | undefined, now: Date): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  if (isSameLocalDay(date, now)) return `${prefix} today at ${formatTime(date)}`;
  if (isYesterday(date, now)) return `${prefix} yesterday at ${formatTime(date)}`;
  return `${prefix} ${formatDate(date)} at ${formatTime(date)}`;
}
