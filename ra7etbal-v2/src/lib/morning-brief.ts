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
import { isQualityOwnerReviewStatus } from "./quality-lifecycle";
import type { Task } from "../types/task";
import type { Person } from "../types/person";
import type { CalendarEvent } from "./calendar";
import { classifyCalendarEvent, formatEventEndTime } from "./calendar";
import type { AutomationDigest } from "./automation-context";
import { formatAutomationForMorning } from "./automation-context";

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
  // All pending delegations/followups including escalated ones, except items
  // awaiting the owner's own review/decision on a staff reply — those move
  // to Needs Attention instead (mirrors daily-brief.ts's isWaitingTask).
  // Escalated items sort first so highest-risk surfaces earliest.
  const waitingOn = active
    .filter((t) => {
      if (t.status !== "pending") return false;
      if (overdueIds.has(t.id)) return false;
      if (isQualityOwnerReviewStatus(t.quality_review_status)) return false;
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
  // Owner tasks (unassigned or assigned to "me") + reminders due today +
  // items awaiting the owner's own review/decision on a staff reply
  // (substitute_review, uncertain — a recent staff reply needs a decision).
  const needsAttention = active.filter((t) => {
    if (t.status !== "pending") return false;
    if (overdueIds.has(t.id)) return false;
    if (waitingIds.has(t.id)) return false;

    if (isQualityOwnerReviewStatus(t.quality_review_status)) return true;

    // Reminder due today (not yet overdue)
    if (t.type === "reminder" && t.due_at) {
      const due = new Date(t.due_at);
      return !isReminderOverdue(t.due_at, now) && isSameLocalDay(due, now);
    }

    // Personal / owner task
    const assignee = t.assigned_to?.trim().toLowerCase();
    return !assignee || assignee === "me";
  });

  // ── 4. Recent completions (rolling 24 h) ─────────────────────────────────
  // 24h rolling window so yesterday's confirmations always appear in morning.
  const recentCutoff = new Date(nowMs - 24 * 60 * 60 * 1000);
  const recentCompletions = tasks
    .filter((t) => {
      if (t.status !== "done" || !t.confirmed_at) return false;
      const confirmedAt = new Date(t.confirmed_at);
      return confirmedAt >= recentCutoff && confirmedAt <= now;
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
 * Morning Brief V3 — Executive operating briefing.
 *
 * Max 6 sentences. Priority for INCLUSION (drop lowest first when full):
 *   1. Urgent items requiring Sana's direct action
 *   2. Waiting on others
 *   3. Automation status (guaranteed slot — never dropped as afterthought)
 *   4. Calendar today
 *   5. Status close
 *   6. Recent completions (positive news — luxury slot, dropped first)
 *
 * SPEECH ORDER follows natural arc regardless of what got included:
 *   greeting → urgent → completions → waiting → calendar → automation → close
 *
 * todosCount/notesCount are optional counts (active to-dos, recent notes) —
 * mentioned only as a total in the close sentence, never individually named,
 * since neither has a dedicated slot in this brief.
 *
 * Called from App.tsx as `daily_brief` ElevenLabs dynamic variable.
 */
export function buildMorningBriefSpoken(
  tasks: Task[],
  people: Person[],
  displayName?: string | null,
  now = new Date(),
  calendarEvents?: CalendarEvent[],
  automationDigest?: AutomationDigest,
  todosCount = 0,
  notesCount = 0,
): string {
  const brief  = buildMorningBrief(tasks, people, now);
  const name   = displayName?.trim() || null;
  const hour   = now.getHours();
  const nowMs  = now.getTime();
  const MS_DAY = 24 * 60 * 60 * 1000;
  const MS_72H = 72 * 60 * 60 * 1000;
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
  const inProgress = todayEvs.filter(ev => classifyCalendarEvent(ev, now) === "in_progress");

  // ── URGENT — items requiring Sana's direct action ─────────────────────────
  // Priority: overdue reminders → personal reminders due today → personal tasks → upcoming deadline
  // All overdue reminders are counted (not just the first) so multiple
  // overdue items are never silently dropped from the brief.
  const overdueReminders = brief.overdueItems.filter(t => t.type === "reminder");
  const todayReminder   = brief.needsAttention.find(
    t => t.type === "reminder" && t.due_at && !isReminderOverdue(t.due_at, now),
  );
  const personalTasks   = brief.needsAttention.filter(t => t.type !== "reminder");
  const urgentCount     = overdueReminders.length + (todayReminder ? 1 : 0) + personalTasks.length;

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

  function overdueSentence(): string {
    if (overdueReminders.length === 1) {
      return `One reminder is overdue: ${spokenDesc(overdueReminders[0].description)}.`;
    }
    const titles = overdueReminders.slice(0, 2).map(t => spokenDesc(t.description));
    return `${capFirst(spokenCount(overdueReminders.length))} reminders are overdue: ${titles.join(", ")}.`;
  }

  let slotUrgent = "";
  if (urgentCount === 1) {
    if (overdueReminders.length === 1) {
      slotUrgent = overdueSentence();
    } else if (todayReminder) {
      const timeSuffix = spokenTimeSuffix(todayReminder.due_at, now);
      slotUrgent = timeSuffix
        ? `You have a reminder — ${spokenDesc(todayReminder.description)} ${timeSuffix}.`
        : `You have a reminder today — ${spokenDesc(todayReminder.description)}.`;
    } else {
      slotUrgent = `One task needs your attention: ${spokenDesc(personalTasks[0].description)}.`;
    }
  } else if (urgentCount > 1) {
    const leadIn = `${capFirst(spokenCount(urgentCount))} thing${urgentCount === 1 ? "" : "s"} need${urgentCount === 1 ? "s" : ""} attention today.`;
    slotUrgent = overdueReminders.length > 0 ? `${leadIn} ${overdueSentence()}` : leadIn;
  } else if (upcomingDeadline) {
    const dayCount = spokenDaysUntil(upcomingDeadline.due_at!, now);
    slotUrgent = `You have the ${spokenDesc(upcomingDeadline.description)} coming up ${dayCount}.`;
  }

  // ── COMPLETIONS (rolling 24 h) ────────────────────────────────────────────
  // Named and specific. Delegated confirmations get priority.
  let slotCompletions = "";
  const recentCutoff  = new Date(nowMs - 24 * 60 * 60 * 1000);
  const SELF_LABELS   = new Set(["me", "myself", "self"]);
  const userNameLower = (name ?? "").toLowerCase();
  const recentDone = tasks
    .filter(t => {
      if (t.status !== "done" || !t.confirmed_at) return false;
      const confirmedAt = new Date(t.confirmed_at);
      if (confirmedAt < recentCutoff || confirmedAt > now) return false;
      if (t.type === "delegation") {
        const a = (t.assigned_to ?? "").trim().toLowerCase();
        if (SELF_LABELS.has(a)) return false;
        if (userNameLower && a === userNameLower) return false;
      }
      return true;
    })
    .sort((a, b) => new Date(b.confirmed_at!).getTime() - new Date(a.confirmed_at!).getTime());

  if (recentDone.length === 1) {
    slotCompletions = buildCompletionSentenceV3(recentDone[0]);
  } else if (recentDone.length === 2) {
    slotCompletions = `${buildCompletionSentenceV3(recentDone[0])} ${buildCompletionSentenceV3(recentDone[1])}`;
  } else if (recentDone.length >= 3) {
    const notable = recentDone.find(t => {
      const a = t.assigned_to?.trim().toLowerCase();
      return !!a && a !== "me" && (t.type === "delegation" || t.type === "followup");
    });
    const rest = recentDone.length - 1;
    if (notable && cap(notable.assigned_to) && cleanDesc(notable.description)) {
      const lead = buildCompletionSentenceV3(notable);
      slotCompletions = rest > 0
        ? `${lead} ${capFirst(spokenCount(rest))} other item${rest === 1 ? " was" : "s were"} also completed.`
        : lead;
    } else {
      slotCompletions = `${capFirst(spokenCount(recentDone.length))} items were completed in the last 24 hours.`;
    }
  }

  // ── WAITING ON OTHERS ─────────────────────────────────────────────────────
  let slotWaiting = "";
  const totalWaiting  = brief.waitingOn.length;
  const escalatedItem = brief.waitingOn.find(t => t.escalated_at != null);
  const stale72Item   = brief.waitingOn.find(
    t => nowMs - new Date(t.created_at).getTime() >= MS_72H,
  );
  const topWaiter = escalatedItem ?? stale72Item ?? brief.waitingOn[0] ?? null;

  if (topWaiter) {
    const who   = cap(topWaiter.assigned_to);
    const what  = cleanDesc(topWaiter.description);
    const ageMs = nowMs - new Date(topWaiter.created_at).getTime();
    const days  = Math.floor(ageMs / MS_DAY);

    if (topWaiter.escalated_at != null) {
      slotWaiting = who && what
        ? `${who} still hasn't confirmed the ${what}.`
        : who
          ? `${who} hasn't responded to an open item.`
          : "One item hasn't received a response.";
    } else if (days >= 3) {
      slotWaiting = who && what
        ? `${who} hasn't confirmed the ${what} in ${days} day${days === 1 ? "" : "s"}.`
        : who
          ? `${who} has had an open item for ${days} days.`
          : `One item has been waiting for ${days} days.`;
    } else if (totalWaiting === 1) {
      const hoursAgo = Math.round(ageMs / 3_600_000);
      const ageSuffix = hoursAgo < 1 ? " — sent recently" : hoursAgo === 1 ? " — sent about an hour ago" : hoursAgo < 24 ? ` — sent about ${hoursAgo} hours ago` : "";
      slotWaiting = who && what
        ? `${who} hasn't confirmed the ${what}${ageSuffix}.`
        : who
          ? `${who} still has an open item${ageSuffix}.`
          : "One item is awaiting confirmation.";
    } else {
      const top2  = brief.waitingOn.slice(0, 2);
      const names = top2.map(t => cap(t.assigned_to)).filter(Boolean);
      if (names.length === 2 && totalWaiting === 2) {
        slotWaiting = `Two items are waiting: ${names[0]} on ${cleanDesc(top2[0].description)} and ${names[1]} on ${cleanDesc(top2[1].description)}.`;
      } else if (names.length === 2 && totalWaiting > 2) {
        slotWaiting = `${names[0]} and ${names[1]} are still waiting — and ${totalWaiting - 2} other${totalWaiting - 2 === 1 ? "" : "s"}.`;
      } else {
        slotWaiting = `${spokenCount(totalWaiting)} items are waiting on others.`;
      }
    }
  }

  // ── CALENDAR (today's events only — reminders/deadlines live in urgent) ───
  let slotCalendar = "";
  if (inProgress.length > 0) {
    const ev     = inProgress[0];
    const endStr = formatEventEndTime(ev);
    slotCalendar = endStr
      ? `You're currently in ${ev.title}, wrapping up at ${endStr}.`
      : `You're currently in ${ev.title}.`;
  } else if (todayEvs.length === 0) {
    slotCalendar = "Your calendar is clear today.";
  } else if (todayEvs.length === 1) {
    const ev = todayEvs[0];
    const t  = evTime(ev);
    slotCalendar = t
      ? `You also have ${ev.title} at ${t}.`
      : `You also have ${ev.title} on the calendar today.`;
  } else {
    slotCalendar = `You also have ${spokenCount(todayEvs.length)} events on the calendar today.`;
  }

  // ── AUTOMATION STATUS (guaranteed slot) ───────────────────────────────────
  const slotAutomation = automationDigest
    ? formatAutomationForMorning(automationDigest)
    : "";

  // ── GREETING (built last so it can reference what's open) ────────────────
  const hasAnything = !!(slotUrgent || slotWaiting || slotAutomation);
  const frame = hasAnything ? " Here's what needs attention." : "";
  const slotGreeting = name ? `${greeting} ${name}.${frame}` : `${greeting}.${frame}`;

  // ── CLOSE ─────────────────────────────────────────────────────────────────
  // otherOpenCount covers to-dos and actionable notes — categories with no
  // dedicated slot above — as a count only, never individually narrated.
  const hasOpen = brief.waitingOn.length > 0 || brief.needsAttention.length > 0 || brief.overdueItems.length > 0;
  const otherOpenCount = todosCount + notesCount;
  const otherOpenSuffix = otherOpenCount > 0
    ? ` You have ${spokenCount(otherOpenCount)} other open item${otherOpenCount === 1 ? "" : "s"} in the app.`
    : "";
  const slotClose = (hasOpen
    ? "Everything else is on track."
    : "You're clear for the rest of the day.") + otherOpenSuffix;

  // ── PRIORITY SLOT SELECTION ───────────────────────────────────────────────
  // Collect all candidate sentences with priority and speech-order weights.
  // Select top 6 by priority, then re-sort by speech order for natural delivery.
  //
  // Priority (lower = must include):
  //   0 greeting  1 urgent  2 waiting  3 automation  4 calendar  5 close  6 completions
  //
  // Speech order (lower = spoken first):
  //   greeting(0) urgent(1) completions(2) waiting(3) calendar(4) automation(5) close(6)

  interface PriSlot { s: string; pri: number; ord: number; }
  const candidates: PriSlot[] = [
    { s: slotGreeting,    pri: 0, ord: 0 },
    { s: slotUrgent,      pri: 1, ord: 1 },
    { s: slotWaiting,     pri: 2, ord: 3 },
    { s: slotAutomation,  pri: 3, ord: 5 },
    { s: slotCalendar,    pri: 4, ord: 4 },
    { s: slotClose,       pri: 5, ord: 6 },
    { s: slotCompletions, pri: 6, ord: 2 },
  ].filter(c => c.s);

  const selected = candidates
    .sort((a, b) => a.pri - b.pri)
    .slice(0, 6)
    .sort((a, b) => a.ord - b.ord);

  return selected.map(c => c.s).join(" ");
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

function capFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function spokenDesc(raw: string): string {
  const s = raw.trim().replace(/[.!?]+$/, "").trim();
  if (s.length <= 35) return s;
  // Cut at the last word boundary before 35 chars to avoid mid-word truncation.
  const cut = s.slice(0, 35);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 10 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

// Keyword → label map. Checked against the full description (lowercased).
// First match wins; order matters — more specific patterns first.
const LABEL_PATTERNS: Array<[RegExp, string]> = [
  [/\bcat food\b/,                      "cat food task"],
  [/\bflower|bouquet/,                  "flowers request"],
  [/\bcar\b|driver|pick.?up|drop.?off/, "car task"],
  [/\bdelivery|courier/,                "delivery task"],
  [/\bbill|electric|utilities|utility/, "bill task"],
  [/\bgroceries|grocery|kitchen\b/,     "food task"],
  [/\bfood\b/,                          "food task"],
];

// Strip leading imperative verbs that add no noun content.
const LEADING_VERB = /^(check and make sure|make sure|please|order|remind|ask|tell|confirm|have|message|send|check|follow up on|follow up|get)\s+/i;

/**
 * Returns a short spoken label for a task description.
 * Tries keyword matching first; falls back to stripping leading verbs
 * and truncating to a clean noun phrase.
 */
function taskLabel(raw: string): string {
  const lower = raw.trim().toLowerCase();

  for (const [pattern, label] of LABEL_PATTERNS) {
    if (pattern.test(lower)) return label;
  }

  // Fallback: strip leading verbs, lowercase, truncate.
  let s = raw.trim().replace(/[.!?]+$/, "").trim();
  s = s.replace(LEADING_VERB, "").trim();
  s = s.charAt(0).toLowerCase() + s.slice(1);

  if (s.length <= 35) return s;
  const cut = s.slice(0, 35);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 10 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

// Alias so callers that used cleanDesc still work during migration.
function cleanDesc(raw: string): string {
  return taskLabel(raw);
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
