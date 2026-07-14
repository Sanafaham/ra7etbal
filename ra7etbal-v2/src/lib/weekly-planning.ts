/**
 * weekly-planning.ts
 *
 * Carson Weekly Planning V1 — "Carson, organize my week."
 *
 * Reuses the same propose → single approval → execute state machine already
 * built for Operations Intelligence (ops-intelligence.ts's carson_pending_
 * operations table, isConfirmation/isRejection/resolvePendingPlanDecision),
 * with a new pending-operation type ("weekly_plan") instead of a new table
 * or a new confirmation mechanism.
 *
 * Flow:
 *  1. detectWeeklyPlanningIntent(text) — "organize/plan my week"
 *  2. buildWeekPlan(ctx) — reads calendar + Ra7etBal state, calls Haiku for a
 *     compact proposed schedule, deterministically drops any slot that
 *     conflicts with a real existing event, persists the plan
 *  3. resolvePendingPlanDecision (reused from ops-intelligence.ts) resolves
 *     the user's reply to the proposal
 *  4. executeWeekPlan(plan) — creates every approved event, re-reads the
 *     calendar to verify each one actually exists, reports truthfully
 *  5. Retry re-attempts only the events that failed, never the ones that
 *     already succeeded
 */

import type { CalendarEvent } from "./calendar";
import { createCalendarEvent, fetchCalendarEvents } from "./calendar";
import { supabase } from "./supabase";

// ── Intent detection ─────────────────────────────────────────────────────────

const WEEKLY_PLANNING_INTENT_RE =
  /\b(?:organi[sz]e|plan|structure|map out|lay out)\s+(?:my|the|this)\s+week\b/i;

export function detectWeeklyPlanningIntent(text: string): boolean {
  return WEEKLY_PLANNING_INTENT_RE.test((text ?? "").trim());
}

const WEEK_PLAN_RETRY_RE = /\b(?:try again|retry|redo (?:that|those)|attempt (?:that|those) again)\b/i;

export function isWeekPlanRetryRequest(text: string): boolean {
  return WEEK_PLAN_RETRY_RE.test((text ?? "").trim());
}

