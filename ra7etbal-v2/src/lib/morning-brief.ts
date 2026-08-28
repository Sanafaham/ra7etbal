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
import type { AutomationDigest } from "./automation-context";
import { formatAutomationForMorning } from "./automation-context";
import type { OpenStaffEscalation } from "../types/staff-message";
import { isQualityOwnerReviewStatus } from "./quality-lifecycle";
// PURE RELOCATION (2026-08-28, Second Brain typed hard-grounding slice):
// buildMorningBrief() and taskLabel() moved to shared/ so the server-side
// attention read path can reuse the exact same task-attention rules
// without pulling in this file's calendar.ts/automation-context.ts
// imports (both browser-only). Imported here for local use and re-exported
// below so every existing caller's import path (`./morning-brief`) and
// behavior are unchanged.
import { buildMorningBrief, taskLabel, isSameLocalDay } from "../../shared/carson-morning-brief-classifier.js";
import type { MorningBriefData, RiskItem } from "../../shared/carson-morning-brief-classifier";
export { buildMorningBrief, taskLabel };
export type { MorningBriefData, RiskItem };

/**
 * Whether a Waiting On Others item (delegation/followup) is materially
 * useful for the owner to hear about right now — NOT "has it existed for
 * N hours." Age alone is never sufficient relevance (Chief-of-Staff
 * contract, 2026-08-18): a routine, low-consequence delegation must not
 * become briefing-worthy merely because time passed.
 *
 * Uses only signals the data model actually and reliably represents:
 *   - escalated_at: the app's own existing 20-minute escalation signal.
 *   - quality_review_status in {uncertain, substitute_review}: the same
 *     signal daily-brief.ts's isWaitingInterventionTask() already uses to
 *     pull a task OUT of Waiting and into Needs You — a genuine,
 *     pre-existing "requires owner decision" fact, not invented here.
 *   - due_at, when present and overdue or due today: the extraction
 *     pipeline can populate a due date on a delegation/followup (not only
 *     reminders), and an overdue/due-today deadline is a real consequence
 *     signal already used elsewhere for reminders.
 *
 * Deliberately does NOT use elapsed time since creation — no substitute
 * threshold was invented for the removed 3-day rule.
 */
