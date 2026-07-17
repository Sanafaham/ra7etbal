/**
 * automation-context.ts
 *
 * Fetches live automation state from Supabase and formats it for Carson.
 *
 * One fetch — three consumers:
 *   1. buildAutomationStatusBlock()   → AUTOMATION STATUS text block for ra7etbal_state
 *   2. formatAutomationForMorning()   → ≤1 spoken sentence for Morning Brief
 *   3. formatAutomationForNight()     → ≤1 spoken sentence for Night Sweep
 *
 * App.tsx calls fetchAutomationDigest() once and passes the result to all three.
 */

import { supabase } from "./supabase";
import { filterSupportedOperationalAutomations, isSupportedOperationalAutomation } from "./automation-support";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AutomationRunSummary {
  automationTitle: string;
  assignee: string | null;
  /** ms elapsed since sent_at */
  sentAgoMs: number;
  isFollowupSent: boolean;
  confirmedAgoMs?: number;
  escalatedAgoMs?: number;
  /** Only set for failed runs — automation_runs.failure_reason. */
  failureReason?: string | null;
}

export interface AutomationScheduleSummary {
  title: string;
  assignee: string | null;
  nextRunAt: string;
}

export interface AutomationDigest {
  /** Sent or follow-up sent — waiting for confirmation (last 48 h) */
  pending: AutomationRunSummary[];
  /** In escalated state (last 48 h) */
  escalated: AutomationRunSummary[];
  /** In failed state (last 48 h) — e.g. WhatsApp delivery failure propagated from the webhook. */
  failed: AutomationRunSummary[];
  /** Confirmed within the last 24 h */
  confirmedToday: AutomationRunSummary[];
  /** Scheduled to fire within the next 24 h */
  firingToday: AutomationScheduleSummary[];
  /** Scheduled to fire between 24 h and 48 h from now (tomorrow) */
  firingTomorrow: AutomationScheduleSummary[];
}

interface AutomationJoinFields {
  title?: string | null;
  automation_type?: string | null;
  assignee_id?: string | null;
  cadence_type?: string | null;
  status?: string | null;
}

interface AutomationRunRowWithJoin {
  automations?: AutomationJoinFields | null;
}

export function isOperationalAutomationRunRow(row: AutomationRunRowWithJoin): boolean {
  return Boolean(row.automations && isSupportedOperationalAutomation(row.automations));
}

