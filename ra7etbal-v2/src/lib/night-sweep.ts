import type { CalendarEvent } from "./calendar";
import { classifyCalendarEvent, formatEventTime } from "./calendar";
import { buildDailyBrief } from "./daily-brief";
import { derivePendingItems } from "./pending-items";
import { formatReminderDue, isReminderOverdue } from "./reminder-time";
import type { Task } from "../types/task";
import type { AutomationDigest } from "./automation-context";
import { formatAutomationForNight } from "./automation-context";
import { taskLabel, buildCompletionPhrase, isMaterialWaitingItem } from "./morning-brief";
import type { OpenStaffEscalation } from "../types/staff-message";
import { isQualityOwnerReviewStatus } from "./quality-lifecycle";

/** Hour (0–23) at which Night Sweep replaces Today's Snapshot. */
export const EVENING_HOUR = 20;

/**
 * Hour (0–23) before which a new calendar day is still treated as a
 * continuation of the prior Night Sweep for Carson's spoken opening line —
 * Morning Brief does not become eligible until this hour. Prevents a
 * post-midnight session (e.g. 1 AM) from being classified as the day's
 * first Morning Brief. Consumed by App.tsx's isNightSweep classification
 * and carson-material-items.ts's resolveBriefAnchorDateStr.
 */
export const MORNING_START_HOUR = 6;

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
  /** true when used as daytime "Today's Snapshot", false when evening Night Sweep */
  isSnapshot: boolean;
}

export function buildNightSweep(
  tasks: Task[],
  now = new Date(),
  calendarEvents: CalendarEvent[] = [],
): NightSweep {
  const isSnapshot = now.getHours() < EVENING_HOUR;

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

  // "All Clear" is genuine only when nothing is unresolved:
  // no waiting, no requires-you, no upcoming deadline with mental load.
  const hasUnresolvedLoad =
    stillWaiting.length > 0 ||
    requiresYou.length > 0 ||
    upcomingDeadline.some((i) => i.canMarkDone); // task deadlines carry load; calendar-only don't

  return {
    handledToday,
    stillWaiting,
    requiresYou,
    upcomingDeadline,
    openLoopCount,
    badgeLabel: buildBadgeLabel(openLoopCount, hasUnresolvedLoad),
    reassurance: buildReassurance({
      waitingCount: waitingTasks.length,
      requiresCount: requiresYou.length,
      hasOverdue: pendingItems.some(
        (item) => item.task.type === "reminder" && isReminderOverdue(item.task.due_at, now),
      ),
      hasUnresolvedLoad,
      isSnapshot,
    }),
    isSnapshot,
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

/**
 * Upcoming section priority order:
 *   1. Task deadlines (reminders with due_at)
 *   2. Pending waiting items (delegations / follow-ups)
 *   3. Unresolved decisions
 *   4. Imminent calendar events (≤24h away) or ones requiring preparation
 *
 * Routine calendar events further out are excluded — they don't add mental load tonight.
 */
function buildUpcomingDeadline(
  tasks: Task[],
  calendarEvents: CalendarEvent[],
  now: Date,
): NightSweepItem[] {
  const unarchived = tasks.filter((t) => t.archived_at == null && t.status !== "done");

  // 1. Soonest task deadline
  const upcomingReminder = unarchived
    .filter((t) => t.type === "reminder" && t.due_at)
    .filter((t) => {
      const due = new Date(t.due_at!);
      return !Number.isNaN(due.getTime()) && due > now;
    })
    .sort((a, b) => new Date(a.due_at!).getTime() - new Date(b.due_at!).getTime())[0];

  if (upcomingReminder) {
    const dueLabel = formatReminderDue(upcomingReminder.due_at, now);
    return [
      {
        id: upcomingReminder.id,
        text: buildDeadlineSentence(briefDesc(upcomingReminder.description), dueLabel),
        canMarkDone: true,
      },
    ];
  }

  // 2. Soonest stale delegation / follow-up (unresolved mental load)
  const staleDelegation = unarchived
    .filter((t) => t.type === "delegation" || t.type === "followup")
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())[0];

  if (staleDelegation) {
    return [
      {
        id: staleDelegation.id,
        text: buildWaitingText(staleDelegation),
        canMarkDone: true,
      },
    ];
  }

  // 3. Unresolved decision
  const decision = unarchived
    .filter((t) => t.type === "decision")
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())[0];

  if (decision) {
    return [
      {
        id: decision.id,
        text: `${briefDesc(decision.description)} still needs a decision.`,
        canMarkDone: true,
      },
    ];
  }

  // 4. Calendar events — only if imminent (≤24h) or require preparation
  const imminentOrPrepEvent = calendarEvents
    .filter((ev) => classifyCalendarEvent(ev, now) === "upcoming")
    .filter((ev) => {
      if (!ev.start) return false;
      const start = ev.allDay ? parseAllDayDate(ev.start) : new Date(ev.start);
      if (!start || start <= now) return false;
      const hoursUntil = (start.getTime() - now.getTime()) / 3_600_000;
      const isImminent = hoursUntil <= 24;
      const requiresPrep = PREP_KEYWORDS.some((kw) =>
        ev.title?.toLowerCase().includes(kw),
      );
      return isImminent || requiresPrep;
    })
    .sort((a, b) => getCalendarStartValue(a) - getCalendarStartValue(b))[0];

  if (!imminentOrPrepEvent) return [];

  const eventTime = formatUpcomingEventTime(imminentOrPrepEvent, now);
  return [
    {
      id: `calendar-${imminentOrPrepEvent.id}`,
      text: eventTime
        ? `${imminentOrPrepEvent.title} ${eventTime}.`
        : `${imminentOrPrepEvent.title} is coming up.`,
      // calendar items can't be marked done from here
    },
  ];
}

