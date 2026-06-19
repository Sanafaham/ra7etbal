/**
 * Morning Brief V2
 *
 * Produces a Chief-of-Staff briefing from live task data.
 *
 * Five sections:
 *   1. Needs Your Attention  — owner-action items + reminders due today
 *   2. Waiting On            — active delegations awaiting confirmation
 *   3. Overdue Items         — overdue reminders + escalated pending delegations
 *   4. Recent Completions    — confirmed done within the last 24 hours
 *   5. Risks & Bottlenecks   — long-pending tasks, repeat-person backlog
 *
 * Architecture note:
 *   This module owns morning briefing only. It does NOT replace buildDailyBrief
 *   (used by the Actions screen) or buildCarsonSpokenBrief (kept as fallback).
 *   Home.tsx uses buildMorningBriefSpoken() as the spokenBrief prop passed to
 *   ElevenLabsAgentWidget and TextCarsonPanel.
 */

import { isReminderOverdue, formatReminderDue } from "./reminder-time";
import type { Task } from "../types/task";
import type { Person } from "../types/person";
import type { CalendarEvent } from "./calendar";
import { classifyCalendarEvent, formatEventEndTime } from "./calendar";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MorningBriefData {
  /** Owner-action items: pending personal tasks + reminders due today. */
  needsAttention: Task[];
  /**
   * Active delegations / followups awaiting confirmation — including escalated.
   * Escalated tasks are sorted first so highest-risk items surface earliest.
   */
  waitingOn: Task[];
  /** Overdue reminders only (escalated delegations stay in waitingOn). */
  overdueItems: Task[];
  /** Tasks confirmed done since start of today (local midnight). */
  recentCompletions: Task[];
  /** Risk signals: long-pending tasks, per-person backlog. */
  risks: RiskItem[];
}

export interface RiskItem {
  task: Task;
  /** Human-readable reason surfaced in the spoken brief. */
  reason: string;
}

// ---------------------------------------------------------------------------
// buildMorningBrief — structured data
// ---------------------------------------------------------------------------

export function buildMorningBrief(
  tasks: Task[],
  _people: Person[],
  now = new Date(),
): MorningBriefData {
  const active = tasks.filter((t) => t.archived_at == null);
  const nowMs = now.getTime();

  // ── 3. Overdue items ─────────────────────────────────────────────────────
  // Overdue reminders only. Escalated delegations remain in waitingOn so they
  // are visible to the spoken brief sections that read waitingOn.
  const overdueItems = active.filter((t) => {
    if (t.status !== "pending") return false;
    if (t.type === "reminder" && isReminderOverdue(t.due_at, now)) return true;
    return false;
  });
  const overdueIds = new Set(overdueItems.map((t) => t.id));

  // ── 2. Waiting on others ─────────────────────────────────────────────────
  // All pending delegations/followups including escalated ones.
  // Escalated items sort first so highest-risk surfaces earliest.
  const waitingOn = active
    .filter((t) => {
      if (t.status !== "pending") return false;
      if (overdueIds.has(t.id)) return false;
      if (t.type === "delegation" && t.assigned_to) return true;
      if (t.type === "followup") return true;
      if (t.needs_follow_up && t.assigned_to) return true;
      return false;
    })
    .sort((a, b) => {
      // Escalated first, then oldest-created first
      const aEsc = a.escalated_at != null ? 0 : 1;
      const bEsc = b.escalated_at != null ? 0 : 1;
      if (aEsc !== bEsc) return aEsc - bEsc;
      return getDateValue(a.created_at) - getDateValue(b.created_at);
    });
  const waitingIds = new Set(waitingOn.map((t) => t.id));

  // ── 1. Needs your attention ──────────────────────────────────────────────
  // Owner tasks (unassigned or assigned to "me") + reminders due today.
  const needsAttention = active.filter((t) => {
    if (t.status !== "pending") return false;
    if (overdueIds.has(t.id)) return false;
    if (waitingIds.has(t.id)) return false;

    // Reminder due today (not yet overdue)
    if (t.type === "reminder" && t.due_at) {
      const due = new Date(t.due_at);
      return !isReminderOverdue(t.due_at, now) && isSameLocalDay(due, now);
    }

    // Personal / owner task
    const assignee = t.assigned_to?.trim().toLowerCase();
    return !assignee || assignee === "me";
  });

  // ── 4. Recent completions (since start of today, local time) ─────────────
  const todayCutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const recentCompletions = tasks
    .filter((t) => {
      if (t.status !== "done" || !t.confirmed_at) return false;
      const confirmedAt = new Date(t.confirmed_at);
      return confirmedAt >= todayCutoff && confirmedAt <= now;
    })
    .sort(
      (a, b) =>
        new Date(b.confirmed_at!).getTime() - new Date(a.confirmed_at!).getTime(),
    );

  // ── 5. Risks & bottlenecks ───────────────────────────────────────────────
  const risks = buildRisks(waitingOn, nowMs);

  return { needsAttention, waitingOn, overdueItems, recentCompletions, risks };
}