/** Returns true when the plan is older than 10 minutes and should be ignored. */
export function isWeekPlanExpired(plan: ProposedWeekPlan, now = Date.now()): boolean {
  return now - plan.createdAt > 10 * 60 * 1000;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface ProposedCalendarEvent {
  /** Client-generated id — stable across propose → execute → retry. */
  id: string;
  title: string;
  /** Local date, YYYY-MM-DD. */
  date: string;
  /** Local 24-hour time, HH:MM. */
  time: string;
  durationMinutes: number;
}

export interface ProposedWeekPlan {
  /** DB row id — set once persisted. */
  dbId?: string;
  events: ProposedCalendarEvent[];
  /** Carson's compact proposal, ending in the required approval question. */
  proposalSpeech: string;
  /** Original user utterance that triggered planning. */
  sourceText: string;
  /** Unix ms when the plan was created — used for the 10-minute expiry check. */
  createdAt: number;
}

export type WeekPlanBuildResult =
  | { status: "clarification_needed"; question: string }
  | { status: "no_plan"; reason: string }
  | { status: "proposed"; plan: ProposedWeekPlan };

export interface WeekEventResult {
  /** Matches the ProposedCalendarEvent id this result is for. */
  id: string;
  title: string;
  date: string;
  time: string;
  status: "created" | "failed" | "verified_missing";
  googleEventId?: string;
  error?: string;
}

// ── Conflict detection ───────────────────────────────────────────────────────

function toRangeMs(date: string, time: string, durationMinutes: number): { start: number; end: number } {
  const start = new Date(`${date}T${time}:00`).getTime();
  return { start, end: start + durationMinutes * 60_000 };
}

/**
 * Returns the subset of proposed events that overlap a real existing
 * calendar event. These must never be created — existing commitments are
 * protected and are never moved or cancelled automatically.
 */
export function findSchedulingConflicts(
  proposed: ProposedCalendarEvent[],
  existing: CalendarEvent[],
): ProposedCalendarEvent[] {
  const existingRanges = existing
    .filter((e) => !e.allDay && e.start)
    .map((e) => {
      const start = new Date(e.start as string).getTime();
      const end = e.end ? new Date(e.end).getTime() : start + 60 * 60_000;
      return { start, end };
    })
    .filter((r) => !Number.isNaN(r.start) && !Number.isNaN(r.end));

  return proposed.filter((p) => {
    const { start, end } = toRangeMs(p.date, p.time, p.durationMinutes);
    if (Number.isNaN(start) || Number.isNaN(end)) return true; // unparsable — never create it
    return existingRanges.some((r) => start < r.end && end > r.start);
  });
}

/** Removes proposed events that conflict with existing calendar commitments. */
export function dropConflictingEvents(
  proposed: ProposedCalendarEvent[],
  existing: CalendarEvent[],
): ProposedCalendarEvent[] {
  const conflicting = new Set(findSchedulingConflicts(proposed, existing).map((e) => e.id));
  return proposed.filter((e) => !conflicting.has(e.id));
}

// ── Supabase persistence (carson_pending_operations, type: weekly_plan) ─────

async function persistWeekPlan(plan: ProposedWeekPlan): Promise<string | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const expiresAt = new Date(plan.createdAt + 10 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("carson_pending_operations")
    .insert({
      user_id: user.id,
      type: "weekly_plan",
      summary: plan.proposalSpeech,
      // Column is named "tasks" (shared with guest_arrival's ProposedTask[])
      // but holds ProposedCalendarEvent[] here — jsonb, no schema conflict.
      tasks: plan.events,
      source_text: plan.sourceText,
      status: "pending",
      expires_at: expiresAt,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[weekly-planning] persistWeekPlan failed:", error.message);
    return null;
  }
  return data?.id ?? null;
}

/** Load the latest non-expired pending weekly plan for the user. */
export async function loadLatestPendingWeekPlan(): Promise<ProposedWeekPlan | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from("carson_pending_operations")
    .select("*")
    .eq("user_id", user.id)
    .eq("type", "weekly_plan")
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  return {
    dbId: data.id as string,
    events: (data.tasks ?? []) as ProposedCalendarEvent[],
    proposalSpeech: data.summary as string,
    sourceText: data.source_text as string,
    createdAt: new Date(data.created_at as string).getTime(),
  };
}

export async function markWeekPlanCompleted(dbId: string): Promise<void> {
  await supabase
    .from("carson_pending_operations")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", dbId);
}

export async function markWeekPlanCancelled(dbId: string): Promise<void> {
  await supabase
    .from("carson_pending_operations")
    .update({ status: "cancelled" })
    .eq("id", dbId);
}

/** Call when the user rejects a proposed weekly plan. */
export async function rejectWeekPlan(plan: ProposedWeekPlan): Promise<string> {
  if (plan.dbId) markWeekPlanCancelled(plan.dbId).catch(() => {});
  return "Okay, I'll leave your week as it is. Just say the word when you're ready.";
}

// ── Plan builder ─────────────────────────────────────────────────────────────

interface AnthropicContent { type: string; text?: string }
interface AnthropicResponse { content?: AnthropicContent[]; error?: { message: string } }

interface WeekPlanAIResponse {
  needs_clarification: boolean;
  clarification_question?: string;
  events?: Array<{ title: string; date: string; time: string; duration_minutes?: number }>;
  proposal_speech?: string;
}

export interface WeekPlanContext {
  sourceText: string;
  /** Real existing events for the next 7+ days — never proposed over. */
  calendarEvents: CalendarEvent[];
  todosBlock: string;
  needsAttentionBlock: string;
  waitingBlock: string;
  automationStatusBlock: string;
  householdRules: string;
  persistentMemory: string;
  timezone: string;
  now: Date;
}

function formatEventForPrompt(event: CalendarEvent): string {
  if (event.allDay) return `${event.title} (all day)`;
  const start = event.start ? new Date(event.start) : null;
  const startStr = start && !Number.isNaN(start.getTime())
    ? start.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "unknown time";
  return `${event.title} — ${startStr}`;
}

function buildWeekPlanPrompt(ctx: WeekPlanContext): string {
  const calendarBlock = ctx.calendarEvents.length > 0
    ? ctx.calendarEvents.map((e) => `- ${formatEventForPrompt(e)}`).join("\n")
    : "No existing events in the next 7 days.";

  const today = ctx.now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  return `You are Carson, the user's Chief of Staff. The user said: "${ctx.sourceText}"

They want you to organize their upcoming week. Today is ${today}. Timezone: ${ctx.timezone}.

EXISTING CALENDAR (next 7+ days — these are real commitments, never propose a new event that overlaps one of these, never suggest moving or cancelling one):
${calendarBlock}

ACTIVE TO-DOS:
${ctx.todosBlock || "None."}

NEEDS ATTENTION (deadlines, overdue reminders, items requiring action):
${ctx.needsAttentionBlock || "None."}

WAITING ON OTHERS:
${ctx.waitingBlock || "None."}

${ctx.automationStatusBlock || ""}

HOUSEHOLD RULES:
${ctx.householdRules || "None recorded."}

${ctx.persistentMemory || ""}

TASK
Identify fixed commitments, important priorities, conflicts, available time, and a realistic buffer (aim for roughly 20% of the week left unscheduled — do not overpack). Only propose NEW calendar blocks for to-dos, priorities, or open items that need dedicated time — never re-propose something already on the calendar.

Use information already given above before asking anything. Do not ask a fixed questionnaire. Only ask a question if something ESSENTIAL is genuinely missing (e.g. there are zero to-dos, zero calendar events, and zero stated priorities, so there is nothing to build a plan from). If you do ask, ask exactly ONE combined question covering everything you need.

Respond with ONLY valid JSON, no markdown:
{
  "needs_clarification": boolean,
  "clarification_question": "<one combined question, only if needs_clarification is true>",
  "events": [
    { "title": "<short event title>", "date": "YYYY-MM-DD", "time": "HH:MM", "duration_minutes": <number, default 60> }
  ],
  "proposal_speech": "<a compact 2-4 sentence summary of the proposed week, ending exactly with: Shall I add this plan to your calendar?>"
}

If needs_clarification is true, events and proposal_speech may be omitted.`;
}

/**
 * Calls Haiku to build a compact proposed week, dropping any slot that would
 * conflict with a real existing event, then persists the plan so it
 * survives a session disconnect.
 */
export async function buildWeekPlan(ctx: WeekPlanContext): Promise<WeekPlanBuildResult> {
  const prompt = buildWeekPlanPrompt(ctx);

  let res: Response;
  try {
    res = await fetch("/api/anthropic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 900,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch {
    return { status: "no_plan", reason: "Network issue reaching the planning model." };
  }

  let body: AnthropicResponse;
  try {
    body = (await res.json()) as AnthropicResponse;
  } catch {
    return { status: "no_plan", reason: "Could not read the planning response." };
  }

  if (!res.ok || body.error) {
    return { status: "no_plan", reason: body.error?.message ?? "Planning request failed." };
  }

  const raw = body.content?.[0]?.text?.trim();
  if (!raw) return { status: "no_plan", reason: "Empty planning response." };

  let parsed: WeekPlanAIResponse;
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    parsed = JSON.parse(cleaned) as WeekPlanAIResponse;
  } catch {
    return { status: "no_plan", reason: "Could not parse the planning response." };
  }

  if (parsed.needs_clarification) {
    const question = parsed.clarification_question?.trim();
    if (!question) return { status: "no_plan", reason: "Clarification was requested with no question." };
    return { status: "clarification_needed", question };
  }

  const rawEvents = parsed.events ?? [];
  if (rawEvents.length === 0 || !parsed.proposal_speech?.trim()) {
    return { status: "no_plan", reason: "The planner did not return any events." };
  }

  const candidateEvents: ProposedCalendarEvent[] = rawEvents
    .filter((e) => e.title?.trim() && /^\d{4}-\d{2}-\d{2}$/.test(e.date ?? "") && /^\d{2}:\d{2}$/.test(e.time ?? ""))
    .map((e) => ({
      id: crypto.randomUUID(),
      title: e.title.trim(),
      date: e.date,
      time: e.time,
      durationMinutes: e.duration_minutes && e.duration_minutes > 0 ? e.duration_minutes : 60,
    }));

  // Defense in depth: never trust the model alone to avoid double-booking.
  const safeEvents = dropConflictingEvents(candidateEvents, ctx.calendarEvents);
  if (safeEvents.length === 0) {
    return { status: "no_plan", reason: "Every proposed slot conflicted with an existing event." };
  }

  const plan: ProposedWeekPlan = {
    events: safeEvents,
    proposalSpeech: parsed.proposal_speech.trim(),
    sourceText: ctx.sourceText,
    createdAt: Date.now(),
  };

  const dbId = await persistWeekPlan(plan).catch(() => null);
  if (dbId) plan.dbId = dbId;

  return { status: "proposed", plan };
}

// ── Plan executor ────────────────────────────────────────────────────────────

/**
 * Creates every approved event, skipping any that a previous (partial) run
 * already confirmed created — so a retry can never duplicate a success.
 * Re-reads the calendar afterward and only reports an event as created once
 * it's confirmed to actually exist there.
 *
 * "verified_missing" (createCalendarEvent reported success but the re-read
 * calendar didn't show it) is treated the same as "created" for retry
 * purposes, never re-attempted automatically: the create call may well have
 * actually succeeded and the re-read simply lagged behind (Google Calendar
 * eventual consistency) — blindly retrying risks a real duplicate, which is
 * worse than leaving one event in a known-ambiguous state for the user to
 * check manually.
 */
export async function executeWeekPlan(
  plan: ProposedWeekPlan,
  previousResults: WeekEventResult[] = [],
): Promise<{ summary: string; results: WeekEventResult[] }> {
  const alreadyCreated = new Map(
    previousResults
      .filter((r) => r.status === "created" || r.status === "verified_missing")
      .map((r) => [r.id, r]),
  );

  const results: WeekEventResult[] = [...alreadyCreated.values()];

  for (const event of plan.events) {
    if (alreadyCreated.has(event.id)) continue;
    const created = await createCalendarEvent(event.title, event.date, event.time, event.durationMinutes);
    if (created.ok) {
      results.push({
        id: event.id,
        title: event.title,
        date: event.date,
        time: event.time,
        status: "created",
        googleEventId: created.id,
      });
    } else {
      results.push({
        id: event.id,
        title: event.title,
        date: event.date,
        time: event.time,
        status: "failed",
        error: created.code ?? "unknown_error",
      });
    }
  }

  // Never claim success without confirming the write — re-read the calendar
  // and downgrade any "created" result whose event doesn't actually appear.
  const verify = await fetchCalendarEvents("next_10_days");
  if (verify.connected) {
    const idsPresent = new Set(verify.events.map((e) => e.id));
    for (const r of results) {
      if (r.status === "created" && r.googleEventId && !idsPresent.has(r.googleEventId)) {
        r.status = "verified_missing";
      }
    }
  }

  if (plan.dbId) markWeekPlanCompleted(plan.dbId).catch(() => {});

  const createdCount = results.filter((r) => r.status === "created").length;
  const failedResults = results.filter((r) => r.status === "failed");
  const missingResults = results.filter((r) => r.status === "verified_missing");

  const parts: string[] = [`Added ${createdCount} event${createdCount === 1 ? "" : "s"} to your calendar for this week.`];
  if (failedResults.length > 0) {
    parts.push(`${failedResults.length} did not go through: ${failedResults.map((f) => f.title).join(", ")}. Say "try again" to retry those.`);
  }
  if (missingResults.length > 0) {
    parts.push(`${missingResults.length} could not be confirmed on the calendar yet: ${missingResults.map((f) => f.title).join(", ")}. Please check your calendar directly before retrying.`);
  }
  const summary = parts.join(" ");

  return { summary, results };
}
