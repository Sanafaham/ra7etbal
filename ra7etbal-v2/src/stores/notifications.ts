import { create } from "zustand";
import {
  listOwnerNotifications,
  markAllOwnerNotificationsRead,
  markOwnerNotificationRead,
  dismissOwnerNotification,
} from "../lib/notifications";
import type { OwnerNotification } from "../types/notification";

type Status = "idle" | "loading" | "ready" | "error";

interface NotificationsState {
  status: Status;
  items: OwnerNotification[];
  error: string | null;
  loadedForUserId: string | null;
  loadFor: (userId: string, options?: { force?: boolean }) => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  dismiss: (id: string) => Promise<void>;
  reset: () => void;
}

export const useNotificationsStore = create<NotificationsState>((set, get) => {
  let activeUserId: string | null = null;
  let sessionGeneration = 0;
  let loadGeneration = 0;
  // Reads and dismissals that already succeeded on the server. A reload that
  // was in flight when they happened can return the row as it was before, so
  // they are re-applied to every load result until the server agrees.
  let confirmedReads = new Map<string, string>();
  let confirmedDismissals = new Set<string>();

  function applyConfirmedMutations(items: OwnerNotification[]): OwnerNotification[] {
    const seen = new Set(items.map((row) => row.id));
    for (const id of confirmedDismissals) if (!seen.has(id)) confirmedDismissals.delete(id);
    for (const row of items) if (row.read_at) confirmedReads.delete(row.id);
    for (const id of confirmedReads.keys()) if (!seen.has(id)) confirmedReads.delete(id);
    return items
      .filter((row) => !confirmedDismissals.has(row.id))
      .map((row) => (confirmedReads.has(row.id) ? { ...row, read_at: confirmedReads.get(row.id) ?? null } : row));
  }

  return {
    status: "idle",
    items: [],
    error: null,
    loadedForUserId: null,

    async loadFor(userId, options) {
      if (!options?.force && get().loadedForUserId === userId && get().status === "ready") return;
      if (activeUserId !== userId) {
        activeUserId = userId;
        sessionGeneration += 1;
        confirmedReads = new Map();
        confirmedDismissals = new Set();
      }
      const expectedSession = sessionGeneration;
      const expectedLoad = ++loadGeneration;
      set({ status: "loading", error: null });
      try {
        const items = await listOwnerNotifications();
        if (expectedSession !== sessionGeneration || expectedLoad !== loadGeneration) return;
        set({ status: "ready", items: applyConfirmedMutations(items), error: null, loadedForUserId: userId });
      } catch (error) {
        if (expectedSession !== sessionGeneration || expectedLoad !== loadGeneration) return;
        set({
          status: "error",
          error: error instanceof Error ? error.message : "Could not load notifications.",
          loadedForUserId: userId,
        });
      }
    },

    async markRead(id) {
      const item = get().items.find((row) => row.id === id);
      if (!item || item.read_at) return;
      const expectedSession = sessionGeneration;
      const readAt = new Date().toISOString();
      await markOwnerNotificationRead(id, readAt);
      if (expectedSession !== sessionGeneration) return;
      confirmedReads.set(id, readAt);
      set((state) => ({
        items: state.items.map((row) => row.id === id ? { ...row, read_at: readAt } : row),
      }));
    },

    async markAllRead() {
      if (!get().items.some((row) => !row.read_at)) return;
      const expectedSession = sessionGeneration;
      const readAt = new Date().toISOString();
      const unreadIds = get().items.filter((row) => !row.read_at).map((row) => row.id);
      await markAllOwnerNotificationsRead(readAt);
      if (expectedSession !== sessionGeneration) return;
      for (const unreadId of unreadIds) confirmedReads.set(unreadId, readAt);
      set((state) => ({
        items: state.items.map((row) => row.read_at ? row : { ...row, read_at: readAt }),
      }));
    },

    async dismiss(id) {
      const item = get().items.find((row) => row.id === id);
      if (!item) return;
      const expectedSession = sessionGeneration;
      await dismissOwnerNotification(id, new Date().toISOString());
      if (expectedSession !== sessionGeneration) return;
      confirmedDismissals.add(id);
      set((state) => ({ items: state.items.filter((row) => row.id !== id) }));
    },

    reset: () => {
      activeUserId = null;
      confirmedReads = new Map();
      confirmedDismissals = new Set();
      sessionGeneration += 1;
      loadGeneration += 1;
      set({ status: "idle", items: [], error: null, loadedForUserId: null });
    },
  };
});

export function selectUnreadNotificationCount(state: NotificationsState): number {
  return state.items.reduce((count, item) => count + (item.read_at ? 0 : 1), 0);
}