function buildRisks(waitingOn: Task[], nowMs: number): RiskItem[] {
  const risks: RiskItem[] = [];
  const MS_48H = 48 * 60 * 60 * 1000;
  const MS_72H = 72 * 60 * 60 * 1000;

  // Count tasks per person to detect bottlenecks
  const perPerson = new Map<string, Task[]>();
  for (const t of waitingOn) {
    const name = t.assigned_to?.trim();
    if (!name) continue;
    const bucket = perPerson.get(name) ?? [];
    bucket.push(t);
    perPerson.set(name, bucket);
  }

  // Bottleneck: one person has 3+ pending tasks
  const bottleneckNames = new Set<string>();
  for (const [name, tasks] of perPerson.entries()) {
    if (tasks.length >= 3) {
      bottleneckNames.add(name);
      risks.push({
        task: tasks[0],
        reason: `${tasks.length} tasks waiting on ${name}`,
      });
    }
  }

  // Long-pending: 72 h+ (not already flagged as bottleneck)
  for (const t of waitingOn) {
    const name = t.assigned_to?.trim() ?? "";
    if (bottleneckNames.has(name)) continue;
    const pendingMs = nowMs - new Date(t.created_at).getTime();
    if (pendingMs >= MS_72H) {
      const days = Math.floor(pendingMs / (24 * 60 * 60 * 1000));
      risks.push({ task: t, reason: `pending for ${days} day${days === 1 ? "" : "s"}` });
    } else if (pendingMs >= MS_48H) {
      risks.push({ task: t, reason: "pending for over 2 days" });
    }
  }

  // De-duplicate: keep at most 3 risk items to avoid overwhelming the brief
  return risks.slice(0, 3);
}

// ---------------------------------------------------------------------------
// buildMorningBriefSpoken — Morning Brief V3
// ---------------------------------------------------------------------------

/**
 * Morning Brief V3 — Chief of Staff briefing.
 *
 * Five sections, hard cap 6 sentences total.
 * Not a task list. Not a dashboard. A calm, named, specific status read.
 *
 *   1. GREETING + DAY SHAPE    — always present; event count or clear calendar
 *   2. RECENT COMPLETIONS      — named, last 18 h; max 2 or summary
 *   3. WAITING ON OTHERS       — named, max 2, with staleness when useful
 *   4. ONE TIME-PRESSURE ITEM  — overdue > today reminder > prep event > busy day
 *   5. STATUS CLOSE            — always present; all-clear OR single named risk
 *
 * Called from App.tsx as `daily_brief` ElevenLabs dynamic variable.
 */
