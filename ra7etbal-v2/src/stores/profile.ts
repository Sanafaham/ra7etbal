import { create } from "zustand";
import { getProfile, upsertProfile } from "../lib/profile";

export type ProfileStatus = "idle" | "loading" | "ready" | "error";

export interface ProfileState {
  status: ProfileStatus;
  displayName: string | null;
  error: string | null;
  /** The user.id this cache was loaded for. Re-fetch when it changes. */
  loadedForUserId: string | null;

  loadFor: (userId: string, opts?: { force?: boolean }) => Promise<void>;
  save: (userId: string, name: string) => Promise<void>;
  reset: () => void;
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  status: "idle",
  displayName: null,
  error: null,
  loadedForUserId: null,

  reset: () =>
    set({ status: "idle", displayName: null, error: null, loadedForUserId: null }),

  async loadFor(userId, opts) {
    const { status, loadedForUserId } = get();
    const sameUser = loadedForUserId === userId;
    if (sameUser && status === "ready" && !opts?.force) return;
    if (status === "loading" && sameUser) return;

    set({ status: "loading", error: null });
    try {
      const profile = await getProfile();
      set({ status: "ready", displayName: profile.display_name, loadedForUserId: userId });
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
}));
