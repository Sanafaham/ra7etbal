import type { CalendarEvent } from "./calendar";
import { classifyCalendarEvent, formatEventTime } from "./calendar";
import { buildDailyBrief } from "./daily-brief";
import { derivePendingItems } from "./pending-items";
import { formatReminderDue, isReminderOverdue } from "./reminder-time";
import type { Task } from "../types/task";

export interface NightSweepItem {
  id: string;
  text: string;
}

export interface NightSweep {
  handledToday: NightSweepItem[];
  stillWaiting: NightSweepItem[];
  requiresYou: NightSweepItem[];
  upcomingDeadline: NightSweepItem[];
  reassurance: string;
}

export function buildNightSweep(
  tasks: Task[],
  now = new Date(),
  calendarEvents: CalendarEvent[] = [],
): NightSweep {
  const brief = buildDailyBrief(tasks, now);
  const pendingItems = derivePendingItems(tasks, now);
  const handledToday = brief.done.slice(0, 3).map((task) => ({
    id: task.id,
    text: buildHandledText(task),
  }));
  const waitingTasks = orderWaitingTasksFromPendingItems(
    pendingItems.map((item) => item.task),
    brief.waitingOnOthers,
  );
  const stillWaiting = waitingTasks.slice(0, 2).map((task) => ({
    id: task.id,
    text: buildWaitingText(task),
  }));
  const requiresYou = brief.needsAttention.slice(0, 1).map((task) => ({
    id: task.id,
    text: buildRequiresYouText(task, now),
  }));
  const upcomingDeadline = buildUpcomingDeadline(tasks, calendarEvents, now);

  return {
    handledToday,
    stillWaiting,
    requiresYou,
    upcomingDeadline,
    reassurance: buildReassurance({
      handledCount: handledToday.length,
      waitingCount: stillWaiting.length,
      requiresCount: requiresYou.length,
      deadlineCount: upcomingDeadline.length,
      hasOverdue: pendingItems.some(
        (item) => item.task.type === "reminder" && isReminderOverdue(item.task.due_at, now),
      ),
    }),
  };
}

function orderWaitingTasksFromPendingItems(
  pendingTasks: Task[],
  fallbackWaitingTasks: Task[],
): Task[] {
  const waitingIds = new Set(fallbackWaitingTasks.map((task) => task.id));
  const ordered = pendingTasks.filter((task) => waitingIds.has(task.id));
  const orderedIds = new Set(ordered.map((task) => task.id));
  return [
    ...ordered,
    ...fallbackWaitingTasks.filter((task) => !orderedIds.has(task.id)),
  ];
}

function buildUpcomingDeadline(
  tasks: Task[],
  calendarEvents: CalendarEvent[],
  now: Date,
): NightSweepItem[] {
  const upcomingReminder = tasks
    .filter((task) => task.archived_at == null)
    .filter((task) => task.status !== "done" && task.type === "reminder" && task.due_at)
    .filter((task) => {
      const due = new Date(task.due_at!);
      return !Number.isNaN(due.getTime()) && due > now;
    })
    .sort((a, b) => new Date(a.due_at!).getTime() - new Date(b.due_at!).getTime())[0];

  const upcomingCalendarEvent = calendarEvents
    .filter((event) => classifyCalendarEvent(event, now) === "upcoming")
    .filter((event) => {
      if (!event.start) return false;
      const start = event.allDay ? parseAllDayDate(event.start) : new Date(event.start);
      return start !== null && start > now;
    })
    .sort((a, b) => getCalendarStartValue(a) - getCalendarStartValue(b))[0];

  const reminderTime = upcomingReminder?.due_at
    ? new Date(upcomingReminder.due_at).getTime()
    : Number.POSITIVE_INFINITY;
  const calendarTime = upcomingCalendarEvent
    ? getCalendarStartValue(upcomingCalendarEvent)
    : Number.POSITIVE_INFINITY;

  if (reminderTime === Number.POSITIVE_INFINITY && calendarTime === Number.POSITIVE_INFINITY) {
    return [];
  }

  if (reminderTime <= calendarTime && upcomingReminder) {
    const dueLabel = formatReminderDue(upcomingReminder.due_at, now);
    return [
      {
        id: upcomingReminder.id,
        text: dueLabel
          ? `${briefDesc(upcomingReminder.description)} is ${formatDuePhrase(dueLabel)}.`
          : `${briefDesc(upcomingReminder.description)} is coming up.`,
      },
    ];
  }

  if (!upcomingCalendarEvent) return [];
  const eventTime = formatEventTime(upcomingCalendarEvent, now);
  return [
    {
      id: `calendar-${upcomingCalendarEvent.id}`,
      text: eventTime
        ? `${upcomingCalendarEvent.title} is ${eventTime}.`
        : `${upcomingCalendarEvent.title} is coming up.`,
    },
  ];
}

