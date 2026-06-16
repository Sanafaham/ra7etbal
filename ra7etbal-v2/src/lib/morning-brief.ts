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
  /** Active delegations / followups awaiting recipient confirmation. */
  waitingOn: Task[];
  /** Overdue reminders + escalated delegations still pending. */
  overdueItems: Task[];
  /** Tasks confirmed done in the last 24 hours. */
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
  // Overdue reminder OR escalated delegation still pending.
  const overdueItems = active.filter((t) => {
    if (t.status !== "pending") return false;
    if (t.type === "reminder" && isReminderOverdue(t.due_at, now)) return true;
    if (t.escalated_at != null) return true;
    return false;
  });
  const overdueIds = new Set(overdueItems.map((t) => t.id));

  // ── 2. Waiting on others ─────────────────────────────────────────────────
  // Active delegations / followups; excludes items already in overdue.
  const waitingOn = active
    .filter((t) => {
      if (t.status !== "pending") return false;
      if (overdueIds.has(t.id)) return false;
      if (t.type === "delegation" && t.assigned_to) return true;
      if (t.type === "followup") return true;
      if (t.needs_follow_up && t.assigned_to) return true;
      return false;
    })
    // Oldest first — escalated/stale items surface before fresh ones
    .sort((a, b) => getDateValue(a.created_at) - getDateValue(b.created_at));
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

  // ── 4. Recent completions (last 24 h) ────────────────────────────────────
  const cutoff = new Date(nowMs - 24 * 60 * 60 * 1000);
  const recentCompletions = tasks
    .filter((t) => {
      if (t.status !== "done" || !t.confirmed_at) return false;
      const confirmedAt = new Date(t.confirmed_at);
      return confirmedAt >= cutoff && confirmedAt <= now;
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
// buildMorningBriefSpoken — Morning Confirmation Loop V1
// ---------------------------------------------------------------------------

/**
 * Morning Confirmation Loop — Carson's spoken daily brief.
 *
 * Five sections, relief-first. Not a dashboard. Not a task list.
 * Goal: user hears this and knows they can relax or knows exactly one thing to do.
 *
 *   1. RESOLVED SINCE YESTERDAY — max 3 completions (closes loops, builds trust)
 *   2. STILL WAITING            — max 2 unconfirmed delegations (oldest first)
 *   3. OLDEST STUCK LOOP        — max 1 (escalated > stale 72h > stale 48h)
 *   4. UPCOMING DEADLINE        — max 1 (reminder today or next calendar event)
 *   5. ONE QUESTION             — exactly 1, context-driven, always last
 *
 * Hard cap: 5 sentences total (greeting is embedded in section 1).
 * Called from App.tsx as `daily_brief` ElevenLabs dynamic variable.
 */
export function buildMorningBriefSpoken(
  tasks: Task[],
  people: Person[],
  displayName?: string | null,
  now = new Date(),
  calendarEvents?: CalendarEvent[],
): string {
  const brief = buildMorningBrief(tasks, people, now);
  const name  = displayName?.trim() || null;
  const hour  = now.getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const open = name ? `${greeting} ${name}.` : `${greeting}.`;

  // ── Calendar helpers ───────────────────────────────────────────────────────
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

  const todayEvs  = calEvents.filter(ev => { const d = evLocalDate(ev); return d !== null && d >= todayStart && d < tomStart; });
  const upcoming  = todayEvs.filter(ev => classifyCalendarEvent(ev, now) === "upcoming");
  const inProgress = todayEvs.filter(ev => classifyCalendarEvent(ev, now) === "in_progress");

  // ── SECTION 1: RESOLVED SINCE YESTERDAY ───────────────────────────────────
  // Leads with greeting + what is handled. Relief before burden.
  // Max 3 completions. If none, greeting stands alone.
  const resolved = brief.recentCompletions.slice(0, 3);
  let section1 = open;

  if (resolved.length === 0) {
    // No completions — greeting alone; sections 2–4 carry the context
  } else if (resolved.length === 1) {
    section1 += ` Here's what's handled: ${buildCompletionSentence(resolved[0])}`;
  } else if (resolved.length === 2) {
    section1 += ` Here's what's handled: ${buildCompletionSentence(resolved[0])} ${buildCompletionSentence(resolved[1])}`;
  } else {
    const first = buildCompletionSentence(resolved[0]);
    section1 += ` Here's what's handled: ${first} And ${spokenCount(resolved.length - 1)} more things confirmed since yesterday.`;
  }

  // ── SECTION 2: STILL WAITING ───────────────────────────────────────────────
  // Calming framing: "Here's what is still waiting." not a list of problems.
  // Max 2 unconfirmed delegations, oldest first.
  let section2 = "";
  const waiting = brief.waitingOn.slice(0, 2);
  const totalWaiting = brief.waitingOn.length;

  if (waiting.length === 1) {
    const t    = waiting[0];
    const who  = cap(t.assigned_to);
    const what = cleanDesc(t.description);
    section2 = who && what
      ? `${who} is still waiting to confirm ${what}.`
      : who
        ? `${who} still has an open item.`
        : "One item is still waiting on confirmation.";
  } else if (waiting.length >= 2) {
    const names = waiting.map(t => cap(t.assigned_to)).filter(Boolean);
    if (names.length === 2) {
      section2 = totalWaiting > 2
        ? `${names[0]} and ${names[1]} are still waiting — and ${totalWaiting - 2} other${totalWaiting - 2 === 1 ? "" : "s"}.`
        : `${names[0]} and ${names[1]} are still waiting to confirm.`;
    } else {
      section2 = `${spokenCount(totalWaiting)} items are still waiting on others.`;
    }
  }

  // ── SECTION 3: OLDEST STUCK LOOP ──────────────────────────────────────────
  // Surfaces the single most stuck item. Calm, factual, no alarm.
  // Priority: escalated → stale 72h → stale 48h → overdue reminder.
  let section3 = "";
  const nowMs  = now.getTime();
  const MS_72H = 72 * 60 * 60 * 1000;
  const MS_48H = 48 * 60 * 60 * 1000;

  const escalatedItem = brief.waitingOn.find(t => t.escalated_at != null);
  const stale72Item   = brief.waitingOn.find(t => nowMs - new Date(t.created_at).getTime() >= MS_72H);
  const stale48Item   = brief.waitingOn.find(t => nowMs - new Date(t.created_at).getTime() >= MS_48H);
  const overdueItem   = brief.overdueItems.find(t => t.type === "reminder");
  const stuckItem     = escalatedItem ?? stale72Item ?? stale48Item ?? overdueItem ?? null;

  if (stuckItem) {
    const ageMs = nowMs - new Date(stuckItem.created_at).getTime();
    const days  = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    const who   = cap(stuckItem.assigned_to);
    const what  = cleanDesc(stuckItem.description);

    if (stuckItem.escalated_at && who) {
      section3 = what
        ? `One thing I want to flag: ${who} hasn't responded to ${what} — I can follow up.`
        : `One thing I want to flag: ${who} has an open item with no response — I can follow up.`;
    } else if (days >= 2 && who) {
      section3 = what
        ? `${who} hasn't confirmed ${what} in ${days} day${days === 1 ? "" : "s"} — I can follow up.`
        : `${who} has had an open item for ${days} day${days === 1 ? "" : "s"} — I can follow up.`;
    } else if (stuckItem.type === "reminder" && isReminderOverdue(stuckItem.due_at, now)) {
      section3 = `One reminder is overdue: "${spokenDesc(stuckItem.description)}."`;
    } else if (who) {
      section3 = what
        ? `${who} hasn't confirmed ${what} yet — I can follow up.`
        : `${who} still has an open item.`;
    }
  }

  // ── SECTION 4: UPCOMING DEADLINE ──────────────────────────────────────────
  // Calendar is secondary. Only surface if in-progress, timed reminder, or 1 clear
  // upcoming event. Skip generic calendar mentions unless event is timed and soon.
  // Do NOT say "busy day" unless there are 4+ calendar events today.
  let section4 = "";

  const todayReminder = brief.needsAttention.find(
    t => t.type === "reminder" && t.due_at && !isReminderOverdue(t.due_at, now),
  );

  if (inProgress.length > 0) {
    // In-progress event is urgent enough to surface
    const ev     = inProgress[0];
    const endStr = formatEventEndTime(ev);
    section4 = endStr
      ? `You're currently in ${ev.title}, wrapping up at ${endStr}.`
      : `You're currently in ${ev.title}.`;
  } else if (todayReminder) {
    // Timed reminder is more actionable than calendar
    const timeSuffix = spokenTimeSuffix(todayReminder.due_at, now);
    section4 = timeSuffix
      ? `Reminder: "${spokenDesc(todayReminder.description)}" ${timeSuffix}.`
      : `You have a reminder about "${spokenDesc(todayReminder.description)}" today.`;
  } else if (todayEvs.length >= 4) {
    // Many events — brief summary instead of listing
    section4 = `You have ${spokenCount(todayEvs.length)} things on your calendar today.`;
  } else if (upcoming.length > 0) {
    // Single upcoming event — name it only if timed
    const ev = upcoming[0];
    const t  = evTime(ev);
    section4 = t ? `${ev.title} is at ${t}.` : "";
  }

  // ── SECTION 5: ONE QUESTION ────────────────────────────────────────────────
  // Always exactly one. Context-driven. Offers a specific action, not a vague ask.
  // Priority: escalated → stale → waiting → overdue → reminder → clear
  let section5 = "";

  if (escalatedItem) {
    const who = cap(escalatedItem.assigned_to);
    section5 = who
      ? `Would you like me to follow up with ${who}?`
      : "Should I escalate this further?";
  } else if (stale72Item ?? stale48Item) {
    const item = stale72Item ?? stale48Item!;
    const who  = cap(item.assigned_to);
    section5 = who
      ? `Would you like me to send ${who} a follow-up?`
      : "Should I follow up on the oldest open item?";
  } else if (brief.waitingOn.length > 0) {
    const t   = brief.waitingOn[0];
    const who = cap(t.assigned_to);
    section5 = who
      ? `Would you like me to follow up with ${who}?`
      : "Should I follow up on the oldest pending item?";
  } else if (overdueItem) {
    section5 = `Should I remind you about "${spokenDesc(overdueItem.description)}" now?`;
  } else if (brief.needsAttention.length > 0) {
    const t = brief.needsAttention[0];
    section5 = t.type === "reminder"
      ? `Should I remind you about "${spokenDesc(t.description)}" later today?`
      : "Is there anything you'd like me to take care of first?";
  } else {
    section5 = "Is there anything you'd like me to handle today?";
  }

  // ── Assemble ───────────────────────────────────────────────────────────────
  // Build up to 5 sentences: greeting+resolved, waiting, stuck, deadline, question.
  // Skip empty sections. Always end with the question.
  const parts = [section1, section2, section3, section4].filter(Boolean);
  // Hard cap: leave room for the question (always included)
  const body = parts.slice(0, 4).join(" ");
  return body ? `${body} ${section5}` : `${open} ${section5}`;
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

function buildCompletionSentence(t: Task): string {
  const assignee = t.assigned_to?.trim() ?? "";
  const isDelegated =
    t.type === "delegation" ||
    t.type === "followup" ||
    (!!assignee && assignee.toLowerCase() !== "me");
  if (isDelegated && assignee) {
    return `${cap(assignee)} confirmed: ${spokenDesc(t.description)}.`;
  }
  return `You completed "${spokenDesc(t.description)}" recently.`;
}
