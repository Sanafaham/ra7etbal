import { supabase } from "./supabase";

export type PushNotificationStatus =
  | "idle"
  | "enabled"
  | "denied"
  | "unsupported"
  | "error";

export interface PushSupportResult {
  supported: boolean;
  reason: "supported" | "unsupported";
}

interface PushSubscriptionRow {
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expiration_time: string | null;
  user_agent: string;
  platform: string;
  enabled: boolean;
}

const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;

export function checkPushSupport(): PushSupportResult {
  const flags = getPushSupportFlags();

  if (
    !flags.hasWindow ||
    !flags.isSecureContext ||
    !flags.hasNotification ||
    !flags.hasServiceWorker ||
    !flags.hasPushManager
  ) {
    return { supported: false, reason: "unsupported" };
  }

  return { supported: true, reason: "supported" };
}

export async function getExistingPushSubscription(): Promise<PushSubscription | null> {
  const support = checkPushSupport();
  if (!support.supported) return null;

  const registration = await getOrRegisterServiceWorker();
  return registration.pushManager.getSubscription();
}

/** Returns true only if the browser has a push subscription AND it is saved
 *  in Supabase for this specific userId. Used by Settings to show real status. */
export async function isSubscriptionSavedForUser(userId: string): Promise<boolean> {
  const browserSub = await getExistingPushSubscription();
  if (!browserSub) return false;

  const { data } = await supabase
    .from("push_subscriptions")
    .select("id")
    .eq("user_id", userId)
    .eq("endpoint", browserSub.endpoint)
    .eq("enabled", true)
    .maybeSingle();

  return data !== null;
}

export async function enableReminderNotifications(userId: string): Promise<PushNotificationStatus> {
  const support = checkPushSupport();

  if (!support.supported || !vapidPublicKey) {
    return "unsupported";
  }

  if (Notification.permission === "denied") {
    return "denied";
  }

  const permission =
    Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();

  if (permission === "denied") {
    return "denied";
  }
  if (permission !== "granted") {
    return "error";
  }

  const registration = await getOrRegisterServiceWorker();
  const existingSubscription = await registration.pushManager.getSubscription();
  const subscription =
    existingSubscription ??
    (await subscribeToPush(registration));

  // Always save — this inserts if missing for this userId, updates if present.
  // Covers the case where the browser subscription exists but was never saved
  // for the current user_id (e.g. account switch, fresh install, DB wipe).
  await savePushSubscription(userId, subscription);
  return "enabled";
}

/**
 * Force-refresh the push subscription: unsubscribe the existing browser token,
 * request a brand-new one from APNs/FCM, and upsert it in push_subscriptions.
 * This is the fix for stale Apple Web Push endpoints that silently drop messages.
 * updated_at is refreshed via the upsert so cron staleness checks work correctly.
 */
export async function refreshPushSubscription(userId: string): Promise<PushNotificationStatus> {
  const support = checkPushSupport();
  if (!support.supported || !vapidPublicKey) return "unsupported";
  if (Notification.permission !== "granted") return "idle";

  const registration = await getOrRegisterServiceWorker();

  // Unsubscribe existing token so Apple/Google issues a fresh one.
  const existing = await registration.pushManager.getSubscription();
  if (existing) await existing.unsubscribe();

  const newSub = await subscribeToPush(registration);
  await savePushSubscription(userId, newSub);
  return "enabled";
}

/**
 * Disable push notifications: mark the current subscription disabled in DB
 * and unsubscribe the browser-side token. Returns "idle" on success.
 */
export async function disableReminderNotifications(userId: string): Promise<PushNotificationStatus> {
  const support = checkPushSupport();
  if (!support.supported) return "idle";

  const registration = await getOrRegisterServiceWorker();
  const existing = await registration.pushManager.getSubscription();

  if (existing) {
    // Mark disabled in DB before unsubscribing so the row persists for auditing.
    await supabase
      .from("push_subscriptions")
      .update({ enabled: false })
      .eq("user_id", userId)
      .eq("endpoint", existing.endpoint);

    await existing.unsubscribe();
  }

  return "idle";
}

async function getOrRegisterServiceWorker(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing?.active) return existing;
  if (existing) {
    return navigator.serviceWorker.ready;
  }

  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  return navigator.serviceWorker.ready;
}

async function subscribeToPush(
  registration: ServiceWorkerRegistration,
): Promise<PushSubscription> {
  const applicationServerKey = urlBase64ToArrayBuffer(vapidPublicKey);
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  });
}

async function savePushSubscription(
  userId: string,
  subscription: PushSubscription,
): Promise<void> {
  const key = subscription.getKey("p256dh");
  const auth = subscription.getKey("auth");

  if (!key || !auth) {
    throw new Error("Browser did not provide the full push subscription.");
  }

  const row: PushSubscriptionRow = {
    user_id: userId,
    endpoint: subscription.endpoint,
    p256dh: arrayBufferToBase64Url(key),
    auth: arrayBufferToBase64Url(auth),
    expiration_time: subscription.expirationTime
      ? new Date(subscription.expirationTime).toISOString()
      : null,
    user_agent: navigator.userAgent,
    platform: navigator.platform || "unknown",
    enabled: true,
  };

  const lookup = await supabase
    .from("push_subscriptions")
    .select("id")
    .eq("user_id", userId)
    .eq("endpoint", subscription.endpoint)
    .maybeSingle();

  if (lookup.error) throw lookup.error;

  const result = lookup.data
    ? await supabase.from("push_subscriptions").update(row).eq("id", lookup.data.id)
    : await supabase.from("push_subscriptions").insert(row);

  if (result.error) throw result.error;
}

function urlBase64ToArrayBuffer(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputBuffer = new ArrayBuffer(rawData.length);
  const outputArray = new Uint8Array(outputBuffer);

  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputBuffer;
}

function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";

  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }

  return window
    .btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function getPushSupportFlags() {
  const hasWindow = typeof window !== "undefined";
  const hasNavigator = typeof navigator !== "undefined";

  return {
    hasWindow,
    isSecureContext: hasWindow ? window.isSecureContext : false,
    hasNotification: hasWindow && "Notification" in window,
    hasNavigator,
    hasServiceWorker: hasNavigator && "serviceWorker" in navigator,
    hasPushManager: hasWindow && "PushManager" in window,
  };
}