/** Calendar event titles/descriptions containing these words imply preparation needed. */
const PREP_KEYWORDS = [
  "meeting", "interview", "presentation", "review", "call", "appointment",
  "dinner", "lunch", "guest", "visit", "flight", "travel", "trip",
  "surgery", "checkup", "exam",
];

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
    return buildDeadlineSentence(desc, dueLabel);
  }
  return `${desc} needs your attention.`;
}

function buildReassurance(input: {
  waitingCount: number;
  requiresCount: number;
  hasOverdue: boolean;
  hasUnresolvedLoad: boolean;
  isSnapshot: boolean;
}): string {
  if (input.hasOverdue || input.requiresCount > 0) {
    return input.isSnapshot
      ? "One item still needs your attention today."
      : "Nothing urgent is at risk tonight. We'll pick up the rest tomorrow.";
  }
  if (input.waitingCount > 0) {
    return input.isSnapshot
      ? "Everything has an owner. Check in later."
      : "Everything important is being tracked. I'll keep an eye on the remaining open loops.";
  }
  // Only show "All Clear" when there is genuinely no unresolved mental load
  if (!input.hasUnresolvedLoad) {
    return input.isSnapshot
      ? "Nothing urgent right now. Enjoy your day."
      : "Everything delegated has an owner. You can stop thinking about it tonight.";
  }
  return input.isSnapshot
    ? "A few things are still in motion."
    : "A few things are still in motion. We'll follow up tomorrow.";
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

/**
 * Builds a natural deadline sentence from a task description and a dueLabel
 * produced by formatReminderDue().
 *
 * formatReminderDue() returns:
 *   "Due in N minutes/hours"  — still some time today
 *   "Due today at H:MM AM/PM" — today with time
 *   "Tomorrow at H:MM AM/PM"  — tomorrow (no "Due" prefix)
 *   "Friday at H:MM AM/PM"    — weekday (no "Due" prefix)
 *   "Jun 20 at H:MM AM/PM"    — date (no "Due" prefix)
 *
 * Desired output examples:
 *   "Call Angela tomorrow at 5:00 PM."   ← not "is due tomorrow"
 *   "Pay internet bill by Friday."        ← not "is due Friday"
 *   "Passport renewal is due in 10 days." ← keep "is due" for abstract intervals
 *   "Call Angela today at 9:00 AM."       ← not "is due today"
 */
function buildDeadlineSentence(desc: string, dueLabel: string | null): string {
  if (!dueLabel) return `${desc} is coming up.`;

  // "Due today at H:MM" → "X today at H:MM."
  const todayAt = dueLabel.match(/^Due today at (.+)$/i);
  if (todayAt) return `${desc} today at ${todayAt[1]}.`;

  // "Due in N minutes/hours/days" → "X is due in N …."
  if (/^Due in /i.test(dueLabel)) {
    return `${desc} is due ${dueLabel.replace(/^Due /i, "").toLowerCase()}.`;
  }

  // "Tomorrow at H:MM" → "X tomorrow at H:MM."
  const tomorrowAt = dueLabel.match(/^Tomorrow at (.+)$/i);
  if (tomorrowAt) return `${desc} tomorrow at ${tomorrowAt[1]}.`;

  // "Weekday at H:MM" (e.g. "Friday at 5:00 PM") → "X by Friday at H:MM."
  // But if there is a time component, "by Friday at 5 PM" reads fine.
  const weekdayAt = dueLabel.match(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) at (.+)$/i);
  if (weekdayAt) return `${desc} by ${weekdayAt[1]} at ${weekdayAt[2]}.`;

  // "Weekday" alone with no time → "X by Weekday."
  const weekdayOnly = dueLabel.match(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/i);
  if (weekdayOnly) return `${desc} by ${weekdayOnly[1]}.`;

  // "Jun 20 at H:MM" or any date string → "X is due Jun 20 at H:MM."
  const dateAt = dueLabel.match(/^(.+) at (.+)$/);
  if (dateAt) return `${desc} is due ${dateAt[1].toLowerCase()} at ${dateAt[2]}.`;

  // Fallback
  return `${desc} is due ${dueLabel.toLowerCase()}.`;
}

