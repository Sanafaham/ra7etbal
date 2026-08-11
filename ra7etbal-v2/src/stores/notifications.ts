import { create } from "zustand";
import {
  listOwnerNotifications,
  markAllOwnerNotificationsRead,
  markOwnerNotificationRead,
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
  reset: () => void;
}

export const useNotificationsStore = create<NotificationsState>((set, get) => ({
  status: "idle",
  items: [],
  error: null,
  loadedForUserId: null,

  async loadFor(userId, options) {
    if (!options?.force && get().loadedForUserId === userId && get().status === "ready") return;
    set({ status: "loading", error: null });
    try {
      const items = await listOwnerNotifications();
      set({ status: "ready", items, error: null, loadedForUserId: userId });
    } catch (error) {
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
    const readAt = new Date().toISOString();
    await markOwnerNotificationRead(id, readAt);
    set((state) => ({
      items: state.items.map((row) => row.id === id ? { ...row, read_at: readAt } : row),
    }));
  },

  async markAllRead() {
    if (!get().items.some((row) => !row.read_at)) return;
    const readAt = new Date().toISOString();
    await markAllOwnerNotificationsRead(readAt);
    set((state) => ({
      items: state.items.map((row) => row.read_at ? row : { ...row, read_at: readAt }),
    }));
  },

  reset: () => set({ status: "idle", items: [], error: null, loadedForUserId: null }),
}));

export function selectUnreadNotificationCount(state: NotificationsState): number {
  return state.items.reduce((count, item) => count + (item.read_at ? 0 : 1), 0);
}
