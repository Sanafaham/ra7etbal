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

const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;

/** localStorage key for this browser storage partition's stable identity. */
const INSTALLATION_ID_STORAGE_KEY = "ra7etbal:push-installation-id";

/**
 * p_installation_id is a `uuid`-typed RPC parameter. A stored value that
 * isn't UUID-shaped (corrupted storage, a stale value from a future format
 * change) would make Postgres reject every save for this browser with
 * invalid_text_representation until storage is cleared by hand — so a
 * malformed value is treated as absent and regenerated instead.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Returns a stable identifier for this exact PWA installation (this exact
 * browser storage partition), or null if it cannot be reliably persisted.
 *
 * Deliberately never falls back to a fresh, unpersisted UUID on storage
 * failure — that would mint a new "installation" on every single save,
 * immediately orphaning the previous save's own row and recreating the
 * exact accumulation problem this identity exists to prevent. null is
 * passed straight through to upsert_push_subscription, which treats it
 * exactly like a legacy pre-migration row: saved and fully functional,
 * just outside the atomic per-installation supersede path.
 *
 * Survives normal reload/login/logout (localStorage is origin-scoped, not
 * session-scoped). Does not survive iOS evicting this PWA's storage, or a
 * full remove-and-reinstall of the home-screen icon — both wipe the whole
 * storage partition, this key included, and a fresh id is generated next
 * time. That is expected, not a bug — see the migration's own comments
 * for why no attempt is made to detect or reconcile that case.
 */
function getOrCreateInstallationId(): string | null {
  try {
    const existing = window.localStorage.getItem(INSTALLATION_ID_STORAGE_KEY);
    if (existing && UUID_PATTERN.test(existing)) return existing;

    const fresh = crypto.randomUUID();
    window.localStorage.setItem(INSTALLATION_ID_STORAGE_KEY, fresh);
    return fresh;
  } catch {
    return null;
  }
}

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
  await savePushSubscription(subscription);
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
  await savePushSubscription(newSub);
  return "enabled";
}

export interface PushSubscriptionDeviceInfo {
  id: string;
  platform: string | null;
  userAgent: string | null;
  installationId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Timestamp of the most recent `show_notification_resolved` delivery
   *  event for this exact subscription, or null if none was ever recorded.
   *  Null does NOT mean the device is dead — it may simply never have had
   *  a reminder/notification sent to it yet. Callers must not present
   *  "no evidence" as "inactive" or "dead". */
  lastConfirmedDeliveredAt: string | null;
}

/**
 * Lists every currently-enabled push subscription for this owner, for the
 * Settings "manage notification devices" view (Push Subscription
 * Installation Management / Orphan Resolution). Read-only, RLS-scoped —
 * never returns another household's rows. Deliberately does not attempt to
 * classify a row as "stale" or "dead": it surfaces the same evidence this
 * codebase's send paths already use (provider-confirmed delivery, from
 * `reminder_delivery_events`), and leaves the disable decision entirely to
 * the owner. No age/inactivity heuristic anywhere in this function.
 */
export async function listPushSubscriptionDevices(
  userId: string,
): Promise<PushSubscriptionDeviceInfo[]> {
  const { data: subs, error } = await supabase
    .from("push_subscriptions")
    .select("id, platform, user_agent, installation_id, created_at, updated_at")
    .eq("user_id", userId)
    .eq("enabled", true)
    .order("updated_at", { ascending: false });
  if (error) throw error;

  const subscriptions = subs ?? [];
  if (subscriptions.length === 0) return [];

  const ids = subscriptions.map((s) => s.id);
  const { data: events, error: eventsError } = await supabase
    .from("reminder_delivery_events")
    .select("subscription_id, event_at")
    .eq("user_id", userId)
    .eq("stage", "show_notification_resolved")
    .in("subscription_id", ids);
  if (eventsError) throw eventsError;

  const lastDeliveredBySubscription = new Map<string, string>();
  for (const event of events ?? []) {
    if (!event.subscription_id || !event.event_at) continue;
    const previous = lastDeliveredBySubscription.get(event.subscription_id);
    if (!previous || event.event_at > previous) {
      lastDeliveredBySubscription.set(event.subscription_id, event.event_at);
    }
  }

  return subscriptions.map((s) => ({
    id: s.id,
    platform: s.platform,
    userAgent: s.user_agent,
    installationId: s.installation_id,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    lastConfirmedDeliveredAt: lastDeliveredBySubscription.get(s.id) ?? null,
  }));
}