function buildHandledText(task: Task): string {
  const who = task.assigned_to?.trim();
  if (who && who.toLowerCase() !== "me") {
    return `${capitalize(who)} confirmed ${cleanForObject(task.description)}.`;
  }
  return `${briefDesc(task.description)} is handled.`;
}

function buildWaitingText(task: Task): string {
  const who = task.assigned_to?.trim();
  const what = cleanForObject(task.description);
  if (who && what) return `Waiting on ${capitalize(who)} to confirm ${what}.`;
  if (who) return `Waiting on ${capitalize(who)}.`;
  return "One item is waiting on someone.";
}

function buildRequiresYouText(task: Task, now: Date): string {
  const desc = briefDesc(task.description);
  if (task.type === "reminder" && task.due_at) {
    if (isReminderOverdue(task.due_at, now)) return `${desc} is overdue.`;
    const dueLabel = formatReminderDue(task.due_at, now);
    return dueLabel ? `${desc} is ${formatDuePhrase(dueLabel)}.` : `${desc} needs your attention.`;
  }
  return `${desc} needs your attention.`;
}

function buildReassurance(input: {
  handledCount: number;
  waitingCount: number;
  requiresCount: number;
  deadlineCount: number;
  hasOverdue: boolean;
}): string {
  if (input.hasOverdue || input.requiresCount > 0) {
    return "Everything else has an owner.";
  }
  if (input.waitingCount > 0 && input.deadlineCount === 0) {
    return "The rest is waiting on someone else.";
  }
  if (input.deadlineCount > 0) {
    return "Nothing else needs your attention tonight.";
  }
  if (input.handledCount > 0) {
    return "You can stop thinking about it tonight.";
  }
  return "Nothing urgent needs your attention tonight.";
}

function getCalendarStartValue(event: CalendarEvent): number {
  if (!event.start) return Number.POSITIVE_INFINITY;
  const start = event.allDay ? parseAllDayDate(event.start) : new Date(event.start);
  return start?.getTime() ?? Number.POSITIVE_INFINITY;
}

function parseAllDayDate(value: string): Date | null {
  const parts = value.split("-").map(Number);
  if (parts.length < 3 || parts.some(Number.isNaN)) return null;
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

function briefDesc(raw: string): string {
  const s = capitalize(raw.trim().replace(/[.!?]+$/, "").trim());
  return s.length > 52 ? `${s.slice(0, 52).trimEnd()}...` : s;
}

function cleanForObject(raw: string): string {
  const desc = briefDesc(raw);
  const cleaned = desc.replace(
    /^(Confirm|Ask|Tell|Remind|Have|Message|Send|Check|Follow up on|Follow up|Get)\s+/i,
    "",
  );
  return cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
}

function formatDuePhrase(label: string): string {
  if (label.startsWith("Due ")) return label.charAt(0).toLowerCase() + label.slice(1);
  return `due ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

function capitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}
