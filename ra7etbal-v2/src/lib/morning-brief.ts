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
  const waitingOn = active.filter((t) => {
    if (t.status !== "pending") return false;
    if (overdueIds.has(t.id)) return false;
    if (t.type === "delegation" && t.assigned_to) return true;
    if (t.type === "followup") return true;
    if (t.needs_follow_up && t.assigned_to) return true;
    return false;
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
// buildMorningBriefSpoken — Chief-of-Staff spoken output
// ---------------------------------------------------------------------------

/**
 * Builds the ready-to-speak Morning Brief paragraph for Carson — V3.
 *
 * Chief-of-Staff operating brief: one paragraph, 3–5 sentences, urgency-first.
 * Not a task list. Not a dashboard. A 30-second State of the Day.
 *
 * Five slots (filled in priority order):
 *   1. Greeting
 *   2. State sentence  (in-progress > overdue > silent-if-normal)
 *   3. Calendar anchor (next 1–2 upcoming today, or tomorrow if evening)
 *   4. Most important open loop (cross-references calendar + people when possible)
 *   5. Close           (only when genuinely zero open items)
 *
 * Hard cap: 5 sentences. If 3+ uncovered loops remain after slot 2, Carson
 * summarises and offers to go through them rather than listing each.
 *
 * Called from App.tsx → PersistentCarsonWidget and used as the `spokenBrief`
 * prop for ElevenLabsAgentWidget (dynamic variable `daily_brief`).
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

  // ── Calendar buckets ───────────────────────────────────────────────────────
  const calEvents     = calendarEvents ?? [];
  const todayStart    = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomStart      = new Date(todayStart.getTime() + 86_400_000);
  const dayAfterStart = new Date(tomStart.getTime() + 86_400_000);

  /** Returns the local midnight Date for an event, handling all-day date strings. */
  function evLocalDate(ev: CalendarEvent): Date | null {
    if (!ev.start) return null;
    if (ev.allDay) {
      const parts = ev.start.split("-").map(Number);
      if (parts.length < 3) return null;
      return new Date(parts[0], parts[1] - 1, parts[2]);
    }
    const d = new Date(ev.start);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  /** e.g. "1:00 PM" — empty string for all-day or unparseable. */
  function evTime(ev: CalendarEvent): string {
    if (ev.allDay || !ev.start) return "";
    const d = new Date(ev.start);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  const todayEvs   = calEvents.filter(ev => { const d = evLocalDate(ev); return d !== null && d >= todayStart && d < tomStart; });
  const tomorrowEvs = calEvents.filter(ev => { const d = evLocalDate(ev); return d !== null && d >= tomStart && d < dayAfterStart; });

  const inProgress = todayEvs.filter(ev => classifyCalendarEvent(ev, now) === "in_progress");
  const upcoming   = todayEvs.filter(ev => classifyCalendarEvent(ev, now) === "upcoming");

  // ── Urgency flags ──────────────────────────────────────────────────────────
  const hasOverdue   = brief.overdueItems.length > 0;
  const hasAttention = brief.needsAttention.length > 0;
  const hasWaiting   = brief.waitingOn.length > 0;
  const totalUnresolved =
    brief.overdueItems.length + brief.needsAttention.length + brief.waitingOn.length;

  // ── Pre-compute cross-reference ────────────────────────────────────────────
  // A waiting-on person whose name appears in an in-progress or upcoming event
  // gets a merged "X is at Y — they still haven't confirmed Z" sentence.
  const calToday = [...inProgress, ...upcoming];
  let crossRef: { task: Task; calEvent: CalendarEvent } | null = null;
  if (hasWaiting) {
    for (const t of brief.waitingOn) {
      const pName = (t.assigned_to ?? "").trim().toLowerCase();
      if (!pName) continue;
      const match = calToday.find(ev => ev.title.toLowerCase().includes(pName));
      if (match) { crossRef = { task: t, calEvent: match }; break; }
    }
  }

  const sentences: string[] = [];

  // ── SLOT 1: Greeting ───────────────────────────────────────────────────────
  sentences.push(name ? `${greeting} ${name}.` : `${greeting}.`);

  // ── SLOT 2: State sentence ─────────────────────────────────────────────────
  // Priority: in-progress > overdue > genuinely-clear
  // Skip when there are normal attention/waiting items — the calendar anchors next.
  let coveredOverdueCount = 0;

  if (inProgress.length > 0) {
    const ev    = inProgress[0];
    const endStr = formatEventEndTime(ev);
    sentences.push(endStr
      ? `You're currently in ${ev.title}, until ${endStr}.`
      : `You're currently in ${ev.title}.`);

  } else if (hasOverdue) {
    coveredOverdueCount = brief.overdueItems.length;
    if (brief.overdueItems.length === 1) {
      const t   = brief.overdueItems[0];
      const who = cap(t.assigned_to);
      if (t.type === "reminder") {
        sentences.push(`One thing needs you — your reminder about "${spokenDesc(t.description)}" is overdue.`);
      } else {
        sentences.push(who
          ? `${who} hasn't confirmed "${spokenDesc(t.description)}" — it's overdue.`
          : "One escalated item still needs your attention.");
      }
    } else {
      const rc = brief.overdueItems.filter(t => t.type === "reminder").length;
      const dc = brief.overdueItems.length - rc;
      if (rc > 0 && dc > 0) {
        sentences.push(`${spokenCount(brief.overdueItems.length)} things are overdue right now.`);
      } else if (rc > 0) {
        sentences.push(`${spokenCount(rc)} reminder${rc === 1 ? "" : "s"} ${rc === 1 ? "is" : "are"} overdue.`);
      } else {
        sentences.push(`${spokenCount(dc)} escalated item${dc === 1 ? "" : "s"} still ${dc === 1 ? "needs" : "need"} resolution.`);
      }
    }

  } else if (!hasAttention && !hasWaiting && upcoming.length === 0 && tomorrowEvs.length === 0) {
    // Truly nothing — say so here; slot 5 will be skipped
    sentences.push("You're clear.");
  }
  // Otherwise (attention/waiting items exist but nothing critical): silent here,
  // let calendar anchor and open loop do the work.

  // ── SLOT 3: Calendar anchor ────────────────────────────────────────────────
  // Skipped when slot 2 already used the in-progress event.
  // Tracks which events are mentioned so slot 4 cross-ref can avoid repetition.
  const mentionedCalIds = new Set<string>();

  if (inProgress.length === 0) {
    if (upcoming.length > 0) {
      const top = upcoming.slice(0, 2);
      if (top.length === 1) {
        const ev = top[0];
        const t  = evTime(ev);
        sentences.push(t ? `${ev.title} is at ${t}.` : `You have ${ev.title} later today.`);
        mentionedCalIds.add(ev.id);
      } else {
        const [a, b] = top;
        const ta = evTime(a); const tb = evTime(b);
        const aStr = ta ? `${a.title} at ${ta}` : a.title;
        const bStr = tb ? `${b.title} at ${tb}` : b.title;
        sentences.push(`${aStr}, and ${bStr}.`);
        mentionedCalIds.add(a.id);
        mentionedCalIds.add(b.id);
      }
    } else if (hour >= 18 || todayEvs.length === 0) {
      // Evening or empty day — anchor on tomorrow
      if (tomorrowEvs.length === 1) {
        const ev = tomorrowEvs[0];
        const t  = evTime(ev);
        sentences.push(t ? `Tomorrow you have ${ev.title} at ${t}.` : `Tomorrow you have ${ev.title}.`);
      } else if (tomorrowEvs.length >= 2) {
        const [a, b] = tomorrowEvs;
        const ta = evTime(a); const tb = evTime(b);
        const aStr = ta ? `${a.title} at ${ta}` : a.title;
        const bStr = tb ? `${b.title} at ${tb}` : b.title;
        sentences.push(`Tomorrow: ${aStr} and ${bStr}.`);
      }
    }
  }

  // ── SLOT 4: Most important open loop ──────────────────────────────────────
  // Compute how many loops are uncovered after slot 2 handled overdue items.
  const uncovered = totalUnresolved - coveredOverdueCount;

  if (uncovered >= 3) {
    sentences.push("A few things need attention — want me to go through them?");

  } else if (uncovered > 0) {
    // Priority 1: cross-reference — waiting-on person also on calendar today
    if (crossRef) {
      const { task: t, calEvent: ev } = crossRef;
      const what = cleanDesc(t.description);
      const who  = cap(t.assigned_to) ?? "They";
      if (mentionedCalIds.has(ev.id)) {
        // Calendar already mentioned in slot 3 — use short form
        sentences.push(what
          ? `${who} still hasn't confirmed ${what}.`
          : `${who} still has an open item.`);
      } else {
        // Merge calendar + loop into one sentence
        const t2   = evTime(ev);
        const anchor = t2 ? `${ev.title} is at ${t2}` : ev.title;
        sentences.push(what
          ? `${anchor} — ${who.toLowerCase()} still hasn't confirmed ${what}.`
          : `${anchor} — ${who.toLowerCase()} still has an open item.`);
      }

    // Priority 2: reminder due today (with spoken time)
    } else if (hasAttention) {
      const rem = brief.needsAttention.find(t => t.type === "reminder" && t.due_at);
      if (rem) {
        const timeSuffix = spokenTimeSuffix(rem.due_at, now);
        sentences.push(timeSuffix
          ? `You have a reminder about "${spokenDesc(rem.description)}" ${timeSuffix}.`
          : `You have a reminder about "${spokenDesc(rem.description)}" today.`);
      } else {
        // Personal task needing attention
        const t = brief.needsAttention[0];
        sentences.push(`"${spokenDesc(t.description)}" needs your attention.`);
      }

    // Priority 3: waiting-on (no calendar match)
    } else if (hasWaiting) {
      const t   = brief.waitingOn[0];
      const who = cap(t.assigned_to);
      const what = cleanDesc(t.description);
      sentences.push(who && what
        ? `${who} is still waiting to confirm ${what}.`
        : who
          ? `You're waiting on ${who}.`
          : "One item is waiting on confirmation.");
    }

  } else {
    // No open loops — surface a very recent completion (2 h window) if space allows
    const twoHAgo     = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const veryRecent  = brief.recentCompletions.filter(t =>
      t.confirmed_at && new Date(t.confirmed_at) >= twoHAgo);
    if (veryRecent.length > 0 && sentences.length < 4) {
      sentences.push(buildCompletionSentence(veryRecent[0]));
    }
  }

  // ── SLOT 5: Close ──────────────────────────────────────────────────────────
  // Only when there are genuinely zero open items (overdue, attention, or waiting).
  // Never emitted when slot 2 already said "You're clear."
  if (!hasOverdue && !hasAttention && !hasWaiting && sentences.length <= 4) {
    const alreadyClear = sentences.some(s => s.includes("You're clear"));
    if (!alreadyClear) sentences.push("Nothing else needs you.");
  }

  // Hard cap — safety net; normal paths never exceed 5
  return sentences.slice(0, 5).join(" ");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
