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
  const existingSavedForUser = existingSubscription
    ? await isPushSubscriptionSavedForUser(userId, existingSubscription)
    : false;

  const subscription =
    existingSubscription && existingSavedForUser
      ? existingSubscription
      : existingSubscription
        ? await replacePushSubscription(userId, registration, existingSubscription)
        : await subscribeToPush(registration);

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
  if (existing) await disableSavedPushSubscription(userId, existing);

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

async function replacePushSubscription(
  userId: string,
  registration: ServiceWorkerRegistration,
  existing: PushSubscription,
): Promise<PushSubscription> {
  await disableSavedPushSubscription(userId, existing);
  return subscribeToPush(registration);
}

async function isPushSubscriptionSavedForUser(
  userId: string,
  subscription: PushSubscription,
): Promise<boolean> {
  const { data } = await supabase
    .from("push_subscriptions")
    .select("id")
    .eq("user_id", userId)
    .eq("endpoint", subscription.endpoint)
    .eq("enabled", true)
    .maybeSingle();

  return data !== null;
}

async function disableSavedPushSubscription(
  userId: string,
  subscription: PushSubscription,
): Promise<void> {
  await supabase
    .from("push_subscriptions")
    .update({ enabled: false })
    .eq("user_id", userId)
    .eq("endpoint", subscription.endpoint);

  await subscription.unsubscribe();
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

  await persistSubscriptionRow(userId, {
    endpoint: subscription.endpoint,
    p256dh: arrayBufferToBase64Url(key),
    auth: arrayBufferToBase64Url(auth),
    expirationTime: subscription.expirationTime ?? null,
  });
}

/**
 * Save a subscription described by its already-encoded JSON shape (the
 * output of PushSubscription.toJSON()) rather than a live PushSubscription
 * object. Used by the pushsubscriptionchange path (public/sw.js), where the
 * new subscription is minted inside the service worker and can only reach
 * the page via postMessage — see push-subscription-rotation.ts.
 */
export async function saveRawPushSubscription(
  userId: string,
  raw: { endpoint: string; keys: { p256dh: string; auth: string }; expirationTime?: number | null },
): Promise<void> {
  if (!raw?.endpoint || !raw.keys?.p256dh || !raw.keys?.auth) {
    throw new Error("Push subscription payload is missing required fields.");
  }

  await persistSubscriptionRow(userId, {
    endpoint: raw.endpoint,
    p256dh: raw.keys.p256dh,
    auth: raw.keys.auth,
    expirationTime: raw.expirationTime ?? null,
  });
}

async function persistSubscriptionRow(
  userId: string,
  fields: { endpoint: string; p256dh: string; auth: string; expirationTime: number | null },
): Promise<void> {
  const platform = navigator.platform || "unknown";
  const row: PushSubscriptionRow = {
    user_id: userId,
    endpoint: fields.endpoint,
    p256dh: fields.p256dh,
    auth: fields.auth,
    expiration_time: fields.expirationTime ? new Date(fields.expirationTime).toISOString() : null,
    user_agent: navigator.userAgent,
    platform,
    enabled: true,
  };

  const lookup = await supabase
    .from("push_subscriptions")
    .select("id")
    .eq("user_id", userId)
    .eq("endpoint", fields.endpoint)
    .maybeSingle();

  if (lookup.error) throw lookup.error;

  const result = lookup.data
    ? await supabase.from("push_subscriptions").update(row).eq("id", lookup.data.id)
    : await supabase.from("push_subscriptions").insert(row);

  if (result.error) throw result.error;

  // A fresh subscribe() on this same device (browser storage/service-worker
  // eviction, iOS reinstall, key rotation) always mints a new endpoint, so
  // the lookup above can never find and replace the prior row for this
  // device — it silently accumulates instead. Superseding every other
  // still-enabled row for this exact user+platform closes that gap. Disable,
  // not delete — matches the existing disable-first convention used
  // elsewhere in this file, preserving the row for audit history.
  //
  // This is load-bearing, not best-effort: a failed dedupe means the pile-up
  // this exists to fix silently persists, so it must throw rather than warn
  // — the caller must never report "enabled" while cleanup actually failed
  // (Engineering Completeness Review, PR #207 follow-up). Every caller here
  // already has an existing try/catch that reports failure truthfully
  // (SettingsModal.tsx's handleEnable/handleRefresh set status "error"; the
  // pushsubscriptionchange auto-save path logs it — see
  // push-subscription-rotation.ts), so propagating the error needs no new
  // status plumbing.
  //
  // Known, still-open engineering debt (CodeRabbit review, PR #207 — NOT
  // fixed by this change, both genuinely require a migration and are
  // explicitly out of scope here):
  //   1. Not atomic with the write above. Two saves for the same user+
  //      platform completing around each other could each disable the
  //      other's just-written row. A correct fix needs a single
  //      transactional Supabase RPC (upsert + stale-row disable in one
  //      statement) — a separate schema/migration change. Low-probability
  //      in practice (every call site here is either a single explicit
  //      user tap gated by a busy flag, or the one-device-only
  //      pushsubscriptionchange path).
  //   2. `platform` (navigator.platform, e.g. "iPhone") is the closest
  //      existing signal to "this device" but is not a real per-device
  //      identifier — two genuinely different iPhones on the same account
  //      would collide, and the newer save would incorrectly disable the
  //      older device's still-valid subscription. No reliable device ID
  //      exists in the current schema without a migration (a new column).
  //      The failure mode is a recoverable UX inconvenience (re-enable in
  //      Settings), not data loss or a security issue, but it is a real,
  //      reproducible-by-design gap, not merely theoretical.
  await disableOtherEnabledSubscriptions(userId, platform, fields.endpoint);
}

async function disableOtherEnabledSubscriptions(
  userId: string,
  platform: string,
  keepEndpoint: string,
): Promise<void> {
  const result = await supabase
    .from("push_subscriptions")
    .update({ enabled: false })
    .eq("user_id", userId)
    .eq("platform", platform)
    .eq("enabled", true)
    .neq("endpoint", keepEndpoint);

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
