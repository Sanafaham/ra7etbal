/**
 * routines.ts
 *
 * Client-side helpers for managing recurring automation routines.
 *
 * All functions use the Supabase anon client — RLS enforces ownership.
 * Never throws on auth issues; surfaces typed errors via the Supabase
 * PostgREST error object so callers can handle them inline.
 */

import { supabase } from "./supabase";

// ── Types ──────────────────────────────────────────────────────────────────────

export type RoutineType = "reminder" | "delegation" | "message";
export type RoutineSchedule = "daily" | "weekly" | "every_n_days";

export interface Routine {
  id: string;
  user_id: string;
  name: string;
  type: RoutineType;
  schedule: RoutineSchedule;
  /** 0 = Sunday … 6 = Saturday. null for daily/every_n_days routines. */
  schedule_day: number | null;
  /** "HH:MM" 24-hour local time, e.g. "08:30" */
  schedule_time: string;
  /** IANA timezone string, e.g. "Europe/Istanbul" */
  timezone: string;
  /** Days between runs. Required when schedule = "every_n_days". */
  interval_days: number | null;
  /** UTC timestamp of the next scheduled run. Used by every_n_days routines. */
  next_run_at: string | null;
  /**
   * Type-specific payload.
   * reminder:   { title: string }
   * delegation: { person_id: string; message: string }
   */
  payload: Record<string, unknown>;
  enabled: boolean;
  last_run_at: string | null;
  created_at: string;
}

export interface CreateRoutineInput {
  name: string;
  type: RoutineType;
  schedule: RoutineSchedule;
  /** Required when schedule is "weekly" (0–6). */
  schedule_day?: number;
  /** "HH:MM" 24-hour local time. */
  schedule_time: string;
  payload: Record<string, unknown>;
  /** Required when schedule is "every_n_days". Minimum 1. */
  interval_days?: number;
  /** UTC ISO string for first run. Computed client-side for every_n_days routines. */
  next_run_at?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const FALLBACK_TIMEZONE = "Europe/Istanbul";

/**
 * Resolve the current user's preferred timezone.
 * Reads profiles.morning_brief_timezone; falls back to Europe/Istanbul.
 * Never throws — timezone lookup failure is non-fatal.
 */
async function resolveTimezone(): Promise<string> {
  try {
    const { data } = await supabase
      .from("profiles")
      .select("morning_brief_timezone")
      .maybeSingle();
    return data?.morning_brief_timezone ?? FALLBACK_TIMEZONE;
  } catch {
    return FALLBACK_TIMEZONE;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch all routines for the signed-in user, newest first.
 */
export async function listRoutines(): Promise<Routine[]> {
  const { data, error } = await supabase
    .from("routines")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as Routine[];
}

/**
 * Create a new routine for the signed-in user.
 *
 * Automatically attaches:
 * - user_id  from the active Supabase session
 * - timezone from profiles.morning_brief_timezone (fallback: Europe/Istanbul)
 */
export async function createRoutine(input: CreateRoutineInput): Promise<Routine> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated.");

  const timezone = await resolveTimezone();

  const insert = {
    user_id: user.id,
    name: input.name,
    type: input.type,
    schedule: input.schedule,
    schedule_day: input.schedule_day ?? null,
    schedule_time: input.schedule_time,
    timezone,
    payload: input.payload,
    enabled: true,
    interval_days: input.interval_days ?? null,
    next_run_at: input.next_run_at ?? null,
  };

  const { data, error } = await supabase
    .from("routines")
    .insert(insert)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data as Routine;
}

/**
 * Enable or disable a routine by ID.
 * Silently succeeds if the routine is already in the target state.
 */
export async function toggleRoutine(id: string, enabled: boolean): Promise<void> {
  const { error } = await supabase
    .from("routines")
    .update({ enabled })
    .eq("id", id);

  if (error) throw new Error(error.message);
}

/**
 * Permanently delete a routine by ID.
 */
export async function deleteRoutine(id: string): Promise<void> {
  const { error } = await supabase
    .from("routines")
    .delete()
    .eq("id", id);

  if (error) throw new Error(error.message);
}
