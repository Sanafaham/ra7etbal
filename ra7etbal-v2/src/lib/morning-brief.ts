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
 * Morning Brief V3 — Chief of Staff briefing.
 *
 * Five sections, hard cap 5 sentences. Priority order:
 *   1. GREETING          — "Good morning Sana." — standalone, no calendar attached
 *   2. COMPLETIONS       — rolling 24h, named; answers "what happened?"
 *   3. WAITING           — top waiter, risk-framed when escalated/stale
 *   4. CALENDAR / DEADLINE — demoted; answers "what does my day look like?"
 *   5. STATUS CLOSE      — "Everything else is on track." or secondary risk
 *
 * Dedup rule: if section 3 names the risk, section 5 closes warmly.
 * Calendar never dominates — it lives in section 4, not the greeting.
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
  const upcoming   = todayEvs.filter(ev => classifyCalendarEvent(ev, now) === "upcoming");

  // ── SECTION 1: GREETING (standalone) ──────────────────────────────────────
  // Just the name. Calendar belongs in section 4 so completions come first.
  const section1 = name ? `${greeting} ${name}.` : `${greeting}.`;

  // ── SECTION 2: COMPLETIONS (rolling 24 h) ─────────────────────────────────
  // Named and specific. Named delegation confirmations get priority.
  // 1: name it. 2: name both. 3+: name notable delegated one + count.
  let section2 = "";
  const recentCutoff = new Date(nowMs - 24 * 60 * 60 * 1000);
  const recentDone = tasks
    .filter(t => {
      if (t.status !== "done" || !t.confirmed_at) return false;
      const confirmedAt = new Date(t.confirmed_at);
      return confirmedAt >= recentCutoff && confirmedAt <= now;
    })
    .sort((a, b) => new Date(b.confirmed_at!).getTime() - new Date(a.confirmed_at!).getTime());

  if (recentDone.length === 1) {
    section2 = buildCompletionSentenceV3(recentDone[0]);
  } else if (recentDone.length === 2) {
    section2 = `${buildCompletionSentenceV3(recentDone[0])} ${buildCompletionSentenceV3(recentDone[1])}`;
  } else if (recentDone.length >= 3) {
    const notable = recentDone.find(t => {
      const a = t.assigned_to?.trim().toLowerCase();
      return !!a && a !== "me" && (t.type === "delegation" || t.type === "followup");
    });
    const countPhrase = capFirst(spokenCount(recentDone.length));
    section2 = notable && cap(notable.assigned_to) && cleanDesc(notable.description)
      ? `${countPhrase} items were completed in the last 24 hours, including ${cap(notable.assigned_to)}'s ${cleanDesc(notable.description)}.`
      : `${countPhrase} items were completed in the last 24 hours.`;
  }

  // ── SECTION 3: WAITING ────────────────────────────────────────────────────
  // Always names the top waiter. Risk-framed (escalated/stale) or status-framed.
  // When there is only 1 waiter and they are the risk: use risk framing here so
  // section 5 can close warmly ("Everything else is on track.").
  let section3 = "";
  const totalWaiting   = brief.waitingOn.length;
  const escalatedItem  = brief.waitingOn.find(t => t.escalated_at != null);
  const stale72Item    = brief.waitingOn.find(
    t => nowMs - new Date(t.created_at).getTime() >= MS_72H,
  );
  const riskItem = escalatedItem ?? stale72Item ?? null;
  // The top waiter: risk item if present, otherwise first in sorted list.
  const topWaiter = riskItem ?? brief.waitingOn[0] ?? null;

  if (topWaiter) {
    const who   = cap(topWaiter.assigned_to);
    const what  = cleanDesc(topWaiter.description);
    const ageMs = nowMs - new Date(topWaiter.created_at).getTime();
    const days  = Math.floor(ageMs / MS_DAY);

    if (topWaiter.escalated_at != null) {
      // Escalated — strong but calm framing
      section3 = who && what
        ? `${who} still hasn't confirmed ${what}.`
        : who
          ? `${who} hasn't responded to an open item.`
          : "One item hasn't received a response.";
    } else if (days >= 3) {
      // Stale 72h+ — time signal
      section3 = who && what
        ? `${who} hasn't confirmed ${what} in ${days} day${days === 1 ? "" : "s"}.`
        : who
          ? `${who} has had an open item for ${days} days.`
          : `One item has been waiting for ${days} days.`;
    } else if (totalWaiting === 1) {
      // Single fresh waiter
      section3 = who && what
        ? `${who} is still waiting on ${what}.`
        : who
          ? `${who} still has an open item.`
          : "One item is awaiting confirmation.";
    } else {
      // Multiple waiters — name the top two
      const top2  = brief.waitingOn.slice(0, 2);
      const names = top2.map(t => cap(t.assigned_to)).filter(Boolean);
      if (names.length === 2 && totalWaiting === 2) {
        section3 = `Two items are waiting: ${names[0]} on ${cleanDesc(top2[0].description)} and ${names[1]} on ${cleanDesc(top2[1].description)}.`;
      } else if (names.length === 2 && totalWaiting > 2) {
        section3 = `${names[0]} and ${names[1]} are still waiting — and ${totalWaiting - 2} other${totalWaiting - 2 === 1 ? "" : "s"}.`;
      } else {
        section3 = `${spokenCount(totalWaiting)} items are waiting on others.`;
      }
    }
  }

  // ── SECTION 4: CALENDAR / DEADLINE ────────────────────────────────────────
  // Calendar demoted here. Urgent deadline or reminder overrides calendar shape.
  // Always produces a sentence so the user knows what their day looks like.
  const overdueReminder = brief.overdueItems.find(t => t.type === "reminder");
  const todayReminder   = brief.needsAttention.find(
    t => t.type === "reminder" && t.due_at && !isReminderOverdue(t.due_at, now),
  );

  // Invisible deadline: soonest reminder/decision 1–14 days out
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

  let section4 = "";
  if (overdueReminder) {
    section4 = `One reminder is overdue: ${spokenDesc(overdueReminder.description)}.`;
  } else if (todayReminder) {
    const timeSuffix = spokenTimeSuffix(todayReminder.due_at, now);
    section4 = timeSuffix
      ? `You have a reminder — ${spokenDesc(todayReminder.description)} ${timeSuffix}.`
      : `You have a reminder today — ${spokenDesc(todayReminder.description)}.`;
  } else if (inProgress.length > 0) {
    const ev     = inProgress[0];
    const endStr = formatEventEndTime(ev);
    section4 = endStr
      ? `You're currently in ${ev.title}, wrapping up at ${endStr}.`
      : `You're currently in ${ev.title}.`;
  } else if (upcomingDeadline) {
    const dayCount = spokenDaysUntil(upcomingDeadline.due_at!, now);
    section4 = `One deadline is coming up — ${spokenDesc(upcomingDeadline.description)} ${dayCount}.`;
  } else if (todayEvs.length === 0) {
    section4 = "Your calendar is clear today.";
  } else if (todayEvs.length === 1) {
    const ev = todayEvs[0];
    const t  = evTime(ev);
    section4 = t
      ? `You have one event today — ${ev.title} at ${t}.`
      : `You have one event today — ${ev.title}.`;
  } else {
    section4 = `You have ${spokenCount(todayEvs.length)} events on the calendar today.`;
  }

  // ── SECTION 5: STATUS CLOSE ────────────────────────────────────────────────
  // If section 3 already named the risk, close warmly. Only raise a NEW risk
  // here if something wasn't covered above. Never repeat what section 3 said.
  let section5: string;
  const riskNamedInSection3 = riskItem != null && section3.length > 0;

  if (riskNamedInSection3) {
    // Section 3 already surfaced the worst problem — close warmly.
    section5 = "Everything else is on track.";
  } else if (brief.waitingOn.length > 0) {
    // Fresh waiting items but no stale/escalated — honest but calm.
    section5 = "Everything else is on track.";
  } else if (overdueReminder) {
    section5 = "That reminder needs your attention before anything else.";
  } else if (brief.needsAttention.length > 0) {
    section5 = "Everything else is on track.";
  } else {
    section5 = "Nothing is waiting — your day is under control.";
  }

  // ── Assemble ───────────────────────────────────────────────────────────────
  // Hard cap: 5 sentences. S1 and S5 always present; S2–S4 conditional.
  const body = [section1, section2, section3, section4, section5]
    .filter(Boolean)
    .slice(0, 5)
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
