import { isReminderOverdue } from "./reminder-time";
import type { Task } from "../types/task";

export interface DailyBrief {
  needsYou: Task[];
  waiting: Task[];
  done: Task[];
  summary: DailyBriefSummary;
}

export interface DailyBriefSummary {
  headline: string;
  lines: string[];
}

export function buildDailyBrief(tasks: Task[], now = new Date()): DailyBrief {
  const activeTasks = tasks.filter((task) => task.archived_at == null);
  const waitingIds = new Set(
    activeTasks.filter((task) => isWaitingTask(task)).map((task) => task.id),
  );

  const needsYou = activeTasks
    .filter((task) => task.status !== "done")
    .filter((task) => isNeedsYouTask(task, waitingIds, now))
    .sort((a, b) => getNeedsYouSortValue(a, now) - getNeedsYouSortValue(b, now));

  const waiting = activeTasks
    .filter((task) => isWaitingTask(task))
    .sort((a, b) => getDateValue(b.created_at) - getDateValue(a.created_at));

  const done = activeTasks
    .filter((task) => task.status === "done")
    .filter((task) => isDoneToday(task, now) || task.confirmed_at == null)
    .sort((a, b) => getDoneSortValue(b) - getDoneSortValue(a));

  return {
    needsYou,
    waiting,
    done,
    summary: buildBriefSummary(activeTasks, needsYou, waiting, done, now),
  };
}

function buildBriefSummary(
  activeTasks: Task[],
  needsYou: Task[],
  waiting: Task[],
  done: Task[],
  now: Date,
): DailyBriefSummary {
  const urgentCount = needsYou.filter((task) => isUrgentTask(task, now)).length;
  const notUrgentCount = activeTasks.filter((task) =>
    isNotUrgentTask(task, needsYou, waiting, done),
  ).length;

  const headline =
    urgentCount > 0
      ? `${formatCount(urgentCount, "thing")} ${urgentCount === 1 ? "needs" : "need"} your attention now.`
      : needsYou.length > 0
        ? `You have ${formatCount(needsYou.length, "thing")} that ${needsYou.length === 1 ? "needs" : "need"} attention today.`
        : "Nothing urgent needs your attention right now.";

  const lines: string[] = [];

  if (waiting.length > 0) {
    lines.push(
      `${formatCount(waiting.length, "thing")} ${waiting.length === 1 ? "is" : "are"} waiting on someone else. ${waiting.length === 1 ? "It is" : "They are"} not yours to chase right now.`,
    );
  }

  if (done.length > 0) {
    lines.push(
      `${formatCount(done.length, "thing")} ${done.length === 1 ? "is" : "are"} already handled. You can stop thinking about ${done.length === 1 ? "it" : "them"}.`,
    );
  }

  if (notUrgentCount > 0) {
    lines.push(`${formatCount(notUrgentCount, "thing")} ${notUrgentCount === 1 ? "is" : "are"} not urgent.`);
  }

  if (needsYou.length === 0 && waiting.length === 0 && notUrgentCount === 0) {
    lines.push("You're clear for tonight.");
  }

  return { headline, lines };
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

function isUrgentTask(task: Task, now: Date): boolean {
  if (task.status === "cancelled") return true;
  return task.type === "reminder" && isReminderOverdue(task.due_at, now);
}

function isNotUrgentTask(
  task: Task,
  needsYou: Task[],
  waiting: Task[],
  done: Task[],
): boolean {
  if (needsYou.some((item) => item.id === task.id)) return false;
  if (waiting.some((item) => item.id === task.id)) return false;
  if (done.some((item) => item.id === task.id)) return false;
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

function getDateValue(value: string | null): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function formatCount(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
