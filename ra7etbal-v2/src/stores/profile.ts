import { create } from "zustand";
import { getProfile, upsertProfile, upsertWeatherCity, syncTimezoneToProfile } from "../lib/profile";

export type ProfileStatus = "idle" | "loading" | "ready" | "error";

export interface ProfileState {
  status: ProfileStatus;
  displayName: string | null;
  weatherCity: string | null;
  error: string | null;
  /** The user.id this cache was loaded for. Re-fetch when it changes. */
  loadedForUserId: string | null;

  loadFor: (userId: string, opts?: { force?: boolean }) => Promise<void>;
  save: (userId: string, name: string) => Promise<void>;
  saveWeatherCity: (city: string) => Promise<void>;
  reset: () => void;
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  status: "idle",
  displayName: null,
  weatherCity: null,
  error: null,
  loadedForUserId: null,

  reset: () =>
    set({ status: "idle", displayName: null, weatherCity: null, error: null, loadedForUserId: null }),

  async loadFor(userId, opts) {
    const { status, loadedForUserId } = get();
    const sameUser = loadedForUserId === userId;
    if (sameUser && status === "ready" && !opts?.force) return;
    if (status === "loading" && sameUser) return;

    set({ status: "loading", error: null });
    try {
      const profile = await getProfile();
      set({
        status: "ready",
        displayName: profile.display_name,
        weatherCity: profile.weather_city,
        loadedForUserId: userId,
      });
      // Sync browser timezone to profiles — non-fatal, fire and forget.
      syncTimezoneToProfile(profile.morning_brief_timezone).catch(() => {});
    } catch (err) {
      set({
        status: "error",
        error: err instanceof Error ? err.message : "Could not load profile.",
      });
    }
  },

  async save(userId, name) {
    const prev = get().displayName;
    const next = name.trim() || null;
    // Optimistic update.
    set({ displayName: next });
    try {
      await upsertProfile(name);
      set({ loadedForUserId: userId });
    } catch (err) {
      // Rollback.
      set({ displayName: prev });
      throw err;
    }
  },

  async saveWeatherCity(city) {
    const prev = get().weatherCity;
    const next = city.trim() || null;
    // Optimistic update.
    set({ weatherCity: next });
    try {
      await upsertWeatherCity(city);
    } catch (err) {
      // Rollback.
      set({ weatherCity: prev });
      throw err;
    }
  },
}));