export function isMaterialWaitingItem(task: Task, now: Date): boolean {
  if (task.escalated_at != null) return true;
  if (isQualityOwnerReviewStatus(task.quality_review_status)) return true;
  if (task.due_at) {
    const due = new Date(task.due_at);
    if (!Number.isNaN(due.getTime()) && (due.getTime() <= now.getTime() || isSameLocalDay(due, now))) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// buildMorningBrief, MorningBriefData, RiskItem, buildRisks: see
// shared/carson-morning-brief-classifier.js — imported and re-exported
// above, pure relocation, no behavior change.
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
 * Called from App.tsx as `daily_brief` ElevenLabs dynamic variable.
 */
export function buildMorningBriefSpoken(
  tasks: Task[],
  people: Person[],
  displayName?: string | null,
  now = new Date(),
  calendarEvents?: CalendarEvent[],
  automationDigest?: AutomationDigest,
  needsYou?: OpenStaffEscalation[],
): string {
  const brief  = buildMorningBrief(tasks, people, now, automationDigest?.routineAutomationTaskIds);
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
  const inProgress = todayEvs.filter(ev => classifyCalendarEvent(ev, now) === "in_progress");

  // ── URGENT — items requiring Sana's direct action ─────────────────────────
  // Priority: overdue reminders → personal reminders due today → personal tasks → upcoming deadline
  const overdueReminder = brief.overdueItems.find(t => t.type === "reminder");
  const todayReminder   = brief.needsAttention.find(
    t => t.type === "reminder" && t.due_at && !isReminderOverdue(t.due_at, now),
  );
  const personalTasks   = brief.needsAttention.filter(t => t.type !== "reminder");

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

  let slotUrgent = "";
  if (overdueReminder) {
    slotUrgent = `One reminder is overdue: ${spokenDesc(overdueReminder.description)}.`;
  } else if (todayReminder) {
    const timeSuffix = spokenTimeSuffix(todayReminder.due_at, now);
    slotUrgent = timeSuffix
      ? `You have a reminder — ${spokenDesc(todayReminder.description)} ${timeSuffix}.`
      : `You have a reminder today — ${spokenDesc(todayReminder.description)}.`;
  } else if (personalTasks.length === 1) {
    slotUrgent = `One task needs your attention: ${spokenDesc(personalTasks[0].description)}.`;
  } else if (personalTasks.length > 1) {
    slotUrgent = `${spokenCount(personalTasks.length)} tasks need your attention today.`;
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
    if (notable && cap(notable.assigned_to) && cleanDesc(notable.description, notable.assigned_to)) {
      const lead = buildCompletionSentenceV3(notable);
      slotCompletions = rest > 0
        ? `${lead} ${capFirst(spokenCount(rest))} other item${rest === 1 ? " was" : "s were"} also completed.`
        : lead;
    } else {
      slotCompletions = `${capFirst(spokenCount(recentDone.length))} items were completed in the last 24 hours.`;
    }
  }

  // ── WAITING ON OTHERS ─────────────────────────────────────────────────────
  // Only briefing-worthy when it's materially useful right now — escalated,
  // requires an owner decision, or has an overdue/due-today deadline. Age
  // alone is never sufficient (Chief-of-Staff contract — a routine, fresh
  // waiting item is not spoken merely because it exists, and a routine item
  // that has simply sat for a while is not spoken merely because time
  // passed either). See isMaterialWaitingItem()'s doc comment for the exact
  // signals used.
  let slotWaiting = "";
  const topWaiter = brief.waitingOn.find(t => isMaterialWaitingItem(t, now)) ?? null;

  if (topWaiter) {
    const who  = cap(topWaiter.assigned_to);
    const what = cleanDesc(topWaiter.description, topWaiter.assigned_to);

    if (topWaiter.escalated_at != null) {
      slotWaiting = who && what
        ? `${who} still hasn't confirmed the ${what}.`
        : who
          ? `${who} hasn't responded to an open item.`
          : "One item hasn't received a response.";
    } else if (isQualityOwnerReviewStatus(topWaiter.quality_review_status)) {
      slotWaiting = who && what
        ? `${who}'s ${what} needs your review.`
        : "One item needs your review.";
    } else {
      slotWaiting = who && what
        ? `${who} needs to confirm the ${what} today.`
        : "One item needs confirmation today.";
    }
  }

  // ── NEEDS YOU — genuine owner decisions (distinct from Waiting On Others) ─
  let slotNeedsYou = "";
  if (needsYou && needsYou.length === 1) {
    slotNeedsYou = `One decision needs you — ${cap(needsYou[0].staffName)} is waiting on an answer.`;
  } else if (needsYou && needsYou.length > 1) {
    slotNeedsYou = `${spokenCount(needsYou.length)} decisions need you — starting with ${cap(needsYou[0].staffName)}.`;
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

  // ── AUTOMATION STATUS ──────────────────────────────────────────────────────
  // Not a guaranteed slot — formatAutomationForMorning() returns "" for
  // routine automation state (a recurring reminder simply having been sent
  // but not yet confirmed is not, by itself, briefing-worthy).
  const slotAutomation = automationDigest
    ? formatAutomationForMorning(automationDigest)
    : "";

  // ── GREETING (built last so it can reference what's open) ────────────────
  const hasAnything = !!(slotUrgent || slotWaiting || slotAutomation || slotNeedsYou);
  const frame = hasAnything ? " Here's what needs attention." : "";
  const slotGreeting = name ? `${greeting} ${name}.${frame}` : `${greeting}.${frame}`;

  // ── CLOSE ─────────────────────────────────────────────────────────────────
  const hasOpen =
    brief.waitingOn.length > 0 ||
    brief.needsAttention.length > 0 ||
    brief.overdueItems.length > 0 ||
    !!(needsYou && needsYou.length > 0);
  const slotClose = hasOpen
    ? "Everything else is on track."
    : "You're clear for the rest of the day.";

  // ── PRIORITY SLOT SELECTION ───────────────────────────────────────────────
  // Collect all candidate sentences with priority and speech-order weights.
  // Select top-priority candidates (max is a ceiling, not a target — an item
  // with nothing to say simply contributes no candidate), then re-sort by
  // speech order for natural delivery.
  //
  // Priority (lower = must include):
  //   0 greeting  1 urgent  1 needsYou  2 waiting  3 automation  4 calendar
  //   5 close  6 completions
  //
  // Speech order (lower = spoken first):
  //   greeting(0) needsYou(1) urgent(2) completions(3) waiting(4) calendar(5)
  //   automation(6) close(7)

  interface PriSlot { s: string; pri: number; ord: number; }
  const candidates: PriSlot[] = [
    { s: slotGreeting,    pri: 0, ord: 0 },
    { s: slotNeedsYou,    pri: 1, ord: 1 },
    { s: slotUrgent,      pri: 1, ord: 2 },
    { s: slotWaiting,     pri: 2, ord: 4 },
    { s: slotAutomation,  pri: 3, ord: 6 },
    { s: slotCalendar,    pri: 4, ord: 5 },
    { s: slotClose,       pri: 5, ord: 7 },
    { s: slotCompletions, pri: 6, ord: 3 },
  ].filter(c => c.s);

  // A genuine owner-decision item is never silently cut for space — the
  // ceiling flexes by one only when Needs You is present, matching every
  // other tested case (no Needs You) byte-for-byte.
  const maxSlots = slotNeedsYou ? 7 : 6;
  const selected = candidates
    .sort((a, b) => a.pri - b.pri)
    .slice(0, maxSlots)
    .sort((a, b) => a.ord - b.ord);

  return selected.map(c => c.s).join(" ");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// taskLabel, LABEL_PATTERNS, LEADING_VERB, stripLeadingVocative: see
// shared/carson-morning-brief-classifier.js — imported and re-exported
// above, pure relocation, no behavior change.

// Alias so callers that used cleanDesc still work during migration.
function cleanDesc(raw: string, assigneeName?: string | null): string {
  return taskLabel(raw, assigneeName);
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

// Common household action verbs, mapped to their gerund form, so a
// completion can be spoken as a natural outcome ("finished cleaning the
// kitchen") instead of a raw database-lifecycle event ("confirmed clean the
// kitchen" / a mislabeled category). Deliberately small and additive — any
// description not starting with one of these falls back to taskLabel()'s
// existing keyword/noun categorization, unchanged.
const GERUND_VERBS: Record<string, string> = {
  clean: "cleaning", wash: "washing", fix: "fixing", prepare: "preparing",
  organize: "organizing", tidy: "tidying", water: "watering", walk: "walking",
  feed: "feeding", call: "calling", empty: "emptying", finish: "finishing",
  cook: "cooking", pack: "packing", vacuum: "vacuuming",
};

export interface CompletionPhrase {
  text: string;
  /** true when text is a gerund verb phrase ("cleaning the kitchen"); false when it's a taskLabel() noun/category. */
  isGerund: boolean;
}

/**
 * Canonical completion-outcome phrase, shared by Morning Brief and Night
 * Sweep so a completed task is described the same way in both.
 */
export function buildCompletionPhrase(rawDescription: string, assigneeName?: string | null): CompletionPhrase {
  const trimmed = rawDescription.trim().replace(/[.!?]+$/, "").trim();
  const firstWord = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";
  const gerund = GERUND_VERBS[firstWord];
  if (gerund) {
    const rest = trimmed.slice(firstWord.length).trim();
    return { text: rest ? `${gerund} ${rest}` : gerund, isGerund: true };
  }
  return { text: taskLabel(rawDescription, assigneeName), isGerund: false };
}

function buildCompletionSentenceV3(t: Task): string {
  const assignee = t.assigned_to?.trim() ?? "";
  const isDelegated =
    t.type === "delegation" ||
    t.type === "followup" ||
    (!!assignee && assignee.toLowerCase() !== "me");
  const phrase = buildCompletionPhrase(t.description, t.assigned_to);
  if (isDelegated && assignee) {
    if (!phrase.text) return `${cap(assignee)} confirmed an open item.`;
    return phrase.isGerund
      ? `${cap(assignee)} finished ${phrase.text}.`
      : `${cap(assignee)} confirmed ${phrase.text}.`;
  }
  if (!phrase.text) return "One item was completed.";
  return phrase.isGerund ? `You finished ${phrase.text}.` : `You completed ${phrase.text}.`;
}