const EMPTY_DIGEST: AutomationDigest = {
  pending: [],
  escalated: [],
  failed: [],
  confirmedToday: [],
  firingToday: [],
  firingTomorrow: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// Fetch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Single Supabase fetch that powers all automation context consumers.
 * Returns EMPTY_DIGEST on auth failure or query error (never throws).
 */
export async function fetchAutomationDigest(): Promise<AutomationDigest> {
  const now = new Date();
  const nowMs = now.getTime();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return EMPTY_DIGEST;

  const window48hAgo = new Date(nowMs - 48 * 3_600_000).toISOString();
  const window24hAgo = new Date(nowMs - 24 * 3_600_000).toISOString();
  const window24hFwd = new Date(nowMs + 24 * 3_600_000).toISOString();
  const window48hFwd = new Date(nowMs + 48 * 3_600_000).toISOString();

  // ── Open runs (pending + escalated + failed, last 48 h) ───────────────────
  const { data: openRuns } = await supabase
    .from("automation_runs")
    .select("automation_id, current_state, sent_at, confirmed_at, escalated_at, failure_reason, automations!inner(title, automation_type, assignee_id, cadence_type, status)")
    .in("current_state", ["sent", "followup_sent", "escalated", "failed"])
    .gte("sent_at", window48hAgo)
    .order("sent_at", { ascending: false })
    .limit(20);

  // ── Confirmed runs (last 24 h) ────────────────────────────────────────────
  const { data: confirmedRuns } = await supabase
    .from("automation_runs")
    .select("automation_id, current_state, sent_at, confirmed_at, automations!inner(title, automation_type, assignee_id, cadence_type, status)")
    .eq("current_state", "confirmed")
    .gte("confirmed_at", window24hAgo)
    .order("confirmed_at", { ascending: false })
    .limit(5);

  // ── Automations firing today (next 24 h) ──────────────────────────────────
  const { data: firingTodayRows } = await supabase
    .from("automations")
    .select("id, title, next_run_at, automation_type, assignee_id, cadence_type, status")
    .eq("status", "active")
    .gte("next_run_at", now.toISOString())
    .lte("next_run_at", window24hFwd)
    .order("next_run_at", { ascending: true })
    .limit(5);

  // ── Automations firing tomorrow (24–48 h) ─────────────────────────────────
  const { data: firingTomorrowRows } = await supabase
    .from("automations")
    .select("id, title, next_run_at, automation_type, assignee_id, cadence_type, status")
    .eq("status", "active")
    .gt("next_run_at", window24hFwd)
    .lte("next_run_at", window48hFwd)
    .order("next_run_at", { ascending: true })
    .limit(5);

  // ── Resolve assignee names for all relevant automation IDs ────────────────
  const openRunsTyped = ((openRuns ?? []) as Record<string, unknown>[]).filter((r) =>
    isOperationalAutomationRunRow(r as AutomationRunRowWithJoin),
  );
  const confirmedRunsTyped = ((confirmedRuns ?? []) as Record<string, unknown>[]).filter((r) =>
    isOperationalAutomationRunRow(r as AutomationRunRowWithJoin),
  );
  const firingTodayRowsTyped = filterSupportedOperationalAutomations(
    (firingTodayRows ?? []) as (Record<string, unknown> & AutomationJoinFields)[],
  );
  const firingTomorrowRowsTyped = filterSupportedOperationalAutomations(
    (firingTomorrowRows ?? []) as (Record<string, unknown> & AutomationJoinFields)[],
  );

  const allIds = [
    ...openRunsTyped.map((r) => r.automation_id as string),
    ...confirmedRunsTyped.map((r) => r.automation_id as string),
    ...firingTodayRowsTyped.map((a) => a.id as string),
    ...firingTomorrowRowsTyped.map((a) => a.id as string),
  ].filter(Boolean);

  const uniqueIds = [...new Set(allIds)];
  const assigneeMap: Record<string, string | null> = {};

  if (uniqueIds.length > 0) {
    const { data: autoRows } = await supabase
      .from("automations")
      .select("id, people(name)")
      .in("id", uniqueIds);

    if (autoRows) {
      for (const row of autoRows as Record<string, unknown>[]) {
        const person = row.people as { name?: string } | null;
        assigneeMap[row.id as string] = person?.name ?? null;
      }
    }
  }

  // ── Assemble digest ───────────────────────────────────────────────────────

  function toRunSummary(r: Record<string, unknown>, confirmedMode = false): AutomationRunSummary {
    const auto = r.automations as { title?: string } | null;
    const automationId = r.automation_id as string;
    const sentAt = r.sent_at as string | null;
    const confirmedAt = r.confirmed_at as string | null;
    const escalatedAt = r.escalated_at as string | null;
    return {
      automationTitle: auto?.title ?? "Automation",
      assignee: assigneeMap[automationId] ?? null,
      sentAgoMs: sentAt ? nowMs - new Date(sentAt).getTime() : 0,
      isFollowupSent: r.current_state === "followup_sent",
      confirmedAgoMs: confirmedMode && confirmedAt ? nowMs - new Date(confirmedAt).getTime() : undefined,
      escalatedAgoMs: escalatedAt ? nowMs - new Date(escalatedAt).getTime() : undefined,
      failureReason: r.current_state === "failed" ? ((r.failure_reason as string | null) ?? null) : undefined,
    };
  }

  const pending = openRunsTyped
    .filter((r) => {
      const automation = r.automations as { automation_type?: string } | null;
      return (
        automation?.automation_type !== "message" &&
        (r.current_state === "sent" || r.current_state === "followup_sent")
      );
    })
    .map((r) => toRunSummary(r));

  const escalated = openRunsTyped
    .filter((r) => r.current_state === "escalated")
    .map((r) => toRunSummary(r));

  const failed = openRunsTyped
    .filter((r) => r.current_state === "failed")
    .map((r) => toRunSummary(r));

  const confirmedToday = confirmedRunsTyped.map((r) => toRunSummary(r, true));

  const firingToday = firingTodayRowsTyped.map((a) => ({
    title: a.title as string,
    assignee: assigneeMap[a.id as string] ?? null,
    nextRunAt: a.next_run_at as string,
  }));

  const firingTomorrow = firingTomorrowRowsTyped.map((a) => ({
    title: a.title as string,
    assignee: assigneeMap[a.id as string] ?? null,
    nextRunAt: a.next_run_at as string,
  }));

  return { pending, escalated, failed, confirmedToday, firingToday, firingTomorrow };
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatters — Carson context block (text)
// ─────────────────────────────────────────────────────────────────────────────

const MAX_TEXT = 5;

function msToAgo(ms: number): string {
  const h = Math.round(ms / 3_600_000);
  if (h < 1) return `${Math.round(ms / 60_000)}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function firingLabel(isoAt: string, now = new Date()): string {
  const d = new Date(isoAt);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const nowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(nowStart.getTime() + 86_400_000);
  if (d >= nowStart && d < tomorrow) return `today at ${time}`;
  return `tomorrow at ${time}`;
}

/**
 * Builds the AUTOMATION STATUS text block for ra7etbal_state / Carson context.
 * Pure function — takes a pre-fetched digest.
 */
export function buildAutomationStatusBlock(digest: AutomationDigest): string {
  const now = new Date();
  const lines: string[] = ["AUTOMATION STATUS:"];

  if (digest.pending.length > 0) {
    lines.push("Pending:");
    for (const r of digest.pending.slice(0, MAX_TEXT)) {
      const who = r.assignee ? ` — ${r.assignee}` : "";
      const age = msToAgo(r.sentAgoMs);
      const fu = r.isFollowupSent ? ", follow-up sent" : "";
      lines.push(`- ${r.automationTitle}${who} — sent ${age}, no confirmation yet${fu}`);
    }
  }

  if (digest.escalated.length > 0) {
    lines.push("Escalated:");
    for (const r of digest.escalated.slice(0, MAX_TEXT)) {
      const who = r.assignee ? ` — ${r.assignee}` : "";
      const age = r.escalatedAgoMs != null ? msToAgo(r.escalatedAgoMs) : "";
      lines.push(`- ${r.automationTitle}${who} — escalated ${age}`.trim());
    }
  }

  if (digest.failed.length > 0) {
    lines.push("Failed (delivery or send failure — needs attention):");
    for (const r of digest.failed.slice(0, MAX_TEXT)) {
      const who = r.assignee ? ` — ${r.assignee}` : "";
      const age = msToAgo(r.sentAgoMs);
      const reason = r.failureReason ? `: ${r.failureReason}` : "";
      lines.push(`- ${r.automationTitle}${who} — failed ${age}${reason}`);
    }
  }

  if (digest.firingToday.length > 0) {
    lines.push("Firing today:");
    for (const a of digest.firingToday.slice(0, MAX_TEXT)) {
      const who = a.assignee ? ` — ${a.assignee}` : "";
      lines.push(`- ${a.title}${who} — scheduled ${firingLabel(a.nextRunAt, now)}`);
    }
  }

  if (digest.confirmedToday.length > 0) {
    lines.push("Recently confirmed:");
    for (const r of digest.confirmedToday.slice(0, MAX_TEXT)) {
      const who = r.assignee ? ` — ${r.assignee}` : "";
      const age = r.confirmedAgoMs != null ? msToAgo(r.confirmedAgoMs) : "";
      lines.push(`- ${r.automationTitle}${who} — confirmed ${age}`.trim());
    }
  }

  if (lines.length === 1) lines.push("No active automation issues.");

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Spoken sentence formatters — brief integrations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns ≤1 spoken sentence for the Morning Brief.
 *
 * Priority: failed → escalated → pending → owner reminders firing today → confirmed → "".
 * Only speaks when there is a notable signal worth surfacing at morning time.
 * Never repeats what the task waitingOn section already covers (those are
 * regular tasks; these are automation-generated loops).
 */
export function formatAutomationForMorning(digest: AutomationDigest): string {
  // Failed — highest urgency, something actually broke (e.g. WhatsApp delivery failure)
  if (digest.failed.length === 1) {
    const r = digest.failed[0];
    const who = r.assignee ? ` to ${cap(r.assignee)}` : "";
    return `One automation failed to send${who} — it needs your attention.`;
  }
  if (digest.failed.length > 1) {
    return `${digest.failed.length} automations failed to send and need your attention.`;
  }

  // Escalated — highest urgency
  if (digest.escalated.length === 1) {
    const r = digest.escalated[0];
    const who = r.assignee ? ` — ${cap(r.assignee)} hasn't responded.` : " — no response yet.";
    return `One automation has been escalated${who}`;
  }
  if (digest.escalated.length > 1) {
    return `${digest.escalated.length} automations have been escalated and need attention.`;
  }

  // Pending — medium priority
  if (digest.pending.length === 1) {
    const r = digest.pending[0];
    const who = r.assignee ? ` from ${cap(r.assignee)}` : "";
    return `One automation is waiting for confirmation${who}.`;
  }
  if (digest.pending.length > 1) {
    return `${digest.pending.length} automations are waiting for confirmation.`;
  }

  // Owner-only reminders have no assignee. Before they fire they exist only in
  // automations, not tasks, so this is the morning brief's only reliable source.
  const ownerRemindersToday = digest.firingToday.filter((a) => !a.assignee);
  if (ownerRemindersToday.length === 1) {
    const reminder = ownerRemindersToday[0];
    return `You have a reminder scheduled ${firingLabel(reminder.nextRunAt)} — ${lc(reminder.title)}.`;
  }
  if (ownerRemindersToday.length > 1) {
    const first = ownerRemindersToday[0];
    const rest = ownerRemindersToday.length - 1;
    return `You have ${ownerRemindersToday.length} reminders scheduled in the next 24 hours. The first is ${lc(first.title)} ${firingLabel(first.nextRunAt)}, with ${rest} more after that.`;
  }

  // Confirmed — positive signal
  if (digest.confirmedToday.length === 1) {
    const r = digest.confirmedToday[0];
    if (r.assignee) return `${cap(r.assignee)} confirmed the ${lc(r.automationTitle)} automation.`;
    return `The ${lc(r.automationTitle)} automation was confirmed.`;
  }
  if (digest.confirmedToday.length > 1) {
    const r = digest.confirmedToday[0];
    const rest = digest.confirmedToday.length - 1;
    if (r.assignee) {
      return `${cap(r.assignee)} confirmed the ${lc(r.automationTitle)} automation, and ${rest} other${rest === 1 ? "" : "s"} were confirmed too.`;
    }
    return `${digest.confirmedToday.length} automations were confirmed today.`;
  }

  return "";
}

/**
 * Returns ≤1 spoken sentence for the Night Sweep.
 *
 * Priority: escalated/pending still open → firing tomorrow → confirmed today → "" (silence)
 */
export function formatAutomationForNight(digest: AutomationDigest): string {
  const stillOpen = digest.escalated.length + digest.pending.length;

  // Failed — highest urgency, surfaced before anything else tonight
  if (digest.failed.length === 1) {
    const r = digest.failed[0];
    const who = r.assignee ? ` to ${cap(r.assignee)}` : "";
    return `The ${lc(r.automationTitle)} automation failed to send${who} — worth a look before tomorrow.`;
  }
  if (digest.failed.length > 1) {
    return `${digest.failed.length} automations failed to send today and need a look.`;
  }

  // Still waiting / escalated
  if (digest.escalated.length === 1) {
    const r = digest.escalated[0];
    const who = r.assignee ? ` from ${cap(r.assignee)}` : "";
    return `The ${lc(r.automationTitle)} loop is still waiting for confirmation${who}.`;
  }
  if (stillOpen === 1 && digest.pending.length === 1) {
    const r = digest.pending[0];
    const who = r.assignee ? ` from ${cap(r.assignee)}` : "";
    return `The ${lc(r.automationTitle)} loop is still waiting for confirmation${who}.`;
  }
  if (stillOpen > 1) {
    return `${stillOpen} automation loops are still waiting for confirmation tonight.`;
  }

  // Firing tomorrow — preview
  if (digest.firingTomorrow.length === 1) {
    const a = digest.firingTomorrow[0];
    const who = a.assignee ? ` for ${cap(a.assignee)}` : "";
    return `The ${lc(a.title)} loop fires tomorrow${who}.`;
  }
  if (digest.firingTomorrow.length > 1) {
    return `${digest.firingTomorrow.length} automation loops fire tomorrow.`;
  }

  // Confirmed — positive close
  if (digest.confirmedToday.length === 1) {
    const r = digest.confirmedToday[0];
    if (r.assignee) return `${cap(r.assignee)} confirmed the ${lc(r.automationTitle)} loop today.`;
    return `The ${lc(r.automationTitle)} loop was confirmed today.`;
  }
  if (digest.confirmedToday.length > 1) {
    return `${digest.confirmedToday.length} automation loops were confirmed today.`;
  }

  return "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience wrapper — fetches and formats in one call (for App.tsx mount)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches the digest and returns the formatted AUTOMATION STATUS block.
 * Used for the initial page-load context string.
 * App.tsx should use fetchAutomationDigest() directly when it also needs to
 * pass the digest to spoken brief functions (avoids a duplicate Supabase fetch).
 */
export async function fetchAndBuildAutomationStatusBlock(): Promise<string> {
  const digest = await fetchAutomationDigest().catch(() => EMPTY_DIGEST);
  return buildAutomationStatusBlock(digest);
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

function cap(s: string | null | undefined): string {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Lowercase with no trailing punctuation — for embedding in a sentence. */
function lc(s: string): string {
  const clean = s.trim().replace(/[.!?]+$/, "");
  return clean.charAt(0).toLowerCase() + clean.slice(1);
}
