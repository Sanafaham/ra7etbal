import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAuth } from "./useAuth";
import { useMessagesStore } from "../stores/messages";
import { useTasksStore } from "../stores/tasks";

/**
 * Loads tasks and messages for the signed-in user. Used by Actions,
 * Follow-ups, and Messages screens so they share the same fetch and the
 * same loading semantics.
 *
 * Sync policy: every mount triggers a force-refresh so the host always
 * sees the latest data after the recipient hits the public confirmation
 * link. The Refresh button uses the same path. In dev StrictMode this
 * may fire twice on the first mount — production behavior is one fetch
 * per visit, which is cheap.
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
    loadFor: loadTasks,
  } = useTasksStore(
    useShallow((s) => ({
      items: s.items,
      status: s.status,
      error: s.error,
      loadFor: s.loadFor,
    })),
  );

  const {
    items: messages,
    status: messagesStatus,
    error: messagesError,
    loadFor: loadMessages,
  } = useMessagesStore(
    useShallow((s) => ({
      items: s.items,
      status: s.status,
      error: s.error,
      loadFor: s.loadFor,
    })),
  );

  // Force-refresh on every mount. Cached items remain visible during the
  // brief loading state (loadFor doesn't clear `items` while fetching), so
  // there's no flicker — the list just updates in place when the fresh
  // data arrives.
  const firedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!userId) return;
    if (firedRef.current === userId) return;
    firedRef.current = userId;
    void loadTasks(userId, { force: true });
    void loadMessages(userId, { force: true });
  }, [userId, loadTasks, loadMessages]);

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
