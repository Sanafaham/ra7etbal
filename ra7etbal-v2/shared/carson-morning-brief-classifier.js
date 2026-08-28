/**
 * Server/browser-safe task-attention classification logic.
 *
 * PURE RELOCATION from src/lib/morning-brief.ts and src/lib/reminder-time.ts
 * (2026-08-28, Second Brain typed hard-grounding slice) — no behavior change.
 * Moved here specifically because src/lib/morning-brief.ts also imports
 * calendar.ts and automation-context.ts at module scope (for the separate
 * buildMorningBriefSpoken() function), both of which import the browser-only
 * Supabase singleton and cannot be loaded from a Vercel serverless function.
 * buildMorningBrief() itself has zero such dependency — only this file's
 * own contents plus a plain Task[] array.
 *
 * src/lib/morning-brief.ts and src/lib/reminder-time.ts re-export from here
 * so every existing caller keeps its exact current import path and behavior.
 */

// ── isReminderOverdue ─────────────────────────────────────────────────────
// DELIBERATE EXCEPTION, not a relocation: src/lib/reminder-time.ts keeps its
// own original copy of this function — do not remove it or make that file
// import from here. reminder-time.ts has a protected, tested zero-import
// invariant (reminder-time.test.ts) that a shared-module import would
// violate. This copy exists only so buildMorningBrief() below (which does
// need to run server-side) has it available without pulling in
// reminder-time.ts. Parity between the two copies is guarded by
// src/lib/reminder-time-shared-parity.test.ts — update both together.
export function isReminderOverdue(value, now = new Date()) {
  if (!value) return false;
  const due = new Date(value);
  return !Number.isNaN(due.getTime()) && due.getTime() < now.getTime();
}

// ── formatReminderDue ─────────────────────────────────────────────────────
// Same DELIBERATE EXCEPTION as isReminderOverdue above (2026-08-28,
// structured Second Brain operational evidence) — duplicated, not imported,
// because reminder-time.ts's zero-import invariant means it cannot be
// imported from here, and this file cannot be imported from reminder-time.ts
// either. Needed so evidence items carry a human dueDescription without a
// new date-math implementation. Parity guarded by
// src/lib/reminder-time-shared-parity.test.ts — update both together.
export function formatReminderDue(value, now = new Date()) {
  if (!value) return null;
  const due = new Date(value);
  if (Number.isNaN(due.getTime())) return null;

  const diffMs = due.getTime() - now.getTime();
  if (diffMs < 0) return formatOverdue(diffMs);

  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 60) return `Due in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;

  const hours = Math.ceil(diffMs / 3_600_000);
  if (isSameLocalDay(due, now) && hours <= 3) {
    return `Due in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }

  if (isSameLocalDay(due, now)) {
    return `Due today at ${formatTime(due)}`;
  }

  if (isTomorrow(due, now)) {
    return `Tomorrow at ${formatTime(due)}`;
  }

  if (isWithinNextSixDays(due, now)) {
    return `${formatWeekday(due)} at ${formatTime(due)}`;
  }

  return `${formatDate(due, now)} at ${formatTime(due)}`;
}

