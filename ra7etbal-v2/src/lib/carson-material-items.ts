/**
 * carson-material-items.ts
 *
 * Item-level tracking for what proactive-brief content Carson has already
 * spoken today, so a follow-up session can surface genuinely new or changed
 * information without repeating unchanged items and without silently
 * dropping everything (the PR #24 regression this module fixes).
 *
 * Deliberately does NOT touch morning-brief.ts / night-sweep.ts internals —
 * this reads the same underlying tasks/automationDigest/calendarEvents data
 * those modules already consume, independently, so their existing,
 * protected spoken-brief output is completely unaffected.
 *
 * State model: a stable id (task id, `automation:<automations.id>`, or
 * `calendar:<event id>`) plus a compact signature string capturing only the
 * mutable fields that matter for "has this changed" — never full rendered
 * prose, so unrelated wording tweaks never look like a material change.
 */

import type { Task } from "../types/task";
import type { Person } from "../types/person";
import type { CalendarEvent } from "./calendar";
import type { AutomationDigest } from "./automation-context";
import type { OpenStaffEscalation } from "../types/staff-message";
import { isReminderOverdue } from "./reminder-time";
import { buildMorningBrief, isMaterialWaitingItem } from "./morning-brief";
import { MORNING_START_HOUR } from "./night-sweep";

export interface MaterialItem {
  /** Stable identifier — task id, `automation:<id>`, or `calendar:<id>`. */
  id: string;
  /** Compact state fingerprint — changes only when something material changes. */
  signature: string;
  /** Short, standalone spoken clause for this one item (ends with a period). */
  text: string;
}

export interface MaterialDiffResult {
  /** Items that are new (no prior signature) or whose signature changed. */
  changed: MaterialItem[];
  /** Signature map to persist as "already surfaced" for next time. */
  nextMap: Record<string, string>;
}

/** Minimal key-value store shape — `window.localStorage` already satisfies this. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type BriefKind = "morning" | "night";

/**
 * Local YYYY-MM-DD anchor date for a brief-kind's "first session today" key.
 *
 * Night Sweep now stays eligible past midnight, up to MORNING_START_HOUR
 * (see night-sweep.ts) — a 1 AM session is still the same "night" as the
 * 11 PM session before it. Without this, the plain calendar-date flip at
 * midnight would make that 1 AM session look like a brand-new first
 * session and replay the full Night Sweep. Morning Brief is unaffected —
 * it always anchors to the current calendar date.
 */
export function resolveBriefAnchorDateStr(kind: BriefKind, now: Date): string {
  const isLateNightContinuation = kind === "night" && now.getHours() < MORNING_START_HOUR;
  const anchor = isLateNightContinuation ? new Date(now.getTime() - 86_400_000) : now;
  return `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, "0")}-${String(anchor.getDate()).padStart(2, "0")}`;
}

/**
 * Compares this session's material items against what was last surfaced.
 * An item that disappears (present in lastSurfaced, absent from current) is
 * simply dropped from nextMap — it is never treated as a "change" on its
 * own, so it cannot cause any other, still-unchanged item to be re-spoken.
 */
export function diffMaterialItems(
  current: MaterialItem[],
  lastSurfaced: Record<string, string> | null | undefined,
): MaterialDiffResult {
  const lastMap = lastSurfaced ?? {};
  const changed: MaterialItem[] = [];
  const nextMap: Record<string, string> = {};

  for (const item of current) {
    nextMap[item.id] = item.signature;
    if (lastMap[item.id] !== item.signature) changed.push(item);
  }

  return { changed, nextMap };
}

export interface OpeningMaterialStateResult {
  isFirstSessionToday: boolean;
  /**
   * New/changed items to surface this session. Always empty when
   * isFirstSessionToday — the full brief already covers everything.
   */
  changed: MaterialItem[];
}

/**
 * Resolves both "is this the first session today for this brief kind" and
 * "which material items are new/changed since they were last surfaced" —
 * reading and persisting state through the given key-value store.
 *
 * Morning ("morning") and Night Sweep ("night") use entirely separate keys
 * (`carson_brief_date_<kind>`, `carson_material_<kind>`), so an earlier
 * Morning Brief session can never mark the day's first Night Sweep as a
 * "follow-up" session, and vice versa.
 */