function formatUpcomingEventTime(event: CalendarEvent, now: Date): string {
  const label = formatEventTime(event, now);
  if (!label) return "";
  if (label.startsWith("Today ")) return `at ${label.replace(/^Today\s+/i, "")}`;
  if (label.startsWith("Tomorrow ")) return `tomorrow at ${label.replace(/^Tomorrow\s+/i, "")}`;
  if (label === "All day") return "all day";
  return label.charAt(0).toLowerCase() + label.slice(1);
}

function buildBadgeLabel(openLoopCount: number, hasUnresolvedLoad: boolean): string {
  if (openLoopCount === 0 && !hasUnresolvedLoad) return "All clear";
  return `${openLoopCount} open loop${openLoopCount === 1 ? "" : "s"}`;
}

function capitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers for buildNightSweepSpoken — duplicated from morning-brief.ts
// to avoid a cross-module dependency on unexported symbols. Keep in sync if the
// label patterns change.
// ─────────────────────────────────────────────────────────────────────────────

// Task-label categorization is canonical in morning-brief.ts (taskLabel()) —
// no longer duplicated here. This is the fix for the "Clean the kitchen"
// bug that a duplicated, independently-drifting copy of these patterns
// allowed to slip through: Night Sweep now shares the exact same
// implementation Morning Brief uses, so a fix to one is a fix to both.

function nsCap(value: string | null | undefined): string {
  if (!value) return "";
  const v = value.trim();
  return v.charAt(0).toUpperCase() + v.slice(1);
}

