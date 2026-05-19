import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAuth } from "./useAuth";
import { useMessagesStore } from "../stores/messages";
import { useTasksStore } from "../stores/tasks";

/**
 * Loads tasks and messages for the signed-in user. Used by Actions,
 * Follow-ups, and Messages screens so they share the same fetch and the
 * same loading semantics.
 */
export function useTaskList(): {
  userId: string | null;
  tasks: ReturnType<typeof useTasksStore.getState>["items"];
  tasksStatus: ReturnType<typeof useTasksStore.getState>["status"];
  tasksError: string | null;
  messages: ReturnType<typeof useMessagesStore.getState>["items"];
  messagesStatus: ReturnType<typeof useMessagesStore.getState>["status"];
  messagesError: string | null;
  reload: () => Promise<void>;
} {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const {
    items: tasks,
    status: tasksStatus,
    error: tasksError,
    loadedForUserId: tasksLoadedFor,
    loadFor: loadTasks,
  } = useTasksStore(
    useShallow((s) => ({
      items: s.items,
      status: s.status,
      error: s.error,
      loadedForUserId: s.loadedForUserId,
      loadFor: s.loadFor,
    })),
  );

  const {
    items: messages,
    status: messagesStatus,
    error: messagesError,
    loadedForUserId: messagesLoadedFor,
    loadFor: loadMessages,
  } = useMessagesStore(
    useShallow((s) => ({
      items: s.items,
      status: s.status,
      error: s.error,
      loadedForUserId: s.loadedForUserId,
      loadFor: s.loadFor,
    })),
  );

  useEffect(() => {
    if (!userId) return;
    if (tasksLoadedFor !== userId) void loadTasks(userId);
    if (messagesLoadedFor !== userId) void loadMessages(userId);
  }, [userId, tasksLoadedFor, messagesLoadedFor, loadTasks, loadMessages]);

  async function reload(): Promise<void> {
    if (!userId) return;
    await Promise.all([
      loadTasks(userId, { force: true }),
      loadMessages(userId, { force: true }),
    ]);
  }

  return {
    userId,
    tasks,
    tasksStatus,
    tasksError,
    messages,
    messagesStatus,
    messagesError,
    reload,
  };
}
