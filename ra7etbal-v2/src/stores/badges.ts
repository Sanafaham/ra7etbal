import { create } from "zustand";

/** Lightweight badge counters for BottomNav. Updated by the components that own each data source. */
interface BadgeStore {
  inboxCount: number;
  setInboxCount: (n: number) => void;
}

export const useBadgeStore = create<BadgeStore>((set) => ({
  inboxCount: 0,
  setInboxCount: (inboxCount) => set({ inboxCount }),
}));
