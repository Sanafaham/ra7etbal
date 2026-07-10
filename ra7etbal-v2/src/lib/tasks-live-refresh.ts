/**
 * Server-side task mutations (the public confirmation page, QI review, the
 * escalation cron) all write through the service-role key, completely
 * outside the owner's own browser session. The tasks store only refetches
 * when explicitly told to (see stores/tasks.ts loadFor's `force` guard), so
 * an already-open tab has no way to learn its cached task list is stale.
 *
 * Primary signals: the tab regaining visibility, and a push notification
 * arriving (see public/sw.js, which posts a message to every open client on
 * `push`). Both remain the primary mechanisms.
 *
 * Safety net: iOS PWA push delivery + postMessage-to-open-clients is
 * documented-flaky (a push can show its notification banner while the
 * postMessage to an already-open, backgrounded tab silently never arrives).
 * A backgrounded/suspended-then-resumed tab is also not guaranteed to fire
 * `visibilitychange` reliably in every iOS PWA scenario. While the tab is
 * visible, a low-frequency poll (default 60s) is layered on top of the two
 * primary signals as defense-in-depth — purely a fallback, not a
 * replacement. Deliberately still not a realtime subscription; this keeps
 * the always-on cost to one lightweight refetch per minute, only while the
 * tab is actually visible.
 */

type MinimalDocument = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;

interface MinimalServiceWorkerContainer {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

export interface TasksLiveRefreshOptions {
  documentApi: MinimalDocument;
  serviceWorkerApi: MinimalServiceWorkerContainer | null;
  /** Same task refresh path used everywhere else (stores/tasks.ts loadFor) — no new fetching implementation. */
  refetch: () => unknown;
  /** Safety-net poll interval while visible, in ms. Defaults to 60s; overridable for tests. */
  pollIntervalMs?: number;
}

export const PUSH_RECEIVED_MESSAGE_TYPE = "ra7etbal:push-received";
export const DEFAULT_POLL_INTERVAL_MS = 60_000;

/** Returns a cleanup function that removes both listeners and stops the poll timer. */
export function registerTasksLiveRefresh({
  documentApi,
  serviceWorkerApi,
  refetch,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: TasksLiveRefreshOptions): () => void {
  let inFlight = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  // Every trigger (poll, visibility, push) goes through this so overlapping
  // refresh requests can never fire concurrently — a slow in-flight refetch
  // simply causes the next trigger to skip, not queue or stack.
  const safeRefetch = () => {
    if (inFlight) return;
    inFlight = true;
    Promise.resolve(refetch()).finally(() => {
      inFlight = false;
    });
  };

  const startPolling = () => {
    if (pollTimer) return;
    pollTimer = setInterval(safeRefetch, pollIntervalMs);
  };
  const stopPolling = () => {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  };

  const handleVisibility = () => {
    if (documentApi.visibilityState === "visible") {
      safeRefetch();
      startPolling();
    } else {
      stopPolling();
    }
  };
  documentApi.addEventListener("visibilitychange", handleVisibility);

  const handleMessage = (event: MessageEvent) => {
    if ((event?.data as { type?: string } | undefined)?.type === PUSH_RECEIVED_MESSAGE_TYPE) {
      safeRefetch();
    }
  };
  serviceWorkerApi?.addEventListener("message", handleMessage);

  if (documentApi.visibilityState === "visible") startPolling();

  return () => {
    documentApi.removeEventListener("visibilitychange", handleVisibility);
    serviceWorkerApi?.removeEventListener("message", handleMessage);
    stopPolling();
  };
}
