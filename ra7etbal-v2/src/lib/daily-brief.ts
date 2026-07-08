import { formatReminderDue, isReminderOverdue } from "./reminder-time";
import { isQualityOwnerReviewStatus } from "./quality-lifecycle";
import type { Task } from "../types/task";

export interface DailyBrief {
  needsAttention: Task[];
  waitingOnOthers: Task[];
  later: Task[];
  /** Legacy alias for Home/Actions until those screens move to needsAttention. */
  needsYou: Task[];
  /** Legacy alias for Home/Actions until those screens move to waitingOnOthers. */
  waiting: Task[];
  /** Legacy bucket for Home/Actions until those screens move to later. */
  done: Task[];
  summary: DailyBriefSummary;
}

export interface DailyBriefSummary {
  paragraph: string;
  headline: string;
  lines: string[];
}

export function buildDailyBrief(tasks: Task[], now = new Date()): DailyBrief {
  const activeTasks = tasks.filter((task) => task.archived_at == null);
  const waitingIds = new Set(
    activeTasks.filter((task) => isWaitingTask(task)).map((task) => task.id),
  );

  const needsAttention = activeTasks
    .filter((task) => task.status !== "done")
    .filter((task) => isNeedsYouTask(task, waitingIds, now))
    .sort((a, b) => getNeedsYouSortValue(a, now) - getNeedsYouSortValue(b, now));

  const waitingOnOthers = activeTasks
    .filter((task) => isWaitingTask(task))
    .sort((a, b) => getDateValue(b.created_at) - getDateValue(a.created_at));

  const later = activeTasks
    .filter((task) => isLaterTask(task, needsAttention, waitingOnOthers))
    .sort((a, b) => getLaterSortValue(a) - getLaterSortValue(b));

  const done = activeTasks
    .filter((task) => task.status === "done")
    .filter((task) => isDoneToday(task, now) || task.confirmed_at == null)
    .sort((a, b) => getDoneSortValue(b) - getDoneSortValue(a));

  return {
    needsAttention,
    waitingOnOthers,
    later,
    needsYou: needsAttention,
    waiting: waitingOnOthers,
    done,
    summary: buildBriefSummary(needsAttention, waitingOnOthers, later, now),
  };
}

function buildBriefSummary(
  needsAttention: Task[],
  waitingOnOthers: Task[],
  later: Task[],
  now: Date,
): DailyBriefSummary {
  // --- State headline always comes first so Home hero shows status, not task text ---
  let stateHeadline: string;
  if (needsAttention.length === 0) stateHeadline = "You're clear tonight.";
  else if (needsAttention.length === 1) stateHeadline = "One thing needs your attention.";
  else stateHeadline = "A few things need your attention.";

  const sentences: string[] = [stateHeadline];

  // --- Detail sentences ---
  if (needsAttention.length === 1) {
    // Push the specific item as a supporting line
    const detail = buildAttentionSentence(needsAttention[0], now);
    sentences.push(detail);
  } else if (needsAttention.length >= 2) {
    // First two items become supporting lines in Home
    needsAttention.slice(0, 2).forEach((task) => {
      const desc = briefDesc(task.description);
      if (desc) sentences.push(`${desc}.`);
    });
  }

  // --- Waiting on others ---
  if (waitingOnOthers.length === 1) {
    sentences.push(buildWaitingSentence(waitingOnOthers[0]));
  } else if (waitingOnOthers.length === 2) {
    const names = waitingOnOthers
      .map((t) => capitalize(t.assigned_to?.trim() ?? ""))
      .filter(Boolean);
    if (names.length === 2) {
      sentences.push(`Waiting on ${names[0]} and ${names[1]}.`);
    } else {
      sentences.push("Two items are waiting on others.");
    }
  } else if (waitingOnOthers.length > 2) {
    sentences.push(
      `${formatBriefCount(waitingOnOthers.length)} items are waiting on others.`,
    );
  }

  // --- Calm close ---
  // Only show when there are enough active items that the reassurance is meaningful (≥ 3 total).
  const totalActive = needsAttention.length + waitingOnOthers.length + later.length;
  if (totalActive >= 3) {
    sentences.push("Everything else is on track.");
  }

  const paragraph = sentences.join(" ");
  const [headline = paragraph, ...lines] = sentences;
  return { paragraph, headline, lines };
}