/**
 * Owner-initiated removal of one listed device (Push Subscription
 * Installation Management / Orphan Resolution). Reuses the exact same
 * enabled:false update shape as `disableSavedPushSubscription` — never a
 * hard delete, preserving audit history like every other disable path in
 * this file. Scoped by id + user_id so it can never affect another row.
 * Confirms the row was actually affected before reporting success — never
 * a false "removed" on an id that was already gone or never belonged to
 * this owner (this codebase's standing truthful-failure convention).
 */
export async function removePushSubscriptionDevice(
  userId: string,
  subscriptionId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from("push_subscriptions")
    .update({ enabled: false })
    .eq("id", subscriptionId)
    .eq("user_id", userId)
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error("This device could not be found, or was already removed.");
  }
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
  subscription: PushSubscription,
): Promise<void> {
  const key = subscription.getKey("p256dh");
  const auth = subscription.getKey("auth");

  if (!key || !auth) {
    throw new Error("Browser did not provide the full push subscription.");
  }

  await persistSubscriptionRow({
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
  // Kept in the public signature for parity with every other function in
  // this file and for the caller's own documentation — the write itself
  // is scoped server-side by the RPC's own auth.uid(), never by this value.
  _userId: string,
  raw: { endpoint: string; keys: { p256dh: string; auth: string }; expirationTime?: number | null },
): Promise<void> {
  if (!raw?.endpoint || !raw.keys?.p256dh || !raw.keys?.auth) {
    throw new Error("Push subscription payload is missing required fields.");
  }

  await persistSubscriptionRow({
    endpoint: raw.endpoint,
    p256dh: raw.keys.p256dh,
    auth: raw.keys.auth,
    expirationTime: raw.expirationTime ?? null,
  });
}

/**
 * Save a subscription row and atomically supersede any prior subscription
 * for this exact installation, via the upsert_push_subscription RPC
 * (migration 20260810_push_subscription_installation_identity.sql).
 *
 * All correctness properties — same-platform multi-device safety, true
 * concurrency serialization, atomic disable-then-enable with automatic
 * rollback on failure — live entirely in that one database function, not
 * in this client code. This function's only job is to call it and let a
 * failure propagate untouched: never catch it here, never translate it
 * into a false "success" — every caller already has its own truthful
 * failure handling (SettingsModal.tsx's handleEnable/handleRefresh set
 * status "error"; the pushsubscriptionchange auto-save path in
 * push-subscription-rotation.ts logs it).
 *
 * Known, still-open engineering debt, NOT addressed by installation_id
 * (see the migration's own comments and RA7ETBAL_STATE.md's "Push
 * Subscription Installation Management / Orphan Resolution" follow-up):
 * a row orphaned by iOS evicting this PWA's storage, or a home-screen
 * reinstall, has no safe deterministic signal linking it back to its
 * replacement installation. It is deliberately never guessed at or swept
 * — it remains enabled until an existing, genuinely evidence-based
 * mechanism resolves it (provider 404/410, explicit user disable, or this
 * exact installation resubscribing).
 */
async function persistSubscriptionRow(
  fields: { endpoint: string; p256dh: string; auth: string; expirationTime: number | null },
): Promise<void> {
  const { error } = await supabase.rpc("upsert_push_subscription", {
    p_endpoint: fields.endpoint,
    p_p256dh: fields.p256dh,
    p_auth: fields.auth,
    p_expiration_time: fields.expirationTime ? new Date(fields.expirationTime).toISOString() : null,
    p_user_agent: navigator.userAgent,
    p_platform: navigator.platform || "unknown",
    p_installation_id: getOrCreateInstallationId(),
  });

  if (error) throw error;
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
