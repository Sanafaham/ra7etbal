import { create } from "zustand";
import {
  createTask as apiCreate,
  deleteTask as apiDelete,
  listTasks as apiList,
  updateTask as apiUpdate,
} from "../lib/tasks";
import type { Task, TaskDraft, TaskPatch } from "../types/task";

export type TasksStatus = "idle" | "loading" | "ready" | "error";

export interface TasksState {
  status: TasksStatus;
  items: Task[];
  error: string | null;
  loadedForUserId: string | null;

  loadFor: (userId: string, opts?: { force?: boolean }) => Promise<void>;
  reset: () => void;

  add: (draft: TaskDraft) => Promise<Task>;
  /** Append rows directly (used by save flow). */
  push: (rows: Task[]) => void;
  update: (id: string, patch: TaskPatch) => Promise<Task>;
  remove: (id: string) => Promise<void>;
  markDone: (id: string) => Promise<Task>;
  markPending: (id: string) => Promise<Task>;
  /** Replace a single row in place (used by realtime updates). */
  upsert: (row: Task) => void;
}

export const useTasksStore = create<TasksState>((set, get) => ({
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
          err instanceof Error
            ? err.message
            : "Could not load tasks.",
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

  async update(id, patch) {
    const prev = get().items.find((t) => t.id === id);
    if (!prev) throw new Error("Task not found");
    const optimistic = { ...prev, ...patch } as Task;
    set((s) => ({ items: s.items.map((t) => (t.id === id ? optimistic : t)) }));
    try {
      const updated = await apiUpdate(id, patch);
      set((s) => ({ items: s.items.map((t) => (t.id === id ? updated : t)) }));
      return updated;
    } catch (err) {
      set((s) => ({ items: s.items.map((t) => (t.id === id ? prev : t)) }));
      throw err;
    }
  },

  async remove(id) {
    const prev = get().items;
    set({ items: prev.filter((t) => t.id !== id) });
    try {
      await apiDelete(id);
    } catch (err) {
      set({ items: prev });
      throw err;
    }
  },

  async markDone(id) {
    return get().update(id, {
      status: "done",
      confirmed_at: new Date().toISOString(),
    });
  },

  async markPending(id) {
    return get().update(id, {
      status: "pending",
      confirmed_at: null,
    });
  },

  upsert(row) {
    set((s) => {
      const idx = s.items.findIndex((t) => t.id === row.id);
      if (idx === -1) return { items: [row, ...s.items] };
      const next = s.items.slice();
      next[idx] = row;
      return { items: next };
    });
  },
}));