export function buildMorningBriefSpoken(
  tasks: Task[],
  people: Person[],
  displayName?: string | null,
  now = new Date(),
  calendarEvents?: CalendarEvent[],
): string {
  const brief  = buildMorningBrief(tasks, people, now);
  const name   = displayName?.trim() || null;
  const hour   = now.getHours();
  const nowMs  = now.getTime();
  const greeting =
    hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  // ── Calendar setup ─────────────────────────────────────────────────────────
  const calEvents  = calendarEvents ?? [];
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomStart   = new Date(todayStart.getTime() + 86_400_000);

  function evLocalDate(ev: CalendarEvent): Date | null {
    if (!ev.start) return null;
    if (ev.allDay) {
      const parts = ev.start.split("-").map(Number);
      if (parts.length < 3) return null;
      return new Date(parts[0], parts[1] - 1, parts[2]);
    }
    const d = new Date(ev.start);
    return Number.isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function evTime(ev: CalendarEvent): string {
    if (ev.allDay || !ev.start) return "";
    const d = new Date(ev.start);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  const todayEvs   = calEvents.filter(ev => { const d = evLocalDate(ev); return d !== null && d >= todayStart && d < tomStart; });
  const upcoming   = todayEvs.filter(ev => classifyCalendarEvent(ev, now) === "upcoming");
  const inProgress = todayEvs.filter(ev => classifyCalendarEvent(ev, now) === "in_progress");

  // ── SECTION 1: GREETING + DAY SHAPE ───────────────────────────────────────
  // Always present. One sentence. Orients the user to their day.
  let section1: string;
  const namePrefix = name ? `${greeting} ${name}` : greeting;

  if (todayEvs.length === 0) {
    section1 = `${namePrefix} — your calendar is clear today.`;
  } else if (todayEvs.length === 1) {
    section1 = `${namePrefix} — you have one event on your calendar today.`;
  } else {
    section1 = `${namePrefix} — you have ${spokenCount(todayEvs.length)} events on your calendar today.`;
  }

  // ── SECTION 2: COMPLETIONS TODAY ──────────────────────────────────────────
  // Named and specific. Relief before burden.
  // Max 2 individual items; 3+ becomes a count summary.
  // Uses start-of-day boundary (local midnight) so copy is always "today".
  let section2 = "";
  const todayStartForBrief = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const recentDone = tasks
    .filter(t => {
      if (t.status !== "done" || !t.confirmed_at) return false;
      const confirmedAt = new Date(t.confirmed_at);
      return confirmedAt >= todayStartForBrief && confirmedAt <= now;
    })
    .sort((a, b) => new Date(b.confirmed_at!).getTime() - new Date(a.confirmed_at!).getTime());

  if (recentDone.length === 1) {
    section2 = buildCompletionSentenceV3(recentDone[0]);
  } else if (recentDone.length === 2) {
    section2 = `${buildCompletionSentenceV3(recentDone[0])} ${buildCompletionSentenceV3(recentDone[1])}`;
  } else if (recentDone.length >= 3) {
    section2 = `${spokenCount(recentDone.length)} items were completed today.`;
  }

  // ── SECTION 3: WAITING ON OTHERS ──────────────────────────────────────────
  // Named, max 2, staleness included when ≥ 2 days.
  let section3 = "";
  const waiting      = brief.waitingOn.slice(0, 2);
  const totalWaiting = brief.waitingOn.length;
  const MS_DAY       = 24 * 60 * 60 * 1000;

  if (waiting.length === 1) {
    const t     = waiting[0];
    const who   = cap(t.assigned_to);
    const what  = cleanDesc(t.description);
    const days  = Math.floor((nowMs - new Date(t.created_at).getTime()) / MS_DAY);
    const stale = days >= 2 ? ` — sent ${days} day${days === 1 ? "" : "s"} ago` : "";
    section3 = who && what
      ? `${who} still owes confirmation on ${what}${stale}.`
      : who
        ? `${who} still has an open item${stale}.`
        : "One item is still waiting on confirmation.";
  } else if (waiting.length >= 2) {
    const names = waiting.map(t => cap(t.assigned_to)).filter(Boolean);
    if (names.length === 2 && totalWaiting === 2) {
      section3 = `Two items are still waiting: ${names[0]} on ${cleanDesc(waiting[0].description)} and ${names[1]} on ${cleanDesc(waiting[1].description)}.`;
    } else if (names.length === 2 && totalWaiting > 2) {
      section3 = `${names[0]} and ${names[1]} are still waiting — and ${totalWaiting - 2} other${totalWaiting - 2 === 1 ? "" : "s"}.`;
    } else {
      section3 = `${spokenCount(totalWaiting)} items are still waiting on others.`;
    }
  }

  // ── Invisible deadline window (tomorrow → 14 days) ────────────────────────
  const tomorrowStart    = new Date(todayStart.getTime() + 86_400_000);
  const horizonEnd       = new Date(todayStart.getTime() + 14 * 86_400_000);
  const activePending    = tasks.filter(t => t.archived_at == null && t.status === "pending");
  const upcomingDeadline = activePending
    .filter(t => {
      if (!t.due_at) return false;
      if (t.type !== "reminder" && t.type !== "decision") return false;
      const due = new Date(t.due_at);
      return due >= tomorrowStart && due < horizonEnd;
    })
    .sort((a, b) => new Date(a.due_at!).getTime() - new Date(b.due_at!).getTime())[0] ?? null;

  // ── SECTION 4: ONE TIME-PRESSURE ITEM ─────────────────────────────────────
  // Priority: overdue reminder → today reminder → prep calendar event → 4+ busy day
  let section4 = "";

  const overdueReminder  = brief.overdueItems.find(t => t.type === "reminder");
  const todayReminder    = brief.needsAttention.find(
    t => t.type === "reminder" && t.due_at && !isReminderOverdue(t.due_at, now),
  );
  const prepEvent        = [...inProgress, ...upcoming].find(ev => classifyCalendarEvent(ev, now) !== "past");

  if (overdueReminder) {
    section4 = `One reminder is overdue: "${spokenDesc(overdueReminder.description)}."`;
  } else if (todayReminder) {
    const timeSuffix = spokenTimeSuffix(todayReminder.due_at, now);
    section4 = timeSuffix
      ? `One deadline needs attention: "${spokenDesc(todayReminder.description)}" ${timeSuffix}.`
      : `One item needs your attention today: "${spokenDesc(todayReminder.description)}."`;
  } else if (upcomingDeadline) {
    const dayCount = spokenDaysUntil(upcomingDeadline.due_at!, now);
    section4 = `One deadline is coming up: ${spokenDesc(upcomingDeadline.description)} — ${dayCount}.`;
  } else if (inProgress.length > 0) {
    const ev     = inProgress[0];
    const endStr = formatEventEndTime(ev);
    section4 = endStr
      ? `You're currently in ${ev.title}, wrapping up at ${endStr}.`
      : `You're currently in ${ev.title}.`;
  } else if (todayEvs.length >= 4) {
    section4 = `You have ${spokenCount(todayEvs.length)} things on your calendar today — it's a full day.`;
  } else if (prepEvent) {
    const t = evTime(prepEvent);
    section4 = t ? `${prepEvent.title} is at ${t}.` : "";
  }

  // ── SECTION 5: STATUS CLOSE ────────────────────────────────────────────────
  // Always present. Explicit all-clear OR honest status. Never fake all-clear.
  // Risk priority: escalated → stale 72h+ → overdue reminder → fresh waiting → clear
  let section5: string;
  const MS_72H = 72 * 60 * 60 * 1000;

  // Fix 1 makes escalated tasks visible in brief.waitingOn, so this check now works.
  const escalatedItem = brief.waitingOn.find(t => t.escalated_at != null);
  const stale72Item   = brief.waitingOn.find(
    t => nowMs - new Date(t.created_at).getTime() >= MS_72H,
  );

  if (escalatedItem) {
    const who  = cap(escalatedItem.assigned_to);
    const what = cleanDesc(escalatedItem.description);
    section5 = who && what
      ? `${who} hasn't responded to ${what} — worth a follow-up today.`
      : "One item has been escalated with no response — worth a follow-up today.";
  } else if (stale72Item) {
    const who  = cap(stale72Item.assigned_to);
    const days = Math.floor((nowMs - new Date(stale72Item.created_at).getTime()) / MS_DAY);
    const what = cleanDesc(stale72Item.description);
    section5 = who && what
      ? `The ${what} task has been open for ${days} days — worth a follow-up today.`
      : who
        ? `${who} has had an open item for ${days} days — worth a follow-up today.`
        : "One item has been open for several days — worth a follow-up today.";
  } else if (overdueReminder) {
    section5 = `One overdue reminder needs your attention before anything else.`;
  } else if (brief.waitingOn.length > 0) {
    // Items are waiting but none are stale or escalated — honest in-progress status.
    const n = brief.waitingOn.length;
    section5 = n === 1
      ? "One item is currently awaiting confirmation."
      : `${spokenCount(n)} items are currently awaiting confirmation.`;
  } else if (brief.needsAttention.length > 0) {
    section5 = "Nothing is blocked — your attention items are on track.";
  } else {
    section5 = "Nothing is waiting — your day is under control.";
  }

  // ── Assemble ───────────────────────────────────────────────────────────────
  // Hard cap: 6 sentences. Section 1 and 5 are always present.
  // Sections 2–4 are conditional; fill slots until cap is reached.
  const body = [section1, section2, section3, section4, section5]
    .filter(Boolean)
    .slice(0, 6)
    .join(" ");

  return body;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDateValue(value: string | null): number {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function cap(value: string | null | undefined): string | null {
  const s = value?.trim();
  if (!s) return null;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function spokenDesc(raw: string): string {
  const s = raw.trim().replace(/[.!?]+$/, "").trim();
  return s.length > 40 ? s.slice(0, 40).trimEnd() + "…" : s;
}

function cleanDesc(raw: string): string {
  const desc = spokenDesc(raw);
  const cleaned = desc.replace(
    /^(Confirm|Ask|Tell|Remind|Have|Message|Send|Check|Follow up on|Follow up|Get)\s+/i,
    "",
  );
  const result = cleaned === desc ? desc : cleaned;
  return result.charAt(0).toLowerCase() + result.slice(1);
}

function spokenCount(n: number): string {
  const words = [
    "zero", "one", "two", "three", "four", "five",
    "six", "seven", "eight", "nine", "ten",
  ];
  return n < words.length ? words[n] : String(n);
}

/**
 * Returns a spoken-friendly time suffix for a reminder, e.g. "at 9 AM",
 * "in 5 minutes", "tomorrow at 10 AM". Returns "" when no time is available.
 *
 * Strips ":00" from on-the-hour times (9:00 AM → 9 AM) for natural speech.
 * Strips the leading "Due today" prefix so it reads mid-sentence naturally.
 */
function spokenTimeSuffix(dueAt: string | null, now: Date): string {
  if (!dueAt) return "";
  const label = formatReminderDue(dueAt, now);
  if (!label) return "";

  let result = label;
  // "Due today at 9:00 AM" → "at 9:00 AM"
  result = result.replace(/^Due today\s+/, "");
  // "Due in X minutes/hours" → "in X minutes/hours"
  result = result.replace(/^Due\s+/, "");
  // "9:00 AM" → "9 AM", "10:00 AM" → "10 AM" (on-the-hour only)
  result = result.replace(/:00\s*(AM|PM)/gi, " $1");

  return result.trim();
}

/**
 * Returns a spoken day-count phrase for a future deadline, e.g. "in 9 days",
 * "tomorrow", "in 2 weeks". Never returns a calendar date — keeps the brief
 * feeling conversational and avoids invented reminder times.
 */
function spokenDaysUntil(dueAt: string, now: Date): string {
  const due        = new Date(dueAt);
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueMidnight   = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const days = Math.round((dueMidnight.getTime() - todayMidnight.getTime()) / 86_400_000);

  if (days <= 1) return "tomorrow";
  if (days === 7) return "in one week";
  if (days === 14) return "in two weeks";
  if (days % 7 === 0) return `in ${spokenCount(days / 7)} weeks`;
  return `in ${spokenCount(days)} day${days === 1 ? "" : "s"}`;
}

function buildCompletionSentenceV3(t: Task): string {
  const assignee = t.assigned_to?.trim() ?? "";
  const isDelegated =
    t.type === "delegation" ||
    t.type === "followup" ||
    (!!assignee && assignee.toLowerCase() !== "me");
  const what = cleanDesc(t.description);
  if (isDelegated && assignee) {
    return what
      ? `${cap(assignee)} confirmed ${what}.`
      : `${cap(assignee)} confirmed an open item.`;
  }
  return what ? `You completed ${what}.` : "One item was completed.";
}
