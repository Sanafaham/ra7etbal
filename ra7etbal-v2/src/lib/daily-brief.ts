import { isReminderOverdue } from "./reminder-time";
import type { Task } from "../types/task";

export interface DailyBrief {
  needsAttention: Task[];
  waitingOnOthers: Task[];
  later: Task[];
  /** Legacy alias for Home/Actions until those screens move to needsAttention. */
  needsYou: Task[];
  /** Legacy alias for Home/Actions until those screens move to waitingOnOthers. */
  waiting: Task[];
  /** Legacy bucket for Home/Actions until those screens move to later. */
  done: Task[];
  summary: DailyBriefSummary;
}

export interface DailyBriefSummary {
  paragraph: string;
  headline: string;
  lines: string[];
}

export function buildDailyBrief(tasks: Task[], now = new Date()): DailyBrief {
  const activeTasks = tasks.filter((task) => task.archived_at == null);
  const waitingIds = new Set(
    activeTasks.filter((task) => isWaitingTask(task)).map((task) => task.id),
  );

  const needsAttention = activeTasks
    .filter((task) => task.status !== "done")
    .filter((task) => isNeedsYouTask(task, waitingIds, now))
    .sort((a, b) => getNeedsYouSortValue(a, now) - getNeedsYouSortValue(b, now));

  const waitingOnOthers = activeTasks
    .filter((task) => isWaitingTask(task))
    .sort((a, b) => getDateValue(b.created_at) - getDateValue(a.created_at));

  const later = activeTasks
    .filter((task) => isLaterTask(task, needsAttention, waitingOnOthers))
    .sort((a, b) => getLaterSortValue(a) - getLaterSortValue(b));

  const done = activeTasks
    .filter((task) => task.status === "done")
    .filter((task) => isDoneToday(task, now) || task.confirmed_at == null)
    .sort((a, b) => getDoneSortValue(b) - getDoneSortValue(a));

  return {
    needsAttention,
    waitingOnOthers,
    later,
    needsYou: needsAttention,
    waiting: waitingOnOthers,
    done,
    summary: buildBriefSummary(needsAttention, waitingOnOthers, later, now),
  };
}

function buildBriefSummary(
  needsAttention: Task[],
  waitingOnOthers: Task[],
  later: Task[],
  now: Date,
): DailyBriefSummary {
  // --- State headline always comes first so Home hero shows status, not task text ---
  let stateHeadline: string;
  if (needsAttention.length === 0) stateHeadline = "You're clear tonight.";
  else if (needsAttention.length === 1) stateHeadline = "One thing needs your attention.";
  else stateHeadline = "A few things need your attention.";

  const sentences: string[] = [stateHeadline];

  // --- Detail sentences ---
  if (needsAttention.length === 1) {
    // Push the specific item as a supporting line
    const detail = buildAttentionSentence(needsAttention[0], now);
    sentences.push(detail);
  } else if (needsAttention.length >= 2) {
    // First two items become supporting lines in Home
    needsAttention.slice(0, 2).forEach((task) => {
      const desc = briefDesc(task.description);
      if (desc) sentences.push(`${desc}.`);
    });
  }

  // --- Waiting on others ---
  if (waitingOnOthers.length === 1) {
    sentences.push(buildWaitingSentence(waitingOnOthers[0]));
  } else if (waitingOnOthers.length === 2) {
    const names = waitingOnOthers
      .map((t) => capitalize(t.assigned_to?.trim() ?? ""))
      .filter(Boolean);
    if (names.length === 2) {
      sentences.push(`Waiting on ${names[0]} and ${names[1]}.`);
    } else {
      sentences.push("Two items are waiting on others.");
    }
  } else if (waitingOnOthers.length > 2) {
    sentences.push(
      `${formatBriefCount(waitingOnOthers.length)} items are waiting on others.`,
    );
  }

  // --- Calm close ---
  // Only show when there are enough active items that the reassurance is meaningful (≥ 3 total).
  const totalActive = needsAttention.length + waitingOnOthers.length + later.length;
  if (totalActive >= 3) {
    sentences.push("Everything else is under control.");
  }

  const paragraph = sentences.join(" ");
  const [headline = paragraph, ...lines] = sentences;
  return { paragraph, headline, lines };
}

