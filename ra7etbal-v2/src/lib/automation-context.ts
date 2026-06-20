/**
 * automation-context.ts
 *
 * Builds the AUTOMATION STATUS block injected into ra7etbal_state / Carson context.
 *
 * Fetches from automations + automation_runs using the Supabase client
 * (anon key + RLS — user only sees their own rows).
 *
 * Sections produced:
 *   Pending:          sent but not confirmed within the last 48 h
 *   Escalated:        runs currently in escalated state
 *   Firing today:     automations whose next_run_at falls within the next 24 h
 *   Recently confirmed: runs confirmed in the last 24 h
 *
 * All sections capped at 5 items. If nothing is active, emits a single
 * "No active automation issues." line so Carson doesn't stay silent.
 */

import { supabase } from "./supabase";

const MAX_ITEMS = 5;

/** Returns a human-friendly "X ago" or "at HH:MM" label. */
function relativeTime(iso: string | null, now: Date): string {
  if (!iso) return "";
  const ms = now.getTime() - new Date(iso).getTime();
  const h = Math.round(ms / 3_600_000);
  if (h < 1) {
    const m = Math.round(ms / 60_000);
    return `${m}m ago`;
  }
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function todayLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `today at ${time}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} at ${time}`;
}

/**
 * Fetches automation state for the current signed-in user and returns
 * a formatted plain-text block for Carson's context.
 * Returns empty string on auth failure or query error (non-fatal).
 */
export async function buildAutomationStatusBlock(): Promise<string> {
  const now = new Date();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "";

  const windowStart48h = new Date(now.getTime() - 48 * 3_600_000).toISOString();
  const windowEnd24h = new Date(now.getTime() + 24 * 3_600_000).toISOString();

  // ── Fetch pending + escalated runs (sent or escalated, last 48 h) ─────────
  // Join automation title via foreign key embed (PostgREST nested select).
  // assignee_name is not stored on automation_runs — we pull from automations.
  const { data: openRuns } = await supabase
    .from("automation_runs")
    .select(`
      id,
      automation_id,
      current_state,
      run_for,
      sent_at,
      confirmed_at,
      escalated_at,
      failure_reason,
      automations!inner ( title )
    `)
    .in("current_state", ["sent", "followup_sent", "escalated"])
    .gte("sent_at", windowStart48h)
    .order("sent_at", { ascending: false })
    .limit(20);

  // ── Fetch recently confirmed runs (last 24 h) ─────────────────────────────
  const { data: confirmedRuns } = await supabase
    .from("automation_runs")
    .select(`
      id,
      automation_id,
      current_state,
      run_for,
      sent_at,
      confirmed_at,
      escalated_at,
      failure_reason,
      automations!inner ( title )
    `)
    .eq("current_state", "confirmed")
    .gte("confirmed_at", new Date(now.getTime() - 24 * 3_600_000).toISOString())
    .order("confirmed_at", { ascending: false })
    .limit(MAX_ITEMS);

  // ── Fetch automations firing within 24 h ─────────────────────────────────
  const { data: firingAutomations } = await supabase
    .from("automations")
    .select("id, title, next_run_at, status")
    .eq("status", "active")
    .lte("next_run_at", windowEnd24h)
    .gte("next_run_at", now.toISOString())
    .order("next_run_at", { ascending: true })
    .limit(MAX_ITEMS);

  // ── Fetch assignee names for automation IDs we care about ─────────────────
  // Automations store assignee_id (FK to people). We need a name for display.
  // One extra query rather than a multi-hop join.
  const allAutomationIds = [
    ...(openRuns ?? []).map((r: Record<string, unknown>) => r.automation_id as string),
    ...(confirmedRuns ?? []).map((r: Record<string, unknown>) => r.automation_id as string),
    ...(firingAutomations ?? []).map((a: Record<string, unknown>) => a.id as string),
  ].filter(Boolean);

  const uniqueIds = [...new Set(allAutomationIds)];
  let assigneeMap: Record<string, string | null> = {};

  if (uniqueIds.length > 0) {
    const { data: automationRows } = await supabase
      .from("automations")
      .select("id, assignee_id, people ( name )")
      .in("id", uniqueIds);

    if (automationRows) {
      for (const row of automationRows as Record<string, unknown>[]) {
        const person = row.people as { name?: string } | null;
        assigneeMap[row.id as string] = person?.name ?? null;
      }
    }
  }

  // ── Format ─────────────────────────────────────────────────────────────────
  const lines: string[] = ["AUTOMATION STATUS:"];

  // Pending (sent / followup_sent — waiting for confirmation)
  const pendingRuns = (openRuns ?? []).filter(
    (r: Record<string, unknown>) => r.current_state === "sent" || r.current_state === "followup_sent",
  );
  if (pendingRuns.length > 0) {
    lines.push("Pending:");
    for (const r of pendingRuns.slice(0, MAX_ITEMS) as Record<string, unknown>[]) {
      const auto = r.automations as { title?: string } | null;
      const title = auto?.title ?? "Unknown";
      const assignee = assigneeMap[r.automation_id as string];
      const who = assignee ? ` — ${assignee}` : "";
      const age = relativeTime(r.sent_at as string | null, now);
      const followupFlag = r.current_state === "followup_sent" ? ", follow-up sent" : "";
      lines.push(`- ${title}${who} — sent ${age}, no confirmation yet${followupFlag}`);
    }
  }

  // Escalated
  const escalatedRuns = (openRuns ?? []).filter(
    (r: Record<string, unknown>) => r.current_state === "escalated",
  );
  if (escalatedRuns.length > 0) {
    lines.push("Escalated:");
    for (const r of escalatedRuns.slice(0, MAX_ITEMS) as Record<string, unknown>[]) {
      const auto = r.automations as { title?: string } | null;
      const title = auto?.title ?? "Unknown";
      const assignee = assigneeMap[r.automation_id as string];
      const who = assignee ? ` — ${assignee}` : "";
      const age = relativeTime(r.escalated_at as string | null, now);
      lines.push(`- ${title}${who} — escalated ${age}`);
    }
  }

  // Firing today
  if ((firingAutomations ?? []).length > 0) {
    lines.push("Firing today:");
    for (const a of (firingAutomations ?? []).slice(0, MAX_ITEMS) as Record<string, unknown>[]) {
      const assignee = assigneeMap[a.id as string];
      const who = assignee ? ` — ${assignee}` : "";
      const when = todayLabel(a.next_run_at as string, now);
      lines.push(`- ${a.title as string}${who} — scheduled ${when}`);
    }
  }

  // Recently confirmed
  if ((confirmedRuns ?? []).length > 0) {
    lines.push("Recently confirmed:");
    for (const r of (confirmedRuns ?? []).slice(0, MAX_ITEMS) as Record<string, unknown>[]) {
      const auto = r.automations as { title?: string } | null;
      const title = auto?.title ?? "Unknown";
      const assignee = assigneeMap[r.automation_id as string];
      const who = assignee ? ` — ${assignee}` : "";
      const when = relativeTime(r.confirmed_at as string | null, now);
      lines.push(`- ${title}${who} — confirmed ${when}`);
    }
  }

  // Nothing active
  if (lines.length === 1) {
    lines.push("No active automation issues.");
  }

  return lines.join("\n");
}
