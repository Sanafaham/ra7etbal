/**
 * Server/browser-safe duplication of src/lib/daily-brief.ts's canonical
 * Home/Updates classification (isNeedsYouTask / isWaitingTask / isLaterTask).
 *
 * DELIBERATE DUPLICATION, not a relocation (2026-08-28, structured Second
 * Brain operational evidence). src/lib/daily-brief.ts is the Home/Updates
 * UI's protected classifier and is explicitly out of scope to modify for
 * this slice — same documented-exception pattern already used for
 * isReminderOverdue/formatReminderDue in carson-morning-brief-classifier.js.
 * Parity guarded by carson-daily-brief-shared-parity.test.ts — update both
 * together if daily-brief.ts's classification ever changes.
 *
 * Only the CLASSIFICATION is duplicated here (membership rules for the
 * needsYou/waitingOnOthers/later buckets) — Home's summary/spoken-brief text
 * building stays exclusively in daily-brief.ts, untouched.
 */

function isQualityOwnerReviewStatusDup(status) {
  const normalized = typeof status === "string" ? status.trim().toLowerCase() : "";
  return normalized === "uncertain" || normalized === "substitute_review";
}

/**
 * Needs You is a decision queue, not an ownership queue — see
 * daily-brief.ts's own doc comment on isNeedsYouTask for the full rationale.
 * Ordinary actions, errands, and reminders (including overdue ones) are
 * deliberately NOT members of this category.
 */
export function isNeedsYouTask(task, waitingIds) {
  if (task.status === "cancelled") return true;
  if (isWaitingInterventionTask(task)) return true;
  if (waitingIds.has(task.id)) return false;
  return task.type === "decision" && isOwnerTask(task);
}

export function isWaitingTask(task) {
  if (task.status === "done" || task.status === "cancelled") return false;
  if (isQualityOwnerReviewStatusDup(task.quality_review_status)) return false;
  if (task.needs_follow_up) return true;
  if (task.type === "delegation" && task.assigned_to) return true;
  return task.type === "followup";
}

function isWaitingInterventionTask(task) {
  if (task.type !== "delegation" && task.type !== "followup") return false;
  if (task.status === "done") return false;
  if (task.status === "cancelled") return true;
  return isQualityOwnerReviewStatusDup(task.quality_review_status);
}

export function isLaterTask(task, needsYouIds, waitingIds) {
  if (needsYouIds.has(task.id)) return false;
  if (waitingIds.has(task.id)) return false;
  if (task.status === "done" || task.status === "cancelled") return false;
  return true;
}

function isOwnerTask(task) {
  const assignee = task.assigned_to?.trim().toLowerCase();
  return !assignee || assignee === "me";
}

/**
 * Bucket membership only (no sort order, no summary text) — matches
 * daily-brief.ts's buildDailyBrief() filter/membership logic exactly.
 */
export function buildDailyBriefBuckets(tasks, now = new Date()) {
  const activeTasks = tasks.filter((t) => t.archived_at == null);
  const waitingIds = new Set(activeTasks.filter((t) => isWaitingTask(t)).map((t) => t.id));
  const needsYou = activeTasks.filter((t) => t.status !== "done").filter((t) => isNeedsYouTask(t, waitingIds));
  const needsYouIds = new Set(needsYou.map((t) => t.id));
  const waitingOnOthers = activeTasks.filter((t) => isWaitingTask(t));
  const later = activeTasks.filter((t) => isLaterTask(t, needsYouIds, waitingIds));
  return { needsYou, waitingOnOthers, later };
}