function nsCapFirst(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function nsSpokenCount(n: number): string {
  const words = [
    "zero", "one", "two", "three", "four", "five",
    "six", "seven", "eight", "nine", "ten",
  ];
  return n < words.length ? words[n] : String(n);
}

function nsNightCompletionSentence(t: Task): string {
  const assignee = t.assigned_to?.trim() ?? "";
  const isSelfOrEmpty = !assignee || ["me", "myself", "self"].includes(assignee.toLowerCase());
  const phrase = buildCompletionPhrase(t.description);
  if (!isSelfOrEmpty) {
    if (!phrase.text) return `${nsCap(assignee)} confirmed an open item.`;
    return phrase.isGerund
      ? `${nsCap(assignee)} finished ${phrase.text}.`
      : `${nsCap(assignee)} confirmed the ${phrase.text}.`;
  }
  if (!phrase.text) return "One item was completed.";
  return phrase.isGerund ? `You finished ${phrase.text}.` : `The ${phrase.text} is done.`;
}

function nsEvLocalDate(ev: CalendarEvent): Date | null {
  if (!ev.start) return null;
  if (ev.allDay) {
    const parts = ev.start.split("-").map(Number);
    if (parts.length < 3) return null;
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }
  const d = new Date(ev.start);
  return Number.isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Night Sweep V1.4 — spoken end-of-day closure.
 *
 * Five sections, hard cap 5 sentences:
 *   1. GREETING              — "Good evening Sana."
 *   2. NOTABLE COMPLETION    — rolling 24h, named, self-assigned excluded
 *   3. OPEN LOOP             — top waiter, risk-framed when escalated/stale
 *   4. TOMORROW SIGNAL       — calendar shape or fused risk+calendar sentence
 *   5. CLOSE                 — "You can close the day." / "Everything else is set."
 *
 * Dedup rule: if section 3 names the risk and section 4 would repeat it,
 * section 4 is omitted and section 5 uses "That is the main thing to check."
 *
 * Note: App.tsx currently calls this without calendarEvents; section 4 will
 * be empty in the production widget until that call site is updated.
 */
export function buildNightSweepSpoken(
  tasks: Task[],
  displayName?: string | null,
  now?: Date,
  calendarEvents?: CalendarEvent[],
  automationDigest?: AutomationDigest,
  needsYou?: OpenStaffEscalation[],
): string {
  const _now     = now ?? new Date();
  const nowMs    = _now.getTime();
  const MS_DAY   = 24 * 60 * 60 * 1000;
  const _calEvs  = calendarEvents ?? [];
  const name     = displayName?.trim() || null;
  // This builder only ever runs for Night Sweep-kind sessions (App.tsx's
  // isNightSweep, spanning 20:00-05:59 per MORNING_START_HOUR) — the
  // greeting is always evening-appropriate, never re-derived from the raw
  // clock hour, which would otherwise say "Good morning" for a post-
  // midnight continuation. (This text is stripped and replaced by
  // carson-opening.ts's own briefKind-aware greeting before Carson speaks
  // it, but must not itself model a contradictory definition of "night".)
  const greeting = "Good evening";

  // ── S1: GREETING ────────────────────────────────────────────────────────────
  const section1 = name ? `${greeting} ${name}.` : `${greeting}.`;

  // ── S2: COMPLETIONS (rolling 24h, self-assigned excluded) ─────────────────
  const NS_SELF = new Set(["me", "myself", "self"]);
  const userLower = (name ?? "").toLowerCase();
  const recentCutoff = new Date(nowMs - MS_DAY);

  const recentDone = tasks
    .filter(t => {
      if (t.status !== "done" || !t.confirmed_at) return false;
      const ca = new Date(t.confirmed_at);
      if (ca < recentCutoff || ca > _now) return false;
      if (t.type === "delegation") {
        const a = (t.assigned_to ?? "").trim().toLowerCase();
        if (NS_SELF.has(a)) return false;
        if (userLower && a === userLower) return false;
      }
      return true;
    })
    .sort((a, b) => new Date(b.confirmed_at!).getTime() - new Date(a.confirmed_at!).getTime());

  let section2 = "";
  if (recentDone.length === 1) {
    section2 = nsNightCompletionSentence(recentDone[0]);
  } else if (recentDone.length >= 2) {
    const notable = recentDone.find(t => {
      const a = (t.assigned_to ?? "").trim().toLowerCase();
      return !!a && !NS_SELF.has(a) && a !== userLower &&
        (t.type === "delegation" || t.type === "followup");
    });
    const countWord = nsSpokenCount(recentDone.length);
    if (notable && nsCap(notable.assigned_to) && taskLabel(notable.description)) {
      section2 = `${nsCapFirst(countWord)} items were handled in the last 24 hours, including ${nsCap(notable.assigned_to)}'s ${taskLabel(notable.description)}.`;
    } else {
      section2 = `${nsCapFirst(countWord)} items were handled in the last 24 hours.`;
    }
  }

  // ── S3: OPEN LOOP ──────────────────────────────────────────────────────────
  const active = tasks.filter(t => t.archived_at == null && t.status === "pending");
  const waitingOn = active
    .filter(t => {
      if (t.type === "delegation" && t.assigned_to) return true;
      if (t.type === "followup") return true;
      if (t.needs_follow_up && t.assigned_to) return true;
      return false;
    })
    .sort((a, b) => {
      const aEsc = a.escalated_at != null ? 0 : 1;
      const bEsc = b.escalated_at != null ? 0 : 1;
      if (aEsc !== bEsc) return aEsc - bEsc;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });

  // Only briefing-worthy when it's materially useful right now — escalated,
  // requires an owner decision, or has an overdue/due-today deadline. Age
  // alone is never sufficient (Chief-of-Staff contract). See
  // isMaterialWaitingItem()'s doc comment (morning-brief.ts) for the exact
  // signals used — shared with Morning Brief so both agree on what matters.
  const riskItem = waitingOn.find(t => isMaterialWaitingItem(t, _now)) ?? null;

  let section3 = "";
  if (riskItem) {
    const who  = nsCap(riskItem.assigned_to);
    const what = taskLabel(riskItem.description);

    if (riskItem.escalated_at != null) {
      section3 = who && what
        ? `${who} still hasn't confirmed the ${what}.`
        : who ? `${who} hasn't responded to an open item.` : "One item hasn't received a response.";
    } else if (isQualityOwnerReviewStatus(riskItem.quality_review_status)) {
      section3 = who && what
        ? `${who}'s ${what} needs your review.`
        : "One item needs your review.";
    } else {
      section3 = who && what
        ? `${who} needs to confirm the ${what} today.`
        : "One item needs confirmation today.";
    }
  }

  // ── NEEDS YOU — genuine owner decisions (distinct from Waiting On Others) ─
  let sectionNeedsYou = "";
  if (needsYou && needsYou.length === 1) {
    sectionNeedsYou = `One decision needs you — ${nsCap(needsYou[0].staffName)} is waiting on an answer.`;
  } else if (needsYou && needsYou.length > 1) {
    sectionNeedsYou = `${nsCapFirst(nsSpokenCount(needsYou.length))} decisions need you — starting with ${nsCap(needsYou[0].staffName)}.`;
  }

  // ── S4: TOMORROW SIGNAL ────────────────────────────────────────────────────
  // Fuse risk+calendar when both are present — but never repeat what S3 said.
  // If S3 already named the risk and there are tomorrow events, skip the fused
  // sentence (would be redundant) and let S5 reference "tomorrow" instead.
  const todayStart    = new Date(_now.getFullYear(), _now.getMonth(), _now.getDate());
  const tomorrowStart = new Date(todayStart.getTime() + MS_DAY);
  const dayAfterStart = new Date(tomorrowStart.getTime() + MS_DAY);

  const tomorrowEvs = _calEvs.filter(ev => {
    const d = nsEvLocalDate(ev);
    return d !== null && d >= tomorrowStart && d < dayAfterStart;
  });

  let section4 = "";
  // Only fuse when S3 is empty (risk not yet named) AND we have both a risk + tomorrow event.
  // If S3 named the risk, adding a fused S4 would duplicate it.
  const riskAlreadyNamed = riskItem != null && section3.length > 0;
  if (!riskAlreadyNamed && riskItem && tomorrowEvs.length > 0) {
    const ev   = tomorrowEvs[0];
    const what = taskLabel(riskItem.description);
    section4 = what
      ? `${ev.title} is tomorrow and the ${what} is still open.`
      : `${ev.title} is tomorrow and one item is still unconfirmed.`;
  } else if (tomorrowEvs.length === 1) {
    section4 = `You have one event tomorrow — ${tomorrowEvs[0].title}.`;
  } else if (tomorrowEvs.length > 1) {
    section4 = `You have ${nsSpokenCount(tomorrowEvs.length)} events tomorrow.`;
  }

  // ── S5: CLOSE ──────────────────────────────────────────────────────────────
  const riskFusedInS4 = !riskAlreadyNamed && riskItem != null && section4.length > 0;
  const totalWaiting = waitingOn.length;

  let section5: string;
  if (sectionNeedsYou) {
    section5 = "That decision is the main thing before you're done for tonight.";
  } else if (totalWaiting === 0) {
    section5 = "You can close the day.";
  } else if (riskFusedInS4) {
    section5 = "That is the main thing to check before tomorrow.";
  } else if (riskItem != null) {
    // Risk was named in S3; S4 may have calendar shape (not fused risk).
    section5 = tomorrowEvs.length > 0
      ? "That is the main thing to check before tomorrow."
      : "Everything else is set.";
  } else {
    // Fresh waiters but no stale/escalated risk.
    section5 = "Everything else is set.";
  }

  // ── Automation signal (appended only when there is room) ──────────────────
  // Not a guaranteed slot — formatAutomationForNight() returns "" for
  // routine automation state (a recurring reminder simply having been sent
  // but not yet confirmed is not, by itself, briefing-worthy). Only
  // surfaces when the main body has room.
  const automationSentence = automationDigest
    ? formatAutomationForNight(automationDigest)
    : "";

  // ── ASSEMBLE ───────────────────────────────────────────────────────────────
  // A genuine owner-decision item is never silently cut for space — the
  // ceiling flexes by one only when Needs You is present, matching every
  // other tested case (no Needs You) byte-for-byte.
  const maxCore = sectionNeedsYou ? 6 : 5;
  const coreSentences = [section1, sectionNeedsYou, section2, section3, section4, section5].filter(Boolean);
  const allSentences =
    automationSentence && coreSentences.length < maxCore
      ? [...coreSentences, automationSentence]
      : coreSentences;

  return allSentences.slice(0, maxCore).join(" ");
}
