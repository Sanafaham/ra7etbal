/**
 * Bridges public/sw.js's `pushsubscriptionchange` handler back into the
 * authenticated page. A service worker has no access to the page's Supabase
 * session, so it cannot persist the rotated subscription itself — it mints
 * the new subscription (see sw.js, which reuses the original VAPID key via
 * event.oldSubscription.options.applicationServerKey) and posts it to every
 * open client. This module listens for that message and saves it through
 * the existing, already-authenticated push-notifications.ts path.
 *
 * Same shape as tasks-live-refresh.ts's registerTasksLiveRefresh — a plain
 * addEventListener/removeEventListener pair, injectable for testing.
 *
 * If no tab is open when the rotation happens, this message is never
 * delivered — a known, accepted limitation (see the investigation report;
 * push-notifications.ts's own disableOtherEnabledSubscriptions is the
 * primary fix for accumulated dead rows, this is a secondary improvement).
 */
import { saveRawPushSubscription } from "./push-notifications";

export const PUSH_SUBSCRIPTION_CHANGED_MESSAGE_TYPE = "ra7etbal:push-subscription-changed";

interface MinimalServiceWorkerContainer {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

interface RawPushSubscriptionPayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
}

export interface PushSubscriptionRotationOptions {
  serviceWorkerApi: MinimalServiceWorkerContainer | null;
  userId: string;
  /** Injected for testability; defaults to the real saveRawPushSubscription. */
  saveRawPushSubscriptionFn?: (userId: string, raw: RawPushSubscriptionPayload) => Promise<void>;
}

/** Returns a cleanup function that removes the listener. */
export function registerPushSubscriptionRotation({
  serviceWorkerApi,
  userId,
  saveRawPushSubscriptionFn = saveRawPushSubscription,
}: PushSubscriptionRotationOptions): () => void {
  const handleMessage = (event: MessageEvent) => {
    const data = event?.data as
      | { type?: string; subscription?: RawPushSubscriptionPayload }
      | undefined;
    if (data?.type !== PUSH_SUBSCRIPTION_CHANGED_MESSAGE_TYPE) return;
    if (!data.subscription?.endpoint || !data.subscription.keys) return;
    void saveRawPushSubscriptionFn(userId, data.subscription);
  };

  serviceWorkerApi?.addEventListener("message", handleMessage);

  return () => {
    serviceWorkerApi?.removeEventListener("message", handleMessage);
  };
}
