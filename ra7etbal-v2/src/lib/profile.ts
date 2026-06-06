import { supabase } from "./supabase";

export interface Profile {
  display_name: string | null;
  weather_city: string | null;
}

/**
 * Fetch the profile row for the signed-in user.
 * Returns null display_name when no row exists yet — that is not an error.
 */
export async function getProfile(): Promise<Profile> {
  const { data, error } = await supabase
    .from("profiles")
    .select("display_name, weather_city")
    .maybeSingle();
  if (error) throw friendly(error);
  return {
    display_name: data?.display_name ?? null,
    weather_city: data?.weather_city ?? null,
  };
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
