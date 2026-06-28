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

export const LEGACY_ROUTINE_CREATION_FROZEN_MESSAGE =
  "New recurring work now lives in Automations. Existing routines still work here.";

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
  void input;
  throw new Error(LEGACY_ROUTINE_CREATION_FROZEN_MESSAGE);
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
