import { create } from "zustand";
import {
  cancelReminderPush,
  rescheduleReminderPush,
  scheduleReminderPush,
} from "../lib/qstash-reminder";
import {
  archiveDoneTasks as apiArchiveDone,
  createTask as apiCreate,
  deleteTask as apiDelete,
  deleteTasks as apiDeleteMany,
  dismissConfirmationNotices as apiDismissConfirmationNotices,
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
  /** Bulk-delete completed history items. Only removes tasks with status "done". */
  removeMany: (ids: string[]) => Promise<void>;
  markDone: (id: string) => Promise<Task>;
  markPending: (id: string) => Promise<Task>;
  archiveDone: (ids: string[]) => Promise<Task[]>;
  /** Dismiss one completed confirmation banner and persist it on the task row. */
  dismissConfirmationNotice: (id: string) => Promise<void>;
  /** Replace a single row in place (used by realtime updates). */
  upsert: (row: Task) => void;
}

export const useTasksStore = create<TasksState>((set, get) => {
  let loadingPromise: Promise<void> | null = null;

  async function fetchAndApply(userId: string) {
    set({ status: "loading", error: null });
    try {
      const items = await apiList();
      if (get().loadedForUserId && get().loadedForUserId !== userId) return;
      set({ status: "ready", items, loadedForUserId: userId, error: null });
    } catch (err) {
      set({
        status: "error",
        error: err instanceof Error ? err.message : "Could not load tasks.",
      });
    }
  }

  return {
    status: "idle",
    items: [],
    error: null,
    loadedForUserId: null,

    reset: () => set({ status: "idle", items: [], error: null, loadedForUserId: null }),

    async loadFor(userId, opts) {
      const { status, loadedForUserId } = get();
      const sameUser = loadedForUserId === userId;
      if (sameUser && status === "ready" && !opts?.force) return;
      if (sameUser && status === "loading") {
        if (!opts?.force) return;
        if (loadingPromise) await loadingPromise;
      }
      const promise = fetchAndApply(userId);
      loadingPromise = promise;
      try {
        await promise;
      } finally {
        if (loadingPromise === promise) loadingPromise = null;
      }
    },

    async add(draft) {
      const row = await apiCreate(draft);
      set((state) => ({ items: [row, ...state.items] }));
      return row;
    },

    push(rows) {
      if (rows.length === 0) return;
      set((state) => ({ items: [...rows, ...state.items] }));
    },

    async update(id, patch) {
      const prev = get().items.find((task) => task.id === id);
      if (!prev) throw new Error("Task not found");
      const optimistic = { ...prev, ...patch } as Task;
      set((state) => ({ items: state.items.map((task) => (task.id === id ? optimistic : task)) }));
      try {
        const updated = await apiUpdate(id, patch);
        set((state) => ({ items: state.items.map((task) => (task.id === id ? updated : task)) }));
        if (
          updated.type === "reminder" &&
          "due_at" in patch &&
          patch.due_at !== prev.due_at &&
          updated.status === "pending"
        ) {
          if (updated.due_at) void rescheduleReminderPush(id, updated.due_at);
          else void cancelReminderPush(id);
        }
        return updated;
      } catch (err) {
        set((state) => ({ items: state.items.map((task) => (task.id === id ? prev : task)) }));
        throw err;
      }
    },

    async remove(id) {
      const task = get().items.find((item) => item.id === id);
      const prev = get().items;
      set({ items: prev.filter((item) => item.id !== id) });
      try {
        await apiDelete(id);
        if (task?.type === "reminder" && task.due_at) void cancelReminderPush(id);
      } catch (err) {
        set({ items: prev });
        throw err;
      }
    },

    async removeMany(ids) {
      const uniqueIds = Array.from(new Set(ids)).filter(Boolean);
      if (uniqueIds.length === 0) return;
      const uniqueIdSet = new Set(uniqueIds);
      const prev = get().items;
      const removedReminderIds = prev
        .filter((task) => uniqueIdSet.has(task.id) && task.type === "reminder" && task.due_at)
        .map((task) => task.id);
      set({ items: prev.filter((task) => !(uniqueIdSet.has(task.id) && task.status === "done")) });
      try {
        await apiDeleteMany(uniqueIds);
        for (const id of removedReminderIds) void cancelReminderPush(id);
      } catch (err) {
        set({ items: prev });
        throw err;
      }
    },

    async markDone(id) {
      const task = get().items.find((item) => item.id === id);
      const result = await get().update(id, {
        status: "done",
        confirmed_at: new Date().toISOString(),
      });
      if (task?.type === "reminder" && task.due_at) void cancelReminderPush(id);
      return result;
    },

    async markPending(id) {
      const result = await get().update(id, { status: "pending", confirmed_at: null });
      if (result.type === "reminder" && result.due_at) {
        void scheduleReminderPush(result.id, result.due_at);
      }
      return result;
    },

    async archiveDone(ids) {
      const uniqueIds = Array.from(new Set(ids)).filter(Boolean);
      if (uniqueIds.length === 0) return [];
      const uniqueIdSet = new Set(uniqueIds);
      const prev = get().items;
      set({ items: prev.filter((task) => !(uniqueIdSet.has(task.id) && task.status === "done")) });
      try {
        return await apiArchiveDone(uniqueIds);
      } catch (err) {
        set({ items: prev });
        throw err;
      }
    },

    async dismissConfirmationNotice(id) {
      const prev = get().items.find((task) => task.id === id);
      if (!prev || prev.dismissed_at) return;

      const optimistic = { ...prev, dismissed_at: new Date().toISOString() };
      set((state) => ({
        items: state.items.map((task) => (task.id === id ? optimistic : task)),
      }));

      try {
        const [updated] = await apiDismissConfirmationNotices([id]);
        if (updated) {
          set((state) => ({
            items: state.items.map((task) => (task.id === id ? updated : task)),
          }));
        }
      } catch (err) {
        set((state) => ({
          items: state.items.map((task) => (task.id === id ? prev : task)),
        }));
        throw err;
      }
    },

    upsert(row) {
      set((state) => {
        const index = state.items.findIndex((task) => task.id === row.id);
        if (index === -1) return { items: [row, ...state.items] };
        const next = state.items.slice();
        next[index] = row;
        return { items: next };
      });
    },
  };
});
