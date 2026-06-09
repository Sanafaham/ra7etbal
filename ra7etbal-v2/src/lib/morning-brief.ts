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
 * Builds the ready-to-speak Morning Brief paragraph for Carson.
 *
 * Called from Home.tsx and used as the `spokenBrief` prop for both
 * ElevenLabsAgentWidget (dynamic variable `daily_brief`) and TextCarsonPanel.
 */
export function buildMorningBriefSpoken(
  tasks: Task[],
  people: Person[],
  displayName?: string | null,
  now = new Date(),
): string {
  const brief = buildMorningBrief(tasks, people, now);
  const name = displayName?.trim() || null;
  const hour = now.getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const sentences: string[] = [name ? `${greeting} ${name}.` : `${greeting}.`];

  const totalAttention = brief.needsAttention.length + brief.overdueItems.length;

  // ── Opening count ────────────────────────────────────────────────────────
  if (totalAttention === 0 && brief.waitingOn.length === 0) {
    sentences.push("Your slate is clear.");
  } else if (totalAttention > 0) {
    const n = spokenCount(totalAttention);
    const noun = totalAttention === 1 ? "thing needs" : "things need";
    sentences.push(`${n} ${noun} your attention today.`);
  }

  // ── 3. Overdue items ─────────────────────────────────────────────────────
  if (brief.overdueItems.length === 1) {
    const t = brief.overdueItems[0];
    if (t.type === "reminder") {
      sentences.push(
        `Your reminder about "${spokenDesc(t.description)}" is overdue.`,
      );
    } else {
      const who = cap(t.assigned_to);
      sentences.push(
        who
          ? `${who} was escalated on "${spokenDesc(t.description)}" and still hasn't confirmed.`
          : "One escalated item is still unresolved.",
      );
    }
  } else if (brief.overdueItems.length > 1) {
    const reminderCount = brief.overdueItems.filter(
      (t) => t.type === "reminder",
    ).length;
    const delegCount = brief.overdueItems.length - reminderCount;
    if (reminderCount > 0 && delegCount > 0) {
      sentences.push(
        `${spokenCount(reminderCount)} overdue ${
          reminderCount === 1 ? "reminder" : "reminders"
        } and ${spokenCount(delegCount)} escalated ${
          delegCount === 1 ? "delegation" : "delegations"
        } need resolution.`,
      );
    } else if (reminderCount > 0) {
      sentences.push(`${spokenCount(reminderCount)} reminders are overdue.`);
    } else {
      sentences.push(
        `${spokenCount(delegCount)} escalated items are still unresolved.`,
      );
    }
  }

  // ── 1. Needs attention ───────────────────────────────────────────────────
  // Reminders are listed individually with their due time so Voice Carson
  // can answer time questions accurately. Other items are grouped.
  const remindersToday = brief.needsAttention.filter((t) => t.type === "reminder");
  const otherAttention = brief.needsAttention.filter((t) => t.type !== "reminder");

  if (remindersToday.length > 0) {
    const items = remindersToday.map((t) => {
      const timeSuffix = spokenTimeSuffix(t.due_at, now);
      return timeSuffix
        ? `${spokenDesc(t.description)} ${timeSuffix}`
        : spokenDesc(t.description);
    });
    const list =
      items.length === 1
        ? items[0]
        : items.length === 2
          ? `${items[0]} and ${items[1]}`
          : `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
    sentences.push(
      remindersToday.length === 1
        ? `Your reminder: ${list}.`
        : `You have ${spokenCount(remindersToday.length)} reminders today: ${list}.`,
    );
  }

  if (otherAttention.length === 1) {
    sentences.push(`"${spokenDesc(otherAttention[0].description)}" also needs your attention.`);
  } else if (otherAttention.length > 1) {
    sentences.push(
      `${spokenCount(otherAttention.length)} other items also need your attention today.`,
    );
  }

  // ── 2. Waiting on others ─────────────────────────────────────────────────
  if (brief.waitingOn.length === 1) {
    const t = brief.waitingOn[0];
    const who = cap(t.assigned_to);
    const what = cleanDesc(t.description);
    if (who && what) {
      sentences.push(`Still waiting on ${who} to confirm ${what}.`);
    } else if (who) {
      sentences.push(`Still waiting on ${who}.`);
    } else {
      sentences.push("One item is waiting on confirmation.");
    }
  } else if (brief.waitingOn.length === 2) {
    const names = [
      ...new Set(
        brief.waitingOn
          .map((t) => cap(t.assigned_to))
          .filter((n): n is string => Boolean(n)),
      ),
    ];
    if (names.length === 2) {
      sentences.push(`Waiting on ${names[0]} and ${names[1]}.`);
    } else if (names.length === 1) {
      sentences.push(`Waiting on ${names[0]} for two things.`);
    } else {
      sentences.push("Two items are waiting on others.");
    }
  } else if (brief.waitingOn.length > 2) {
    sentences.push(
      `You're waiting on ${spokenCount(brief.waitingOn.length)} people to confirm tasks.`,
    );
  }

  // ── 5. Risks & bottlenecks ───────────────────────────────────────────────
  for (const risk of brief.risks.slice(0, 2)) {
    const who = cap(risk.task.assigned_to);
    if (risk.reason.includes("tasks waiting")) {
      sentences.push(
        `${who ?? "Someone"} has multiple tasks waiting — that's a bottleneck worth addressing.`,
      );
    } else if (risk.reason.includes("days")) {
      const what = cleanDesc(risk.task.description);
      sentences.push(
        who && what
          ? `${who} hasn't confirmed ${what} in several days — you may need to follow up directly.`
          : "One task has been pending for several days with no update.",
      );
    } else {
      const what = cleanDesc(risk.task.description);
      sentences.push(
        who && what
          ? `${who} hasn't confirmed ${what} — worth watching.`
          : "One item has been waiting for over two days.",
      );
    }
  }

  // ── 4. Recent completions ────────────────────────────────────────────────
  const completions = brief.recentCompletions.slice(0, 3);
  if (completions.length === 1) {
    sentences.push(buildCompletionSentence(completions[0]));
  } else if (completions.length === 2) {
    const delegatedNames = completions
      .filter(
        (t) =>
          t.assigned_to && t.assigned_to.toLowerCase() !== "me",
      )
      .map((t) => cap(t.assigned_to));
    if (delegatedNames.length === 2) {
      sentences.push(
        `${delegatedNames[0]} and ${delegatedNames[1]} both confirmed their tasks.`,
      );
    } else {
      sentences.push(buildCompletionSentence(completions[0]));
      sentences.push(buildCompletionSentence(completions[1]));
    }
  } else if (completions.length > 2) {
    sentences.push(
      `${spokenCount(completions.length)} tasks were completed in the last 24 hours.`,
    );
  }

  // ── Close ────────────────────────────────────────────────────────────────
  const issueCount =
    brief.needsAttention.length +
    brief.overdueItems.length +
    brief.risks.length;

  if (issueCount === 0 && brief.waitingOn.length === 0 && completions.length === 0) {
    sentences.push("Everything is on track.");
  } else if (issueCount === 0 && brief.waitingOn.length > 0) {
    sentences.push("Nothing needs your direct action right now.");
  } else if (brief.overdueItems.length === 0 && brief.risks.length === 0) {
    sentences.push("Everything else is on track.");
  }

  return sentences.join(" ");
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