export function resolveOpeningMaterialState(
  kind: BriefKind,
  todayStr: string,
  materialItems: MaterialItem[],
  storage: KeyValueStore,
): OpeningMaterialStateResult {
  const briefDateKey = `carson_brief_date_${kind}`;
  const materialKey = `carson_material_${kind}`;

  const isFirstSessionToday = storage.getItem(briefDateKey) !== todayStr;
  if (isFirstSessionToday) {
    storage.setItem(briefDateKey, todayStr);
  }

  let lastMap: Record<string, string> | null = null;
  try {
    const raw = storage.getItem(materialKey);
    lastMap = raw ? (JSON.parse(raw) as Record<string, string>) : null;
  } catch {
    lastMap = null;
  }

  const { changed, nextMap } = diffMaterialItems(materialItems, lastMap);
  try {
    storage.setItem(materialKey, JSON.stringify(nextMap));
  } catch {
    // Best-effort persistence — worst case, a later session re-surfaces an
    // already-heard item, never worse than the pre-fix "always suppressed" bug.
  }

  return { isFirstSessionToday, changed: isFirstSessionToday ? [] : changed };
}

function shortDesc(raw: string): string {
  const s = raw.trim().replace(/[.!?]+$/, "").trim();
  if (s.length <= 40) return s;
  const cut = s.slice(0, 40);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 10 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

function cap(s: string | null | undefined): string {
  const t = s?.trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
}

// ── Morning Brief ────────────────────────────────────────────────────────

export function deriveMorningBriefMaterialItems(
  tasks: Task[],
  people: Person[],
  automationDigest: AutomationDigest | undefined,
  calendarEvents: CalendarEvent[] | undefined,
  now = new Date(),
  needsYou: OpenStaffEscalation[] = [],
): MaterialItem[] {
  const items: MaterialItem[] = [];
  const brief = buildMorningBrief(tasks, people, now, automationDigest?.routineAutomationTaskIds);

  for (const t of brief.overdueItems) {
    items.push({
      id: t.id,
      signature: `overdue:${t.due_at ?? ""}`,
      text: `Your reminder — ${shortDesc(t.description)} — is overdue.`,
    });
  }

  for (const t of brief.needsAttention) {
    if (t.type === "reminder") {
      items.push({
        id: t.id,
        signature: `due_today:${t.due_at ?? ""}`,
        text: `You have a reminder today — ${shortDesc(t.description)}.`,
      });
    } else {
      items.push({
        id: t.id,
        signature: `personal:${t.status}`,
        text: `One task needs your attention — ${shortDesc(t.description)}.`,
      });
    }
  }

  // Only briefing-worthy waiting items become material — a routine, fresh
  // waiting item is never spoken (see morning-brief.ts's slotWaiting), so it
  // must not leak into follow-up sessions via this "new/changed" path either.
  for (const t of brief.waitingOn) {
    if (!isMaterialWaitingItem(t, now)) continue;
    const who = cap(t.assigned_to);
    items.push({
      id: t.id,
      signature: `waiting:${t.escalated_at ?? "stale"}`,
      text: t.escalated_at
        ? who
          ? `${who} still hasn't confirmed — ${shortDesc(t.description)}.`
          : `One item hasn't received a response — ${shortDesc(t.description)}.`
        : who
          ? `${who} still hasn't confirmed after several days — ${shortDesc(t.description)}.`
          : `One item has been waiting for several days — ${shortDesc(t.description)}.`,
    });
  }

  if (automationDigest) {
    // "pending" (sent, not yet confirmed) is deliberately excluded — see
    // formatAutomationForMorning's doc comment for the full rationale.
    // Only failed/escalated (genuine consequence) become material.
    for (const r of automationDigest.failed) {
      items.push({
        id: `automation:${r.id}`,
        signature: "run:failed",
        text: `The ${r.automationTitle} automation failed to send.`,
      });
    }
    for (const r of automationDigest.escalated) {
      items.push({
        id: `automation:${r.id}`,
        signature: "run:escalated",
        text: `The ${r.automationTitle} automation has been escalated.`,
      });
    }
    // Owner-only reminders — mirrors formatAutomationForMorning's own filter.
    for (const a of automationDigest.firingToday) {
      if (a.assignee) continue;
      items.push({
        id: `automation:${a.id}`,
        signature: `firing:${a.nextRunAt}`,
        text: `You have a reminder scheduled — ${a.title}.`,
      });
    }
  }

  // Needs You — genuine owner decisions, distinct from Waiting On Others.
  for (const e of needsYou) {
    items.push({
      id: `needs_you:${e.decisionId}`,
      signature: "open",
      text: `One decision needs you — ${cap(e.staffName)} is waiting on an answer.`,
    });
  }

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomStart = new Date(todayStart.getTime() + 86_400_000);
  for (const ev of calendarEvents ?? []) {
    if (!ev.start) continue;
    const d = new Date(ev.start);
    if (Number.isNaN(d.getTime())) continue;
    if (d >= todayStart && d < tomStart) {
      items.push({
        id: `calendar:${ev.id}`,
        signature: `${ev.start}|${ev.title}`,
        text: `You have ${ev.title} on the calendar today.`,
      });
    }
  }

  return items;
}

// ── Night Sweep ──────────────────────────────────────────────────────────

export function deriveNightSweepMaterialItems(
  tasks: Task[],
  automationDigest: AutomationDigest | undefined,
  calendarEvents: CalendarEvent[] | undefined,
  now = new Date(),
  needsYou: OpenStaffEscalation[] = [],
): MaterialItem[] {
  const items: MaterialItem[] = [];
  const active = tasks.filter((t) => t.archived_at == null && t.status === "pending");

  const waitingOn = active.filter((t) => {
    if (t.type === "delegation" && t.assigned_to) return true;
    if (t.type === "followup") return true;
    if (t.needs_follow_up && t.assigned_to) return true;
    return false;
  });
  // Only briefing-worthy waiting items become material — a routine, fresh
  // waiting item is never spoken (see night-sweep.ts's section3 gating), so
  // it must not leak into follow-up sessions via this "new/changed" path.
  for (const t of waitingOn) {
    if (!isMaterialWaitingItem(t, now)) continue;
    const who = cap(t.assigned_to);
    items.push({
      id: t.id,
      signature: `waiting:${t.escalated_at ?? "stale"}`,
      text: t.escalated_at
        ? who
          ? `${who} still hasn't confirmed — ${shortDesc(t.description)}.`
          : `One item hasn't received a response — ${shortDesc(t.description)}.`
        : who
          ? `${who} still hasn't confirmed after several days — ${shortDesc(t.description)}.`
          : `One item has been waiting for several days — ${shortDesc(t.description)}.`,
    });
  }

  for (const t of active) {
    if (t.type === "reminder" && isReminderOverdue(t.due_at, now)) {
      items.push({
        id: t.id,
        signature: `overdue:${t.due_at ?? ""}`,
        text: `Your reminder — ${shortDesc(t.description)} — is still overdue.`,
      });
    }
  }

  if (automationDigest) {
    // "pending" is deliberately excluded — see formatAutomationForNight's
    // doc comment. Only failed/escalated become material.
    for (const r of automationDigest.failed) {
      items.push({
        id: `automation:${r.id}`,
        signature: "run:failed",
        text: `The ${r.automationTitle} automation failed to send.`,
      });
    }
    for (const r of automationDigest.escalated) {
      items.push({
        id: `automation:${r.id}`,
        signature: "run:escalated",
        text: `The ${r.automationTitle} automation has been escalated.`,
      });
    }
  }

  // Needs You — genuine owner decisions, distinct from Waiting On Others.
  for (const e of needsYou) {
    items.push({
      id: `needs_you:${e.decisionId}`,
      signature: "open",
      text: `One decision needs you — ${cap(e.staffName)} is waiting on an answer.`,
    });
  }

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrowStart = new Date(todayStart.getTime() + 86_400_000);
  const dayAfterStart = new Date(tomorrowStart.getTime() + 86_400_000);
  for (const ev of calendarEvents ?? []) {
    if (!ev.start) continue;
    const d = new Date(ev.start);
    if (Number.isNaN(d.getTime())) continue;
    if (d >= tomorrowStart && d < dayAfterStart) {
      items.push({
        id: `calendar:${ev.id}`,
        signature: `${ev.start}|${ev.title}`,
        text: `You have ${ev.title} tomorrow.`,
      });
    }
  }

  return items;
}