function formatOverdue(diffMs) {
  const overdueMs = Math.abs(diffMs);
  const minutes = Math.floor(overdueMs / 60_000);
  if (minutes < 60) {
    const value = Math.max(1, minutes);
    return `Overdue by ${value} ${value === 1 ? "minute" : "minutes"}`;
  }
  const hours = Math.floor(overdueMs / 3_600_000);
  if (hours < 24) {
    return `Overdue by ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const days = Math.floor(overdueMs / 86_400_000);
  return `Overdue by ${days} ${days === 1 ? "day" : "days"}`;
}

function isTomorrow(date, now) {
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  return isSameLocalDay(date, tomorrow);
}

function isWithinNextSixDays(date, now) {
  const start = startOfLocalDay(now).getTime();
  const target = startOfLocalDay(date).getTime();
  const days = Math.floor((target - start) / 86_400_000);
  return days > 1 && days <= 6;
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatTime(date) {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatWeekday(date) {
  return date.toLocaleDateString(undefined, { weekday: "long" });
}

function formatDate(date, now = new Date()) {
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

// ── isSameLocalDay (moved verbatim from morning-brief.ts) ───────────────────
export function isSameLocalDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// ── getDateValue (moved verbatim from morning-brief.ts) ─────────────────────
export function getDateValue(value) {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
}

// ── buildRisks (moved verbatim from morning-brief.ts) ────────────────────────
export function buildRisks(waitingOn, nowMs) {
  const risks = [];
  const MS_48H = 48 * 60 * 60 * 1000;
  const MS_72H = 72 * 60 * 60 * 1000;

  const perPerson = new Map();
  for (const t of waitingOn) {
    const name = t.assigned_to?.trim();
    if (!name) continue;
    const bucket = perPerson.get(name) ?? [];
    bucket.push(t);
    perPerson.set(name, bucket);
  }

  const bottleneckNames = new Set();
  for (const [name, tasks] of perPerson.entries()) {
    if (tasks.length >= 3) {
      bottleneckNames.add(name);
      risks.push({
        task: tasks[0],
        reason: `${tasks.length} tasks waiting on ${name}`,
      });
    }
  }

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

  return risks.slice(0, 3);
}

// ── buildMorningBrief (moved verbatim from morning-brief.ts) ────────────────
export function buildMorningBrief(tasks, _people, now = new Date(), routineAutomationTaskIds) {
  const active = tasks.filter((t) => t.archived_at == null);
  const nowMs = now.getTime();

  const overdueItems = active.filter((t) => {
    if (t.status !== "pending") return false;
    if (routineAutomationTaskIds?.has(t.id)) return false;
    if (t.type === "reminder" && isReminderOverdue(t.due_at, now)) return true;
    return false;
  });
  const overdueIds = new Set(overdueItems.map((t) => t.id));

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
      const aEsc = a.escalated_at != null ? 0 : 1;
      const bEsc = b.escalated_at != null ? 0 : 1;
      if (aEsc !== bEsc) return aEsc - bEsc;
      return getDateValue(a.created_at) - getDateValue(b.created_at);
    });
  const waitingIds = new Set(waitingOn.map((t) => t.id));

  const needsAttention = active.filter((t) => {
    if (t.status !== "pending") return false;
    if (overdueIds.has(t.id)) return false;
    if (waitingIds.has(t.id)) return false;
    if (routineAutomationTaskIds?.has(t.id)) return false;

    if (t.type === "reminder" && t.due_at) {
      const due = new Date(t.due_at);
      return !isReminderOverdue(t.due_at, now) && isSameLocalDay(due, now);
    }

    const assignee = t.assigned_to?.trim().toLowerCase();
    return !assignee || assignee === "me";
  });

  const recentCutoff = new Date(nowMs - 24 * 60 * 60 * 1000);
  const recentCompletions = tasks
    .filter((t) => {
      if (t.status !== "done" || !t.confirmed_at) return false;
      const confirmedAt = new Date(t.confirmed_at);
      return confirmedAt >= recentCutoff && confirmedAt <= now;
    })
    .sort((a, b) => new Date(b.confirmed_at).getTime() - new Date(a.confirmed_at).getTime());

  const risks = buildRisks(waitingOn, nowMs);

  return { needsAttention, waitingOn, overdueItems, recentCompletions, risks };
}

// ── taskLabel (moved verbatim from morning-brief.ts) ─────────────────────────
const LABEL_PATTERNS = [
  [/\bcat food\b/, "cat food task"],
  [/\bflower|bouquet/, "flowers request"],
  [/\bcar\b|driver|pick.?up|drop.?off/, "car task"],
  [/\bdelivery|courier/, "delivery task"],
  [/\bbill|electric|utilities|utility/, "bill task"],
  [/\bgroceries|grocery\b/, "food task"],
  [/\bfood\b/, "food task"],
];

const LEADING_VERB =
  /^(check and make sure|make sure|please|order|remind|ask|tell|confirm|have|message|send|check|follow up on|follow up|get)\s+/i;

function stripLeadingVocative(s, assigneeName) {
  const name = assigneeName?.trim();
  if (!name) return s;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return s.replace(new RegExp(`^${escaped},\\s+`, "i"), "");
}

export function taskLabel(raw, assigneeName) {
  const lower = raw.trim().toLowerCase();

  for (const [pattern, label] of LABEL_PATTERNS) {
    if (pattern.test(lower)) return label;
  }

  let s = raw.trim().replace(/[.!?]+$/, "").trim();
  s = stripLeadingVocative(s, assigneeName);
  s = s.replace(LEADING_VERB, "").trim();
  s = s.charAt(0).toLowerCase() + s.slice(1);

  if (s.length <= 35) return s;
  const cut = s.slice(0, 35);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 10 ? cut.slice(0, lastSpace) : cut).trimEnd();
}