function buildAttentionSentence(task: Task, now: Date): string {
  const desc = briefDesc(task.description);
  if (!desc) return "One thing needs your attention.";
  if (task.type === "reminder" && task.due_at) {
    if (isReminderOverdue(task.due_at, now)) return `${desc} is overdue.`;
    return `${desc} today.`;
  }
  return `${desc} needs your attention.`;
}

function buildWaitingSentence(task: Task): string {
  const name = capitalize(task.assigned_to?.trim() ?? "");
  const desc = cleanForWaiting(task.description);
  if (name && desc) return `Waiting on ${name} to confirm ${desc}.`;
  if (name) return `Waiting on ${name}.`;
  return "One item is waiting on someone.";
}

/** Strip trailing punctuation, capitalize, truncate to 45 chars. */
function briefDesc(raw: string): string {
  const s = capitalize(raw.trim().replace(/[.!?]+$/, "").trim());
  return s.length > 45 ? s.slice(0, 45).trimEnd() + "…" : s;
}

/**
 * For waiting sentences: strip leading action verbs so
 * "Confirm dinner" → "dinner" and the sentence reads naturally:
 * "Grace hasn't confirmed dinner yet."
 */
function cleanForWaiting(raw: string): string {
  const desc = briefDesc(raw);
  const cleaned = desc.replace(
    /^(Confirm|Ask|Tell|Remind|Have|Message|Send|Check|Follow up on|Follow up|Get)\s+/i,
    "",
  );
  if (cleaned === desc) return desc;
  return cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
}

function capitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function isNeedsYouTask(task: Task, waitingIds: Set<string>, now: Date): boolean {
  if (task.status === "cancelled") return true;
  if (isWaitingInterventionTask(task)) return true;

  if (task.type === "reminder") {
    return isReminderOverdue(task.due_at, now) || isDueToday(task, now);
  }

  if (waitingIds.has(task.id)) return false;
  return isOwnerTask(task);
}

function isWaitingTask(task: Task): boolean {
  if (task.status === "done" || task.status === "cancelled") return false;
  // Only proof states that genuinely need owner input leave Waiting. Clear
  // proof failures stay operational: Carson keeps working with the assignee.
  if (isQualityOwnerReviewStatus(task.quality_review_status)) {
    return false;
  }
  if (task.needs_follow_up) return true;
  if (task.type === "delegation" && task.assigned_to) return true;
  return task.type === "followup";
}

function isWaitingInterventionTask(task: Task): boolean {
  if (task.type !== "delegation" && task.type !== "followup") return false;
  if (task.status === "cancelled") return true;
  return isQualityOwnerReviewStatus(task.quality_review_status);
}

function isLaterTask(
  task: Task,
  needsAttention: Task[],
  waitingOnOthers: Task[],
): boolean {
  if (needsAttention.some((item) => item.id === task.id)) return false;
  if (waitingOnOthers.some((item) => item.id === task.id)) return false;
  if (task.status === "done" || task.status === "cancelled") return false;
  return true;
}

function isOwnerTask(task: Task): boolean {
  const assignee = task.assigned_to?.trim().toLowerCase();
  return !assignee || assignee === "me";
}

function isDueToday(task: Task, now: Date): boolean {
  if (!task.due_at) return false;
  const due = new Date(task.due_at);
  if (Number.isNaN(due.getTime())) return false;
  return isSameLocalDay(due, now);
}

function isDoneToday(task: Task, now: Date): boolean {
  if (!task.confirmed_at) return false;
  const confirmed = new Date(task.confirmed_at);
  if (Number.isNaN(confirmed.getTime())) return false;
  return isSameLocalDay(confirmed, now);
}

