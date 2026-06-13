import { supabase } from "./supabase";

export interface Profile {
  display_name: string | null;
  weather_city: string | null;
  morning_brief_timezone: string | null;
  evening_brief_enabled: boolean;
  evening_brief_time: string;
}

/**
 * Fetch the profile row for the signed-in user.
 * Returns null display_name when no row exists yet — that is not an error.
 */
export async function getProfile(): Promise<Profile> {
  const { data, error } = await supabase
    .from("profiles")
    .select("display_name, weather_city, morning_brief_timezone, evening_brief_enabled, evening_brief_time")
    .maybeSingle();
  if (error) throw friendly(error);
  return {
    display_name: data?.display_name ?? null,
    weather_city: data?.weather_city ?? null,
    morning_brief_timezone: data?.morning_brief_timezone ?? null,
    evening_brief_enabled: data?.evening_brief_enabled ?? false,
    evening_brief_time: data?.evening_brief_time ?? "20:00",
  };
}

/**
 * Detect the browser's IANA timezone and save it to profiles if not already set.
 * Falls back to "Europe/Istanbul" when the browser API is unavailable.
 * Safe to call on every login — only writes if the column is still the default
 * or null, preventing accidental overwrites of a user-chosen timezone.
 */
export async function syncTimezoneToProfile(existingTimezone: string | null): Promise<void> {
  const detected = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Istanbul";
    } catch {
      return "Europe/Istanbul";
    }
  })();

  // Do not overwrite if a non-default timezone is already stored.
  const isDefaultOrEmpty = !existingTimezone || existingTimezone === "Europe/Istanbul";
  if (!isDefaultOrEmpty) return;

  // Also skip if detected value is the same as what's already stored.
  if (detected === existingTimezone) return;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  await supabase.from("profiles").upsert(
    { id: user.id, morning_brief_timezone: detected, updated_at: new Date().toISOString() },
    { onConflict: "id" },
  );
  // Non-fatal — failure here does not affect the rest of the app.
}

/**
 * Create or update the profile row for the signed-in user.
 * Passing an empty string saves null (treated as "not set").
 */
export async function upsertProfile(displayName: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");

  const { error } = await supabase.from("profiles").upsert(
    {
      id: user.id,
      display_name: displayName.trim() || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) throw friendly(error);
}

/**
 * Save (or clear) the user's preferred weather city.
 * Single-field write — does not touch display_name.
 */
export async function upsertWeatherCity(city: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");

  const { error } = await supabase.from("profiles").upsert(
    {
      id: user.id,
      weather_city: city.trim() || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) throw friendly(error);
}

function friendly(err: { message?: string }): Error {
  const msg = (err.message ?? "").toLowerCase();
  if (msg.includes("row-level security") || msg.includes("permission denied")) {
    return new Error("You don't have permission to do that.");
  }
  if (msg.includes("network") || msg.includes("failed to fetch")) {
    return new Error("Network issue. Please check your connection.");
  }
  return new Error(err.message || "Something went wrong. Please try again.");
}