function buildAttentionSentence(task: Task, now: Date): string {
  const desc = briefDesc(task.description);
  if (!desc) return "One thing needs your attention.";
  if (task.type === "reminder" && task.due_at) {
    if (isReminderOverdue(task.due_at, now)) return `Overdue: ${desc.charAt(0).toLowerCase()}${desc.slice(1)}.`;
    return `${desc} today.`;
  }
  return `${desc} needs your attention.`;
}

function buildWaitingSentence(task: Task): string {
  const name = capitalize(task.assigned_to?.trim() ?? "");
  const desc = cleanForWaiting(task.description);
  if (name && desc) return `Waiting on ${name} to confirm ${desc}.`;
  if (name) return `Waiting on ${name}.`;
  return "One item is waiting on someone.";
}

/** Strip trailing punctuation, capitalize, truncate to 45 chars. */
function briefDesc(raw: string): string {
  const s = capitalize(raw.trim().replace(/[.!?]+$/, "").trim());
  return s.length > 45 ? s.slice(0, 45).trimEnd() + "…" : s;
}

/**
 * For waiting sentences: strip leading action verbs so
 * "Confirm dinner" → "dinner" and the sentence reads naturally:
 * "Grace hasn't confirmed dinner yet."
 */
function cleanForWaiting(raw: string): string {
  const desc = briefDesc(raw);
  const cleaned = desc.replace(
    /^(Confirm|Ask|Tell|Remind|Have|Message|Send|Check|Follow up on|Follow up|Get)\s+/i,
    "",
  );
  if (cleaned === desc) return desc;
  return cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
}

function capitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function isNeedsYouTask(task: Task, waitingIds: Set<string>, now: Date): boolean {
  if (task.status === "cancelled") return true;
  if (isWaitingInterventionTask(task)) return true;

  if (task.type === "reminder") {
    return isReminderOverdue(task.due_at, now) || isDueToday(task, now);
  }

  if (waitingIds.has(task.id)) return false;
  return isOwnerTask(task);
}

function isWaitingTask(task: Task): boolean {
  if (task.status === "done" || task.status === "cancelled") return false;
  if (task.needs_follow_up) return true;
  if (task.type === "delegation" && task.assigned_to) return true;
  return task.type === "followup";
}

function isWaitingInterventionTask(task: Task): boolean {
  if (task.type !== "delegation" && task.type !== "followup") return false;
  return task.status === "cancelled";
}

function isLaterTask(
  task: Task,
  needsAttention: Task[],
  waitingOnOthers: Task[],
): boolean {
  if (needsAttention.some((item) => item.id === task.id)) return false;
  if (waitingOnOthers.some((item) => item.id === task.id)) return false;
  if (task.status === "done" || task.status === "cancelled") return false;
  return true;
}

function isOwnerTask(task: Task): boolean {
  const assignee = task.assigned_to?.trim().toLowerCase();
  return !assignee || assignee === "me";
}

function isDueToday(task: Task, now: Date): boolean {
  if (!task.due_at) return false;
  const due = new Date(task.due_at);
  if (Number.isNaN(due.getTime())) return false;
  return isSameLocalDay(due, now);
}

function isDoneToday(task: Task, now: Date): boolean {
  if (!task.confirmed_at) return false;
  const confirmed = new Date(task.confirmed_at);
  if (Number.isNaN(confirmed.getTime())) return false;
  return isSameLocalDay(confirmed, now);
}

function getNeedsYouSortValue(task: Task, now: Date): number {
  if (task.type === "reminder" && task.due_at) {
    const due = getDateValue(task.due_at);
    if (isReminderOverdue(task.due_at, now)) return due;
    return 10_000_000_000_000 + due;
  }

  if (task.status === "cancelled") return 20_000_000_000_000 + getDateValue(task.created_at);
  return 30_000_000_000_000 - getDateValue(task.created_at);
}

function getDoneSortValue(task: Task): number {
  return getDateValue(task.confirmed_at ?? task.created_at);
}

function getLaterSortValue(task: Task): number {
  if (task.type === "reminder" && task.due_at) return getDateValue(task.due_at);
  return 10_000_000_000_000 - getDateValue(task.created_at);
}

function getDateValue(value: string | null): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function formatBriefCount(count: number): string {
  if (count === 1) return "One";
  if (count === 2) return "Two";
  if (count === 3) return "Three";
  return String(count);
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