function getNeedsYouSortValue(task: Task, now: Date): number {
  if (task.type === "reminder" && task.due_at) {
    const due = getDateValue(task.due_at);
    if (isReminderOverdue(task.due_at, now)) return due;
    return 10_000_000_000_000 + due;
  }

  if (task.status === "cancelled") return 20_000_000_000_000 + getDateValue(task.created_at);
  return 30_000_000_000_000 - getDateValue(task.created_at);
}

function getDoneSortValue(task: Task): number {
  return getDateValue(task.confirmed_at ?? task.created_at);
}

function getLaterSortValue(task: Task): number {
  if (task.type === "reminder" && task.due_at) return getDateValue(task.due_at);
  return 10_000_000_000_000 - getDateValue(task.created_at);
}

function getDateValue(value: string | null): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function formatBriefCount(count: number): string {
  if (count === 1) return "One";
  if (count === 2) return "Two";
  if (count === 3) return "Three";
  return String(count);
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// ---------------------------------------------------------------------------
// Carson spoken brief
// ---------------------------------------------------------------------------

/**
 * Build a ready-to-speak daily brief paragraph for Carson.
 *
 * Covers the four chief-of-staff categories:
 *   1. Needs Attention — overdue reminders + items requiring owner action
 *   2. Waiting on Others — delegated tasks not yet confirmed
 *   3. Completed Recently — tasks confirmed done today
 *   4. Today's Reminders — personal reminders due today (not yet overdue)
 *
 * Returns a conversational spoken paragraph. Carson should read it verbatim
 * when the user asks for their brief or asks "what needs my attention?"
 */
export function buildCarsonSpokenBrief(
  brief: DailyBrief,
  displayName?: string | null,
  now = new Date(),
): string {
  const name = displayName?.trim() || null;
  const hour = now.getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const open = name ? `${greeting} ${name}.` : `${greeting}.`;

  const sentences: string[] = [open];

  // ── 1. Needs Attention ──────────────────────────────────────────────────
  const overdueReminders = brief.needsAttention.filter(
    (t) => t.type === "reminder" && isReminderOverdue(t.due_at, now),
  );
  const nonReminderAttention = brief.needsAttention.filter(
    (t) => t.type !== "reminder",
  );

  if (overdueReminders.length === 1) {
    const t = overdueReminders[0];
    sentences.push(`Your reminder about "${spokenDesc(t.description)}" is overdue.`);
  } else if (overdueReminders.length > 1) {
    sentences.push(
      `${spokenCount(overdueReminders.length)} of your reminders are overdue.`,
    );
  }

  if (nonReminderAttention.length === 1) {
    const t = nonReminderAttention[0];
    sentences.push(`"${spokenDesc(t.description)}" needs your attention.`);
  } else if (nonReminderAttention.length === 2) {
    sentences.push(
      `"${spokenDesc(nonReminderAttention[0].description)}" and ` +
        `"${spokenDesc(nonReminderAttention[1].description)}" need your attention.`,
    );
  } else if (nonReminderAttention.length > 2) {
    sentences.push(
      `${spokenCount(nonReminderAttention.length)} items need your attention.`,
    );
  }

  if (
    overdueReminders.length === 0 &&
    nonReminderAttention.length === 0
  ) {
    sentences.push("Nothing urgent needs your attention right now.");
  }

  // ── 2. Waiting on Others ────────────────────────────────────────────────
  const waiting = brief.waitingOnOthers;
  if (waiting.length === 1) {
    const t = waiting[0];
    const who = capitalize(t.assigned_to?.trim() ?? "");
    const what = cleanSpokenDesc(t.description);
    if (who && what) {
      sentences.push(`You're waiting on ${who} to confirm ${what}.`);
    } else if (who) {
      sentences.push(`You're waiting on ${who}.`);
    } else {
      sentences.push("One item is waiting on someone.");
    }
  } else if (waiting.length === 2) {
    const names = waiting
      .map((t) => capitalize(t.assigned_to?.trim() ?? ""))
      .filter(Boolean);
    if (names.length === 2) {
      sentences.push(`You're waiting on ${names[0]} and ${names[1]}.`);
    } else {
      sentences.push("Two items are waiting on others.");
    }
  } else if (waiting.length > 2) {
    sentences.push(
      `You're waiting on ${spokenCount(waiting.length)} people to confirm tasks.`,
    );
  }

  // ── 3. Completed Today ──────────────────────────────────────────────────
  const recentDone = brief.done.slice(0, 2);
  if (recentDone.length === 1) {
    sentences.push(buildDoneLineSingle(recentDone[0]));
  } else if (recentDone.length === 2) {
    sentences.push(buildDoneLineSingle(recentDone[0]));
    sentences.push(buildDoneLineSingle(recentDone[1]));
  }

  // ── 4. Today's Reminders (due today, not overdue) ───────────────────────
  const allNonDone = [...brief.needsAttention, ...brief.later];
  const todayReminders = allNonDone.filter(
    (t) =>
      t.type === "reminder" &&
      t.status === "pending" &&
      !isReminderOverdue(t.due_at, now) &&
      isDueToday(t, now),
  );

  if (todayReminders.length === 1) {
    const t = todayReminders[0];
    const dueLabel = t.due_at ? formatReminderDue(t.due_at, now) : null;
    const timeStr = dueLabel ? ` ${dueLabel}` : " today";
    sentences.push(
      `You have a reminder for "${spokenDesc(t.description)}"${timeStr}.`,
    );
  } else if (todayReminders.length > 1) {
    sentences.push(
      `You have ${spokenCount(todayReminders.length)} reminders coming up today.`,
    );
  }

  // ── Close ────────────────────────────────────────────────────────────────
  const totalActive =
    brief.needsAttention.length + brief.waitingOnOthers.length;
  if (totalActive === 0 && brief.done.length === 0 && todayReminders.length === 0) {
    sentences.push("Your slate is clean.");
  } else if (
    overdueReminders.length === 0 &&
    nonReminderAttention.length === 0 &&
    todayReminders.length === 0
  ) {
    sentences.push("Nothing urgent beyond that.");
  }

  return sentences.join(" ");
}

/**
 * Build one completed-item sentence.
 *
 * Delegated tasks (type "delegation" or "followup", or any task with an
 * assignee other than the owner) credit the person who confirmed:
 *   "Grace confirmed: Call Sana in one minute."
 *
 * Personal reminders credit the owner:
 *   "You completed 'call the dentist'."
 */
function buildDoneLineSingle(t: Task): string {
  const assignee = t.assigned_to?.trim() ?? "";
  const isDelegated =
    t.type === "delegation" ||
    t.type === "followup" ||
    (!!assignee && assignee.toLowerCase() !== "me");

  if (isDelegated && assignee) {
    const who = capitalize(assignee);
    return `${who} confirmed: ${spokenDesc(t.description)}.`;
  }

  return `You completed "${spokenDesc(t.description)}".`;
}

/** Short display version of a task description for speech. Max 40 chars, no trailing punctuation. */
function spokenDesc(raw: string): string {
  const s = raw.trim().replace(/[.!?]+$/, "").trim();
  return s.length > 40 ? s.slice(0, 40).trimEnd() + "…" : s;
}

/**
 * For waiting/completed sentences: strip leading action verbs so
 * "Confirm the grocery run" → "the grocery run"
 * and the sentence reads naturally: "You're waiting on Grace to confirm the grocery run."
 */
function cleanSpokenDesc(raw: string): string {
  const desc = spokenDesc(raw);
  const cleaned = desc.replace(
    /^(Confirm|Ask|Tell|Remind|Have|Message|Send|Check|Follow up on|Follow up|Get)\s+/i,
    "",
  );
  if (cleaned === desc) return desc.charAt(0).toLowerCase() + desc.slice(1);
  return cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
}

function spokenCount(n: number): string {
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  return n < words.length ? words[n] : String(n);
}
