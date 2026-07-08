/**
 * Server-side task mutations (the public confirmation page, QI review, the
 * escalation cron) all write through the service-role key, completely
 * outside the owner's own browser session. The tasks store only refetches
 * when explicitly told to (see stores/tasks.ts loadFor's `force` guard), so
 * an already-open tab has no way to learn its cached task list is stale.
 *
 * This registers the two lightweight signals that tell an open tab "your
 * data may be stale, refetch": the tab regaining visibility, and a push
 * notification arriving (see public/sw.js, which posts a message to every
 * open client on `push`). Deliberately not a realtime subscription — those
 * two signals cover the actual gap (a tab left open across a server-side
 * update) without adding always-on socket/channel infrastructure.
 */

type MinimalDocument = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;

interface MinimalServiceWorkerContainer {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

export interface TasksLiveRefreshOptions {
  documentApi: MinimalDocument;
  serviceWorkerApi: MinimalServiceWorkerContainer | null;
  refetch: () => void;
}

export const PUSH_RECEIVED_MESSAGE_TYPE = "ra7etbal:push-received";

/** Returns a cleanup function that removes both listeners. */
export function registerTasksLiveRefresh({
  documentApi,
  serviceWorkerApi,
  refetch,
}: TasksLiveRefreshOptions): () => void {
  const handleVisibility = () => {
    if (documentApi.visibilityState === "visible") refetch();
  };
  documentApi.addEventListener("visibilitychange", handleVisibility);

  const handleMessage = (event: MessageEvent) => {
    if ((event?.data as { type?: string } | undefined)?.type === PUSH_RECEIVED_MESSAGE_TYPE) {
      refetch();
    }
  };
  serviceWorkerApi?.addEventListener("message", handleMessage);

  return () => {
    documentApi.removeEventListener("visibilitychange", handleVisibility);
    serviceWorkerApi?.removeEventListener("message", handleMessage);
  };
}
