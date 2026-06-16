import type { CalendarEvent } from "./calendar";
import { classifyCalendarEvent, formatEventTime } from "./calendar";
import { buildDailyBrief } from "./daily-brief";
import { derivePendingItems } from "./pending-items";
import { formatReminderDue, isReminderOverdue } from "./reminder-time";
import type { Task } from "../types/task";

export interface NightSweepItem {
  id: string;
  text: string;
  canMarkDone?: boolean;
}

export interface NightSweep {
  handledToday: NightSweepItem[];
  stillWaiting: NightSweepItem[];
  requiresYou: NightSweepItem[];
  upcomingDeadline: NightSweepItem[];
  reassurance: string;
  openLoopCount: number;
  badgeLabel: string;
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
    canMarkDone: true,
  }));
  const requiresYou = brief.needsAttention.slice(0, 1).map((task) => ({
    id: task.id,
    text: buildRequiresYouText(task, now),
    canMarkDone: true,
  }));
  const upcomingDeadline = buildUpcomingDeadline(tasks, calendarEvents, now);
  const openLoopCount = waitingTasks.length;

  return {
    handledToday,
    stillWaiting,
    requiresYou,
    upcomingDeadline,
    openLoopCount,
    badgeLabel: buildBadgeLabel(openLoopCount),
    reassurance: buildReassurance({
      waitingCount: waitingTasks.length,
      requiresCount: requiresYou.length,
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
        canMarkDone: true,
      },
    ];
  }

  if (!upcomingCalendarEvent) return [];
  const eventTime = formatUpcomingEventTime(upcomingCalendarEvent, now);
  return [
    {
      id: `calendar-${upcomingCalendarEvent.id}`,
      text: eventTime
        ? `${upcomingCalendarEvent.title} ${eventTime}.`
        : `${upcomingCalendarEvent.title} is coming up.`,
    },
  ];
}

function buildHandledText(task: Task): string {
  const who = task.assigned_to?.trim();
  if (who && who.toLowerCase() !== "me") {
    return `${capitalize(who)} confirmed ${cleanCompletedObject(task.description, who)}.`;
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
  waitingCount: number;
  requiresCount: number;
  hasOverdue: boolean;
}): string {
  if (input.hasOverdue || input.requiresCount > 0) {
    return "Nothing urgent is at risk tonight. We'll pick up the rest tomorrow.";
  }
  if (input.waitingCount > 0) {
    return "Everything important is being tracked. I'll keep an eye on the remaining open loops.";
  }
  return "Everything delegated has an owner. Nothing urgent needs your attention tonight.";
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

function cleanCompletedObject(raw: string, who: string): string {
  const desc = briefDesc(raw);
  const clause = normalizeCompletedClause(desc);
  const lower = clause.toLowerCase();
  const pronoun = subjectPronounForName(who);

  if (isResolvedClause(clause)) return withLeadingArticleForResolvedClause(clause);
  if (/^buy\s+/.test(lower)) return `${pronoun} bought ${clause.replace(/^buy\s+/i, "")}`;
  if (/^order\s+/.test(lower)) return `${withLeadingThe(clause.replace(/^order\s+/i, ""))} were ordered`;
  if (/^pay\s+/.test(lower)) return `${withLeadingThe(clause.replace(/^pay\s+/i, ""))} was paid`;
  if (/^book\s+/.test(lower)) return `${withLeadingThe(clause.replace(/^book\s+/i, ""))} is booked`;
  if (/^schedule\s+/.test(lower)) return `${withLeadingThe(clause.replace(/^schedule\s+/i, ""))} is scheduled`;
  if (/^check\s+/.test(lower)) return `${withLeadingThe(clause.replace(/^check\s+/i, ""))} was checked`;
  if (/^send\s+/.test(lower)) return `${withLeadingThe(clause.replace(/^send\s+/i, ""))} was sent`;

  return cleanForObject(clause);
}

function normalizeCompletedClause(value: string): string {
  return value
    .replace(/^(Confirm|Check|Verify|Find out|Find|See|Make sure)\s+/i, "")
    .replace(/^(if|whether|that)\s+/i, "")
    .trim();
}

function isResolvedClause(value: string): boolean {
  return /\b(is|are|was|were|has been|have been)\b/i.test(value);
}

function withLeadingArticleForResolvedClause(value: string): string {
  const cleaned = value.trim();
  if (!cleaned) return cleaned;
  if (/^(the|a|an|my|your|his|her|their|our)\s+/i.test(cleaned)) {
    return cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
  }
  return `the ${cleaned.charAt(0).toLowerCase()}${cleaned.slice(1)}`;
}

function subjectPronounForName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (["nasira", "grace", "loulya", "jewel", "dina", "angela"].includes(normalized)) {
    return "she";
  }
  if (["ghulam", "suresh", "saeed", "christopher"].includes(normalized)) {
    return "he";
  }
  return "they";
}

function withLeadingThe(value: string): string {
  const cleaned = value.trim();
  if (!cleaned) return cleaned;
  if (/^(the|a|an|my|your|his|her|their|our)\s+/i.test(cleaned)) {
    return cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
  }
  return `the ${cleaned.charAt(0).toLowerCase()}${cleaned.slice(1)}`;
}

function formatDuePhrase(label: string): string {
  if (label.startsWith("Due ")) return label.charAt(0).toLowerCase() + label.slice(1);
  return `due ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

function formatUpcomingEventTime(event: CalendarEvent, now: Date): string {
  const label = formatEventTime(event, now);
  if (!label) return "";
  if (label.startsWith("Today ")) return `at ${label.replace(/^Today\s+/i, "")}`;
  if (label.startsWith("Tomorrow ")) return `tomorrow at ${label.replace(/^Tomorrow\s+/i, "")}`;
  if (label === "All day") return "all day";
  return label.charAt(0).toLowerCase() + label.slice(1);
}

function buildBadgeLabel(openLoopCount: number): string {
  if (openLoopCount === 0) return "All clear";
  return `${openLoopCount} open loop${openLoopCount === 1 ? "" : "s"}`;
}

function capitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Converts a NightSweep structured object into a spoken brief string
 * suitable for the ElevenLabs voice agent.
 */
export function buildNightSweepSpoken(
  tasks: Task[],
  displayName?: string | null,
  now?: Date,
  calendarEvents?: CalendarEvent[],
): string {
  const sweep = buildNightSweep(tasks, now ?? new Date(), calendarEvents ?? []);
  const greeting = displayName ? `Here's your night sweep, ${displayName}.` : "Here's your night sweep.";
  const parts: string[] = [greeting];

  if (sweep.handledToday.length > 0) {
    parts.push(`Handled today: ${sweep.handledToday.map((i) => i.text).join(". ")}.`);
  }
  if (sweep.stillWaiting.length > 0) {
    parts.push(`Still waiting: ${sweep.stillWaiting.map((i) => i.text).join(". ")}.`);
  }
  if (sweep.requiresYou.length > 0) {
    parts.push(`Requires you: ${sweep.requiresYou.map((i) => i.text).join(". ")}.`);
  }
  if (sweep.upcomingDeadline.length > 0) {
    parts.push(`Coming up: ${sweep.upcomingDeadline.map((i) => i.text).join(". ")}.`);
  }
  parts.push(sweep.reassurance);
  return parts.join(" ");
}
