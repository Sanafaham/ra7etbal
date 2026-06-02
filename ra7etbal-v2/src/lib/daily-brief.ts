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
    summary: buildBriefSummary(needsAttention, waitingOnOthers, later, done),
  };
}

function buildBriefSummary(
  needsAttention: Task[],
  waitingOnOthers: Task[],
  later: Task[],
  alreadyHandled: Task[],
): DailyBriefSummary {
  const sentences: string[] = [];

  if (needsAttention.length === 0) {
    sentences.push("Nothing needs your attention right now.");
  } else if (needsAttention.length === 1) {
    sentences.push("One thing needs your attention today.");
  } else {
    sentences.push(`${formatBriefCount(needsAttention.length)} things need your attention.`);
  }

  if (waitingOnOthers.length > 0) {
    sentences.push(
      `${formatBriefCount(waitingOnOthers.length)} ${waitingOnOthers.length === 1 ? "item is" : "items are"} waiting on other people.`,
    );
  }

  if (alreadyHandled.length > 0) {
    sentences.push(
      `${formatBriefCount(alreadyHandled.length)} ${alreadyHandled.length === 1 ? "item is" : "items are"} already handled.`,
    );
  }

  if (needsAttention.length === 1 && waitingOnOthers.length === 0 && later.length === 0) {
    sentences.push("Everything else is under control.");
  } else if (later.length > 0 || waitingOnOthers.length > 0 || needsAttention.length > 1) {
    sentences.push("Everything else can wait.");
  } else if (needsAttention.length === 0 && alreadyHandled.length === 0) {
    sentences.push("Everything else is under control.");
  }

  const paragraph = sentences.join(" ");
  const [headline, ...lines] = sentences;

  return { paragraph, headline, lines };
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
