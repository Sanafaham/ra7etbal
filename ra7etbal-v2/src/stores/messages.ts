import { create } from "zustand";
import {
  createMessage as apiCreate,
  deleteMessage as apiDelete,
  listMessages as apiList,
} from "../lib/messages";
import type { Message, MessageDraft } from "../types/message";

export type MessagesStatus = "idle" | "loading" | "ready" | "error";

export interface MessagesState {
  status: MessagesStatus;
  items: Message[];
  error: string | null;
  loadedForUserId: string | null;

  loadFor: (userId: string, opts?: { force?: boolean }) => Promise<void>;
  reset: () => void;

  add: (draft: MessageDraft) => Promise<Message>;
  push: (rows: Message[]) => void;
  remove: (id: string) => Promise<void>;
}

export const useMessagesStore = create<MessagesState>((set, get) => ({
  status: "idle",
  items: [],
  error: null,
  loadedForUserId: null,

  reset: () =>
    set({ status: "idle", items: [], error: null, loadedForUserId: null }),

  async loadFor(userId, opts) {
    const { status, loadedForUserId } = get();
    const sameUser = loadedForUserId === userId;
    if (sameUser && status === "ready" && !opts?.force) return;
    if (sameUser && status === "loading") return;

    set({ status: "loading", error: null });
    try {
      const items = await apiList();
      if (get().loadedForUserId && get().loadedForUserId !== userId) return;
      set({ status: "ready", items, loadedForUserId: userId, error: null });
    } catch (err) {
      set({
        status: "error",
        error:
          err instanceof Error ? err.message : "Could not load messages.",
      });
    }
  },

  async add(draft) {
    const row = await apiCreate(draft);
    set((s) => ({ items: [row, ...s.items] }));
    return row;
  },

  push(rows) {
    if (rows.length === 0) return;
    set((s) => ({ items: [...rows, ...s.items] }));
  },

  async remove(id) {
    const prev = get().items;
    set({ items: prev.filter((m) => m.id !== id) });
    try {
      await apiDelete(id);
    } catch (err) {
      set({ items: prev });
      throw err;
    }
  },
}));
